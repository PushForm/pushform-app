// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockStatus, messageStatus, NEXT_STEP, QUIET_MS, resumeStatus, SAYING, SAYINGS, statusSender, type StatusLine } from './status.ts';

/** A repeatable stand-in for Math.random. */
const seeded = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const FAILURE = /fail|reject|refus|error|didn.t apply|wrong|problem|fix/i;

describe('status line texts', () => {
  it('opens a new message by reading the request, with or without pictures', () => {
    expect(messageStatus()).toEqual({ phase: 'reading', text: 'Reading your request…' });
  });
  it('opens a resumed turn from how the last step ended, and a refused change only as a saying', () => {
    const apply = (isError: boolean) => ({ name: 'model_apply_operations', isError });
    expect(resumeStatus([apply(false)])).toEqual({ phase: 'planning', text: 'Change applied. Working out the next step…' });
    expect(resumeStatus([apply(true)])).toBe(SAYING);
    expect(resumeStatus([apply(false), apply(true)])).toBe(SAYING);
    expect(resumeStatus([apply(true), { name: 'model_render', isError: false }])).toBe(SAYING);
    expect(resumeStatus([{ name: 'model_render', isError: false }])).toEqual({ phase: 'reviewing', text: 'Looking over the review pictures…' });
    expect(resumeStatus([{ name: 'model_render', isError: true }])).toEqual(NEXT_STEP);
    expect(resumeStatus([{ name: 'model_get_document', isError: false }, { name: 'model_query', isError: false }])).toEqual({ phase: 'planning', text: 'Read the model. Working out the next step…' });
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
  it('keeps the sayings short and neutral: no failure, progress, time or specific activity', () => {
    expect(SAYINGS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SAYINGS).size).toBe(SAYINGS.length);
    for (const saying of SAYINGS) {
      expect(saying.split(/\s+/).length).toBeLessThan(8);
      expect(saying).not.toMatch(FAILURE);
      expect(saying).not.toMatch(/almost|nearly|done|finish|soon|minute|second|check|measur|cutting|applied/i);
    }
  });
});

describe('statusSender', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const reading: StatusLine = { phase: 'reading', text: 'Reading your request…' };

  it('sends a fixed line only when its text changes', () => {
    const sent: StatusLine[] = [];
    const status = statusSender(line => sent.push(line));
    status.send(reading); status.send(reading); status.send(NEXT_STEP);
    expect(sent.map(l => l.text)).toEqual(['Reading your request…', 'Working out the next step…']);
    expect(status.last()).toBe('Working out the next step…');
    status.stop();
  });
  it('fills long silences with at most two sayings from the bucket, restarting the clock on anything else sent, and sends nothing after stop', () => {
    const sent: StatusLine[] = [];
    const status = statusSender(line => sent.push(line), { random: seeded(7) });
    status.send(reading);
    vi.advanceTimersByTime(QUIET_MS[0] - 1);
    status.quiet();
    vi.advanceTimersByTime(QUIET_MS[0] - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)!.phase).toBe('reading');
    expect(SAYINGS).toContain(sent.at(-1)!.text);
    vi.advanceTimersByTime(QUIET_MS[1]);
    expect(SAYINGS).toContain(sent.at(-1)!.text);
    expect(sent[2]!.text).not.toBe(sent[1]!.text);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(3);
    status.send({ phase: 'writing', text: 'Writing the change…' });
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(4);
    const after = statusSender(line => sent.push(line));
    after.send(reading); after.stop(); after.send(SAYING); after.quiet();
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(5);
  });
  it('never sends the same saying twice in a row, within a request or across the requests of a turn', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seeded(seed);
      let previous: string | null = null;
      for (let request = 0; request < 4; request += 1) {
        const sent: StatusLine[] = [];
        const status = statusSender(line => sent.push(line), { random, previous });
        status.send(SAYING);
        vi.advanceTimersByTime(QUIET_MS[0] + QUIET_MS[1]);
        status.stop();
        const texts = [previous, ...sent.map(l => l.text)].filter((t): t is string => t !== null);
        for (let i = 1; i < texts.length; i += 1) expect(texts[i]).not.toBe(texts[i - 1]);
        for (const line of sent) { expect(SAYINGS).toContain(line.text); expect(line.text).not.toMatch(FAILURE); }
        previous = status.last();
      }
    }
  });
  it('picks with the random function it is given, so the same seed gives the same lines', () => {
    const run = () => { const sent: string[] = []; const s = statusSender(l => sent.push(l.text), { random: seeded(42) }); s.send(SAYING); vi.advanceTimersByTime(60_000); s.stop(); return sent; };
    expect(run()).toEqual(run());
    const first = statusSender(() => {}, { random: () => 0 }); first.send(SAYING);
    expect(first.last()).toBe(SAYINGS[0]);
    const avoid = statusSender(() => {}, { random: () => 0, previous: SAYINGS[0] }); avoid.send(SAYING);
    expect(avoid.last()).toBe(SAYINGS[1]);
    const top = statusSender(() => {}, { random: () => 0.999999 }); top.send(SAYING);
    expect(top.last()).toBe(SAYINGS.at(-1));
    first.stop(); avoid.stop(); top.stop();
  });
});
