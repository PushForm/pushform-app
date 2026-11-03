// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockStatus, messageStatus, NEXT_STEP, QUIET_MS, resumeStatus, statusSender, STILL_WORKING, type StatusLine } from './status.ts';

describe('status line texts', () => {
  it('opens a new message by reading the request, or the pictures when it has any', () => {
    expect(messageStatus(false)).toEqual({ phase: 'reading', text: 'Reading your request…' });
    expect(messageStatus(true)).toEqual({ phase: 'reading', text: 'Looking at your pictures…' });
  });
  it('opens a resumed turn from how the last step ended, and never says a refused change applied', () => {
    const apply = (isError: boolean) => ({ name: 'model_apply_operations', isError });
    expect(resumeStatus([apply(false)]).text).toBe('Change applied. Working out the next step…');
    expect(resumeStatus([apply(true)])).toEqual({ phase: 'fixing', text: 'That change didn’t apply. Working out a fix…' });
    expect(resumeStatus([apply(false), apply(true)]).text).not.toContain('applied.');
    expect(resumeStatus([{ name: 'model_render', isError: false }])).toEqual({ phase: 'reviewing', text: 'Looking over the review pictures…' });
    expect(resumeStatus([{ name: 'model_render', isError: true }])).toEqual(NEXT_STEP);
    expect(resumeStatus([{ name: 'model_get_document', isError: false }, { name: 'model_query', isError: false }]).text).toBe('Read the model. Working out the next step…');
    expect(resumeStatus([{ name: 'model_query', isError: true }])).toEqual(NEXT_STEP);
    expect(resumeStatus([{ name: 'model_view', isError: false }])).toEqual(NEXT_STEP);
    expect(resumeStatus([])).toEqual(NEXT_STEP);
  });
  it('says the change is being written once the model starts a batch, and nothing for other blocks', () => {
    expect(blockStatus({ kind: 'block', block: 'tool_use', tool: 'model_apply_operations' })).toEqual({ phase: 'writing', text: 'Writing the change…' });
    expect(blockStatus({ kind: 'block', block: 'tool_use', tool: 'model_query' })).toBeNull();
    expect(blockStatus({ kind: 'block', block: 'thinking' })).toBeNull();
    expect(blockStatus({ kind: 'block', block: 'text' })).toBeNull();
  });
});

describe('statusSender', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const reading: StatusLine = { phase: 'reading', text: 'Reading your request…' };

  it('sends a line only when its text changes', () => {
    const sent: StatusLine[] = [];
    const status = statusSender(line => sent.push(line));
    status.send(reading); status.send(reading); status.send(NEXT_STEP);
    expect(sent.map(l => l.text)).toEqual(['Reading your request…', 'Working out the next step…']);
    status.stop();
  });
  it('adds at most two long-silence lines, restarts the clock on anything else sent, and sends nothing after stop', () => {
    const sent: StatusLine[] = [];
    const status = statusSender(line => sent.push(line));
    status.send(reading);
    vi.advanceTimersByTime(QUIET_MS[0] - 1);
    status.quiet();
    vi.advanceTimersByTime(QUIET_MS[0] - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ phase: 'reading', text: STILL_WORKING[0] });
    vi.advanceTimersByTime(QUIET_MS[1]);
    expect(sent.at(-1)!.text).toBe(STILL_WORKING[1]);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(3);
    status.send({ phase: 'writing', text: 'Writing the change…' });
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(4);
    const after = statusSender(line => sent.push(line));
    after.send(reading); after.stop(); after.send(NEXT_STEP); after.quiet();
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(5);
  });
});
