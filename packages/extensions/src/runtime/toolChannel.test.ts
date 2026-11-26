// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolInput, ToolSource, ToolStamp, ToolStopReason, ToolView } from '@pushform/extension-protocol';
import { ToolInputChannel } from './toolChannel';

const channels: ToolInputChannel[] = [];
afterEach(() => { for (const channel of channels.splice(0)) channel.end(); vi.useRealTimers(); });
function setup(deadline = 10000) {
  let stamp: ToolStamp = { revision: 1, contextVersion: 2, cameraVersion: 3, context: [4] };
  const inputs: ToolInput[] = [], views: (ToolView | null)[] = [], stops: ToolStopReason[] = [];
  const channel = new ToolInputChannel({ session: 'owned-tool', stamp: () => stamp, publish: input => inputs.push(input), render: view => views.push(view), ended: reason => stops.push(reason), acknowledgementMs: deadline }); channels.push(channel);
  return { channel, inputs, views, stops, stamp: (patch: Partial<ToolStamp>) => { stamp = { ...stamp, ...patch }; }, ack: () => { const last = inputs.at(-1) ?? channel.activation; channel.ack(last.session, last.sequence); } };
}
const key = (value: string): ToolSource => ({ kind: 'keyDown', data: { key: value, code: value, repeat: false, modifiers: { shift: false, ctrl: false, alt: false, meta: false } } });
const move = (x: number): ToolSource => ({ kind: 'pointerMove', data: { screen: [0.5, 0.5], ray: { origin: [0, 0, 1], direction: [0, 0, -1] }, button: -1, buttons: 0, modifiers: { shift: false, ctrl: false, alt: false, meta: false }, point: [x, 0, 0], snap: { kind: 'free', point: [x, 0, 0] }, hit: null, camera: { eye: [0, 0, 1], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', fovDeg: 45, viewHeight: 1 } } });
const present = (sequence: number, instructor: string) => ({ session: 'owned-tool', sequence, view: { instructor } });

describe('active tool input channel', () => {
  it('coalesces camera/model resyncs while a worker waits without dropping discrete transitions', () => {
    const s = setup();
    for (let i = 0; i < 1000; i++) { s.stamp({ cameraVersion: i }); s.channel.input({ kind: 'resync', data: {} }); }
    s.channel.input(key('Enter'));
    for (let i = 1000; i < 2000; i++) { s.stamp({ cameraVersion: i }); s.channel.input({ kind: 'resync', data: {} }); }
    expect(s.channel.buffered).toBe(3);
    for (let i = 0; i < 4; i++) s.ack();
    expect(s.inputs.map(input => [input.kind, input.cameraVersion])).toEqual([['resync', 999], ['keyDown', 999], ['resync', 1999]]);
    expect(s.stops).toEqual([]);
  });
  it('coalesces moves between ordered discrete inputs and copies their captured values', () => {
    const s = setup();
    for (let x = 0; x < 1000; x++) s.channel.input(move(x));
    s.channel.input(key('Enter'));
    s.channel.input(move(1000)); s.channel.input(move(1001)); s.channel.input(key('Shift'));
    expect(s.channel.buffered).toBe(4); expect(s.inputs).toEqual([]);
    for (let n = 0; n < 5; n++) s.ack();
    expect(s.inputs.map(input => input.kind)).toEqual(['pointerMove', 'keyDown', 'pointerMove', 'keyDown']);
    expect(s.inputs.filter(input => input.kind === 'pointerMove').map(input => 'point' in input.data ? input.data.point : null)).toEqual([[999, 0, 0], [1001, 0, 0]]);
    expect(s.inputs.map(input => input.sequence)).toEqual([1, 2, 3, 4]);
    const input = move(3); s.channel.input(input); if ('point' in input.data) input.data.point[0] = 88;
    const captured = s.inputs.at(-1)!.data;
    expect('point' in captured && captured.point).toEqual([3, 0, 0]);
  });
  it('refuses foreign, duplicated and out-of-order responses without draining input or changing a preview', () => {
    const s = setup(); s.channel.present(present(0, 'Initial'));
    s.channel.input(key('Enter'));
    expect(() => s.channel.ack('another-tool', 1)).toThrow(/another owner/);
    expect(() => s.channel.ack('owned-tool', 0)).toThrow(/no longer/);
    expect(() => s.channel.present(present(2, 'Future'))).toThrow(/no longer/);
    expect(s.views.at(-1)?.instructor).toBe('Initial');
    s.channel.present(present(1, 'Committed preview'));
    expect(() => s.channel.present(present(0, 'Old preview'))).toThrow(/no longer/);
    expect(s.views.at(-1)?.instructor).toBe('Committed preview');
  });
  it('rejects an invalid presentation atomically and permits a corrected response for the same input', () => {
    const s = setup(); s.channel.present(present(0, 'Initial')); s.channel.input(key('Enter'));
    expect(() => s.channel.present({ ...present(1, 'Bad'), view: { instructor: 'Bad', cursor: 'url(https://example.com/x)' } })).toThrow(/invalid/);
    expect(s.views.at(-1)?.instructor).toBe('Initial'); s.channel.present(present(1, 'Corrected')); expect(s.views.at(-1)?.instructor).toBe('Corrected');
  });
  it.each(['revision', 'contextVersion', 'cameraVersion'] as const)('refuses stale %s previews but permits explicit acknowledgement and resync', field => {
    const s = setup(); s.channel.present(present(0, 'Initial')); s.channel.input(key('Enter')); s.stamp({ [field]: 8 }); s.channel.input({ kind: 'resync', data: {} });
    expect(() => s.channel.present(present(1, 'Stale'))).toThrow(/viewport changed/); expect(s.views.at(-1)?.instructor).toBe('Initial');
    s.ack(); expect(s.inputs.at(-1)?.kind).toBe('resync'); expect(s.inputs.at(-1)?.[field]).toBe(8); s.channel.present(present(2, 'Fresh')); expect(s.views.at(-1)?.instructor).toBe('Fresh');
  });
  it('ends a flood instead of dropping a click while keeping the tool active', () => {
    const s = setup(); for (let n = 0; n < 65; n++) s.channel.input(key('Enter'));
    expect(s.channel.active).toBe(false); expect(s.stops).toEqual(['limit.exceeded']); expect(s.channel.buffered).toBe(0); expect(s.views).toEqual([null]);
  });
  it('clears the preview independently at the acknowledgement deadline and refuses late callbacks', () => {
    vi.useFakeTimers(); const s = setup(20); s.channel.present(present(0, 'Visible')); s.channel.input(key('Enter'));
    vi.advanceTimersByTime(20); expect(s.stops).toEqual(['unresponsive']); expect(s.views.at(-1)).toBeNull();
    expect(() => s.channel.present(present(1, 'Late'))).toThrow(/ended/); expect(s.channel.input(key('Enter'))).toBe(false);
    s.channel.end('cancelled'); expect(s.stops).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('explicit cancellation clears queued input immediately without waiting for an acknowledgement', () => {
    const s = setup(); s.channel.present(present(0, 'Visible')); s.channel.input(key('Enter')); s.channel.input(move(1)); s.channel.end('cancelled');
    expect(s.stops).toEqual(['cancelled']); expect(s.channel.buffered).toBe(0); expect(s.views.at(-1)).toBeNull(); expect(() => s.channel.ack('owned-tool', 1)).toThrow(/ended/);
  });
});
