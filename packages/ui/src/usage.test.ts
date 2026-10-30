// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { Emitter } from '@pushform/core';
import { usageEventJson, type UsageEvent, type UsageSink } from '@pushform/cloud';
import { errorCategory, USAGE_SEND_MS, UsageRecorder, useProductUsage, type UsageClock } from './usage';
import type { DocumentSession } from './session';

/** A clock whose timers run only when the test advances it. */
function manualClock(start = Date.UTC(2026, 9, 27, 12, 0, 10)) {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: UsageClock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id as number); },
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { clock, advance, pending: () => timers.size };
}
function sink(failures = 0) {
  const calls: UsageEvent[][] = [];
  let left = failures;
  const value: UsageSink = { async send(events) { calls.push([...events]); if (left-- > 0) throw new Error('offline'); } };
  return { sink: value, calls };
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('UsageRecorder', () => {
  it('batches events and sends them at most every 30 seconds, in calls of at most 50', async () => {
    const { clock, advance } = manualClock();
    const out = sink();
    const usage = new UsageRecorder(out.sink, { version: '0.9.1', build: 'abc123' }, clock);
    usage.record('session_start');
    usage.record('home_view');
    await advance(USAGE_SEND_MS - 1);
    expect(out.calls).toEqual([]);
    await advance(1);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.map(e => e.kind)).toEqual(['session_start', 'home_view']);
    expect(out.calls[0]![0]).toMatchObject({ appVersion: '0.9.1', appBuild: 'abc123', at: '2026-10-27T12:00:10.000Z' });
    for (let i = 0; i < 120; i++) usage.record('home_view');
    await advance(USAGE_SEND_MS);
    expect(out.calls.slice(1).map(c => c.length)).toEqual([50, 50, 20]);
  });
  it('sends at once on page hide or when the page becomes hidden', async () => {
    const { clock } = manualClock();
    const out = sink();
    const usage = new UsageRecorder(out.sink, {}, clock);
    const target = new EventTarget() as EventTarget & Window;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const detach = usage.attach(Object.assign(target, { document: doc }));
    usage.record('document_open', { documentType: 'model' });
    target.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(out.calls.map(c => c.map(e => e.kind))).toEqual([['document_open']]);
    usage.record('home_view');
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(out.calls).toHaveLength(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(out.calls).toHaveLength(2);
    detach();
    usage.record('home_view');
    target.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(out.calls).toHaveLength(2);
  });
  it('retries a failed send once with the next send and then drops it', async () => {
    const { clock, advance } = manualClock();
    const out = sink(2);
    const usage = new UsageRecorder(out.sink, {}, clock);
    usage.record('session_start');
    await usage.flush();
    expect(out.calls).toHaveLength(1);
    await advance(USAGE_SEND_MS);
    expect(out.calls.map(c => c.map(e => e.kind))).toEqual([['session_start'], ['session_start']]);
    usage.record('home_view');
    await usage.flush();
    expect(out.calls.map(c => c.map(e => e.kind))).toEqual([['session_start'], ['session_start'], ['home_view']]);
    const once = sink(1);
    const second = new UsageRecorder(once.sink, {}, clock);
    second.record('home_view');
    await second.flush();
    await second.flush();
    await second.flush();
    expect(once.calls).toHaveLength(2);
  });
  it('counts tool use and errors per minute, skips ids the table refuses, and never carries a message or document name', async () => {
    const { clock, advance } = manualClock();
    const out = sink();
    const usage = new UsageRecorder(out.sink, {}, clock);
    usage.tool('tool.line', 'model'); usage.tool('tool.line', 'model'); usage.tool('tool.pushpull', 'model');
    usage.tool('House plan.pf'); usage.tool('');
    usage.error(errorCategory(new TypeError('cannot read secret.pf')));
    usage.error(errorCategory(new TypeError('again')));
    await advance(60_000);
    usage.tool('tool.line', 'model');
    await usage.flush();
    const sent = out.calls.flat();
    expect(sent.map(e => [e.kind, e.tool ?? e.category, e.count ?? 1, e.at])).toEqual([
      ['tool_use', 'tool.line', 2, '2026-10-27T12:00:00.000Z'], ['tool_use', 'tool.pushpull', 1, '2026-10-27T12:00:00.000Z'],
      ['error', 'TypeError', 2, '2026-10-27T12:00:00.000Z'], ['tool_use', 'tool.line', 1, '2026-10-27T12:01:00.000Z']]);
    expect(JSON.stringify(sent.map(usageEventJson))).not.toMatch(/secret|again|House/);
    expect(usageEventJson(sent[0]!)).toEqual({ kind: 'tool_use', tool: 'tool.line', count: 2, document_type: 'model', client_at: '2026-10-27T12:00:00.000Z' });
  });
  it('names errors by class only', () => {
    expect(errorCategory(new RangeError('x'))).toBe('RangeError');
    expect(errorCategory(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe('QuotaExceededError');
    expect(errorCategory(Object.assign(new Error('x'), { name: 'Could not open House.pf' }))).toBe('UnknownError');
    expect(errorCategory('a string')).toBe('UnknownError');
  });
  it('records uncaught errors and unhandled rejections by category', async () => {
    const { clock } = manualClock();
    const out = sink();
    const usage = new UsageRecorder(out.sink, {}, clock);
    const target = new EventTarget() as EventTarget & Window;
    usage.attach(target);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new SyntaxError('bad House.pf') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'no' }));
    await usage.flush();
    expect(out.calls.flat().map(e => e.category)).toEqual(['SyntaxError', 'UnhandledRejection']);
  });
});

/** Just enough of DocumentSession for the hook: tabs, dirtiness, the active registry and change notifications. */
function fakeSession() {
  const listeners = new Set<() => void>();
  const events = new Emitter<{ executed: { id: string; params: unknown; result: unknown } }>();
  const state = {
    tabs: [{ id: 't1', type: 'model', name: 'Untitled.pf', identity: undefined }] as { id: string; type: 'model' | 'layout'; name: string; identity: string | undefined }[],
    dirty: new Set<string>(),
  };
  const session = {
    get tabs() { return state.tabs; },
    get active() { return state.tabs.at(-1)!; },
    get activeCommands() { return { events }; },
    isDirty: (tab: { id: string }) => state.dirty.has(tab.id),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const emit = (): void => { for (const fn of listeners) fn(); };
  return { session: session as unknown as DocumentSession, state, emit, events };
}

describe('useProductUsage', () => {
  it('records session, Home, document and command events, and skips the untouched starting document', async () => {
    const out = sink();
    const fake = fakeSession();
    const { result, rerender } = renderHook((props: { locked: boolean; home: boolean; helpOpen: boolean }) =>
      useProductUsage(out.sink, { version: '1.0.0', commit: 'c0ffee', builtAt: 't' } as never, fake.session, { ...props, activeId: fake.session.active.id }),
    { initialProps: { locked: true, home: true, helpOpen: false } });
    rerender({ locked: false, home: true, helpOpen: false });
    rerender({ locked: false, home: false, helpOpen: true });
    act(() => {
      fake.state.tabs = [...fake.state.tabs, { id: 't2', type: 'layout', name: 'Site plan.pfl', identity: 'cloud:1' }, { id: 't3', type: 'model', name: 'Untitled 2.pf', identity: undefined }];
      fake.emit();
    });
    fake.events.emit('executed', { id: 'tool.line', params: {}, result: null });
    act(() => { fake.state.tabs = fake.state.tabs.filter(t => t.id !== 't2'); fake.emit(); });
    act(() => { fake.state.dirty.add('t1'); fake.emit(); });
    result.current!.record('help_message');
    await act(async () => { await result.current!.flush(); });
    const sent = out.calls.flat();
    expect(sent.map(e => [e.kind, e.documentType ?? null])).toEqual([
      ['session_start', null], ['home_view', null], ['help_open', null], ['document_open', 'layout'], ['document_create', 'model'],
      ['document_close', 'layout'], ['document_create', 'model'], ['help_message', null], ['tool_use', 'model'],
    ]);
    expect(sent.find(e => e.kind === 'document_close')!.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(sent[0]).toMatchObject({ appVersion: '1.0.0', appBuild: 'c0ffee' });
    expect(JSON.stringify(sent)).not.toMatch(/Site plan|Untitled|cloud:1/);
  });
  it('records nothing without a sink', () => {
    const fake = fakeSession();
    const { result } = renderHook(() => useProductUsage(undefined, undefined, fake.session, { locked: false, home: true, helpOpen: false, activeId: 't1' }));
    expect(result.current).toBeNull();
  });
});
