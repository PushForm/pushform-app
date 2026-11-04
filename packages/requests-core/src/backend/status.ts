// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MODEL_TOOLS } from '@pushform/extension-protocol';
import type { RoundPhase } from '../agents/client.ts';

/**
 * Status lines: while an agent turn that edits a 3D model is working, the backend tells the panel what the turn is
 * doing, so the requester sees more than a spinner during the model's long silent stretches. The model never writes or
 * sees these lines, and they are not part of the transcript (a suspended turn keeps only the last one, so the next
 * request does not repeat it). Each one states only what the backend knows: what the
 * last step was, what the model has started to write, or, while it retries a step or a step runs long, that work goes
 * on. None of them says a change is done unless its tool result said so, and none reports a step that failed: a retry is
 * the agent's own business, so the requester only sees that it is still working.
 */
export type StatusPhase = 'reading' | 'planning' | 'reviewing' | 'writing';
export interface StatusLine { phase: StatusPhase; text: string }
/** A line to send: a fixed one, or `SAYING` for one of the neutral "still working" sayings, picked by the sender. */
export type StatusPick = StatusLine | typeof SAYING;
export const SAYING = 'saying';

/** A browser tool call the turn sent and how it ended, as the request that resumes the turn received it. */
export interface PreviousStep { name: string; isError: boolean }

const READ_TOOLS: ReadonlySet<string> = new Set([MODEL_TOOLS.getDocument.name, MODEL_TOOLS.query.name, MODEL_TOOLS.overlaps.name, MODEL_TOOLS.materialLibrary.name]);
export const NEXT_STEP: StatusLine = { phase: 'planning', text: 'Working out the next step…' };
/**
 * Neutral lines for a retry and for long silences. Each only says that work goes on: no progress, success, time left,
 * or an activity the agent may not be doing.
 */
export const SAYINGS = [
  'Still working on it…', 'Still on it…', 'Working on it…', 'Still at it…', 'Keeping at it…', 'Working through the details…',
  'Putting the pieces together…', 'Thinking it through…', 'Still working this out…', 'Still at the workbench…',
  'Working on your request…', 'This takes a little thought…',
] as const;
/** Silence before the first long-silence line, then before the second one. */
export const QUIET_MS = [15_000, 20_000] as const;

/** The line a turn's first request opens with. */
export function messageStatus(pictures: boolean): StatusLine {
  return pictures ? { phase: 'reading', text: 'Looking at your pictures…' } : { phase: 'reading', text: 'Reading your request…' };
}

/** The line a resumed turn opens with, from the browser's answers to the calls it suspended on. */
export function resumeStatus(steps: readonly PreviousStep[]): StatusPick {
  const applied = steps.filter(s => s.name === MODEL_TOOLS.applyOperations.name);
  // The agent retries a batch that did not apply; the requester only hears that it is still working.
  if (applied.some(s => s.isError)) return SAYING;
  if (applied.length) return { phase: 'planning', text: 'Change applied. Working out the next step…' };
  if (steps.some(s => s.name === MODEL_TOOLS.render.name && !s.isError)) return { phase: 'reviewing', text: 'Looking over the review pictures…' };
  if (steps.length && steps.every(s => READ_TOOLS.has(s.name) && !s.isError)) return { phase: 'planning', text: 'Read the model. Working out the next step…' };
  return NEXT_STEP;
}

/** The line for a block the model has started to write, or null when the block needs none of its own. */
export function blockStatus(phase: Extract<RoundPhase, { kind: 'block' }>): StatusLine | null {
  return phase.block === 'tool_use' && phase.tool === MODEL_TOOLS.applyOperations.name ? { phase: 'writing', text: 'Writing the change…' } : null;
}

/** How a status line reaches the panel; `quiet` resets the silence clock (call it for every other event sent). */
export interface StatusSender {
  send(line: StatusPick): void; quiet(): void; stop(): void;
  /** The text of the last line sent, so the request that resumes the turn does not open with the same saying. */
  last(): string | null;
}
type Schedule = (run: () => void, ms: number) => () => void;
const timeout: Schedule = (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); };
export interface StatusSenderOptions {
  schedule?: Schedule;
  /** Picks a saying: a number in [0, 1), as `Math.random` returns. */
  random?: () => number;
  /** The last line the turn's previous request sent; the first saying of this request is never the same. */
  previous?: string | null | undefined;
}

/**
 * Sends status lines for one request: a line is sent only when its text differs from the last one sent, and after a
 * stretch with nothing sent at all, a saying (at most two such lines per request). A saying is picked at random, never
 * the one sent just before it. `stop` ends the clock; nothing is sent after it.
 */
export function statusSender(emit: (line: StatusLine) => void, options: StatusSenderOptions = {}): StatusSender {
  const schedule = options.schedule ?? timeout, random = options.random ?? Math.random;
  let last: StatusLine | null = null, quietCount = 0, stopped = false;
  let cancel: (() => void) | null = null;
  const saying = (phase: StatusPhase): StatusLine => {
    const avoid = last?.text ?? options.previous ?? null;
    const choices = SAYINGS.filter(s => s !== avoid);
    return { phase, text: choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]! };
  };
  const put = (line: StatusLine): void => { last = line; emit(line); };
  const arm = (): void => {
    cancel?.(); cancel = null;
    if (stopped || quietCount >= QUIET_MS.length) return;
    cancel = schedule(() => {
      cancel = null;
      if (stopped) return;
      quietCount += 1;
      put(saying(last?.phase ?? 'planning'));
      arm();
    }, QUIET_MS[quietCount]!);
  };
  return {
    send(line) {
      if (stopped) return;
      if (line === SAYING) put(saying('planning'));
      else if (last?.text !== line.text) put(line);
      arm();
    },
    quiet() { if (!stopped) arm(); },
    stop() { stopped = true; cancel?.(); cancel = null; },
    last: () => last?.text ?? null,
  };
}
