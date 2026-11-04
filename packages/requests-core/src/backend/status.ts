// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MODEL_TOOLS } from '@pushform/extension-protocol';
import type { RoundPhase } from '../agents/client.ts';

/**
 * Status lines: while an agent turn that edits a 3D model is working, the backend tells the panel what the turn is
 * doing, so the requester sees more than a spinner during the model's long silent stretches. The model never writes or
 * sees these lines, and they are not saved with the conversation. Each one states only what the backend knows: what the
 * last step was and how it ended, what the model has started to write, or that a step is taking a while. None of them
 * says a change is done unless its tool result said so.
 */
export type StatusPhase = 'reading' | 'planning' | 'fixing' | 'reviewing' | 'writing';
export interface StatusLine { phase: StatusPhase; text: string }

/** A browser tool call the turn sent and how it ended, as the request that resumes the turn received it. */
export interface PreviousStep { name: string; isError: boolean }

const READ_TOOLS: ReadonlySet<string> = new Set([MODEL_TOOLS.getDocument.name, MODEL_TOOLS.query.name, MODEL_TOOLS.overlaps.name, MODEL_TOOLS.materialLibrary.name]);
export const NEXT_STEP: StatusLine = { phase: 'planning', text: 'Working out the next step…' };
/** Shown at the first and second long silence of one request, never more often. */
export const STILL_WORKING = ['Still working this out. Bigger changes take longer.', 'Still working. Stop ends the reply; finished changes stay.'] as const;
/** Silence before the first long-silence line, then before the second one. */
export const QUIET_MS = [15_000, 20_000] as const;

/** The line a turn's first request opens with. */
export function messageStatus(pictures: boolean): StatusLine {
  return pictures ? { phase: 'reading', text: 'Looking at your pictures…' } : { phase: 'reading', text: 'Reading your request…' };
}

/** The line a resumed turn opens with, from the browser's answers to the calls it suspended on. */
export function resumeStatus(steps: readonly PreviousStep[]): StatusLine {
  const applied = steps.filter(s => s.name === MODEL_TOOLS.applyOperations.name);
  // A batch applies whole or not at all, so a failed one changed nothing.
  if (applied.some(s => s.isError)) return { phase: 'fixing', text: 'That change didn’t apply. Working out a fix…' };
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
export interface StatusSender { send(line: StatusLine): void; quiet(): void; stop(): void }
type Schedule = (run: () => void, ms: number) => () => void;
const timeout: Schedule = (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); };

/**
 * Sends status lines for one request: a line is sent only when its text differs from the last one sent, and after a
 * stretch with nothing sent at all, one of the long-silence lines (at most two per request). `stop` ends the clock;
 * nothing is sent after it.
 */
export function statusSender(emit: (line: StatusLine) => void, schedule: Schedule = timeout): StatusSender {
  let last: StatusLine | null = null, quietCount = 0, stopped = false;
  let cancel: (() => void) | null = null;
  const arm = (): void => {
    cancel?.(); cancel = null;
    if (stopped || quietCount >= STILL_WORKING.length) return;
    cancel = schedule(() => {
      cancel = null;
      if (stopped) return;
      const text = STILL_WORKING[quietCount]!;
      quietCount += 1;
      last = { phase: last?.phase ?? 'planning', text };
      emit(last);
      arm();
    }, QUIET_MS[quietCount]!);
  };
  return {
    send(line) {
      if (stopped) return;
      if (last?.text !== line.text) { last = line; emit(line); }
      arm();
    },
    quiet() { if (!stopped) arm(); },
    stop() { stopped = true; cancel?.(); cancel = null; },
  };
}
