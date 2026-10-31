// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createStepThreadPool, importedMemoryLimits, type StepThreadReply, type StepThreadRequest, type StepThreadWorker } from './stepThreads';

/** A minimal module importing a shared memory: (import "env" "memory" (memory 18 65536 shared)). */
function moduleImportingMemory(min: number, max: number, shared: boolean): Uint8Array {
  const leb = (v: number): number[] => { const out: number[] = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; out.push(b); } while (v); return out; };
  const str = (s: string): number[] => [s.length, ...new TextEncoder().encode(s)];
  const entry = [...str('env'), ...str('memory'), 2, shared ? 3 : 1, ...leb(min), ...leb(max)];
  const section = [1, ...entry];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, ...leb(section.length), ...section]);
}

describe('threaded STEP reader host', () => {
  it('reads the limits of the memory a module imports', () => {
    expect(importedMemoryLimits(moduleImportingMemory(18, 65536, true))).toEqual({ min: 18, max: 65536, shared: true });
    expect(importedMemoryLimits(moduleImportingMemory(1, 2, false))).toEqual({ min: 1, max: 2, shared: false });
    expect(importedMemoryLimits(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).toBeUndefined();
  });

  it('hands each spawned thread to a ready idle worker and queues the rest', async () => {
    const workers: { handler?: (m: StepThreadReply) => void; got: StepThreadRequest[] }[] = [];
    const makeWorker = (): StepThreadWorker => {
      const w: { handler?: (m: StepThreadReply) => void; got: StepThreadRequest[] } = { got: [] };
      workers.push(w);
      return { post: m => w.got.push(m), onMessage: h => { w.handler = h; }, terminate: () => {} };
    };
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const pool = await createStepThreadPool({} as WebAssembly.Module, memory, 2, makeWorker);
    expect(workers).toHaveLength(2);
    expect(workers.map(w => w.got[0]?.type)).toEqual(['init', 'init']);
    workers[0]!.handler!({ type: 'ready' });
    // One ready worker takes the first thread at once; the second thread waits on the worker still starting.
    expect(pool.spawn(100)).toBe(1);
    expect(pool.spawn(200)).toBe(2);
    expect(workers[0]!.got[1]).toEqual({ type: 'start', tid: 1, start: 100 });
    expect(workers[1]!.got).toHaveLength(1);
    workers[1]!.handler!({ type: 'ready' });
    expect(workers[1]!.got[1]).toEqual({ type: 'start', tid: 2, start: 200 });
    // Both busy: a third thread starts another worker rather than waiting.
    expect(pool.spawn(300)).toBe(3);
    expect(workers).toHaveLength(3);
    workers[2]!.handler!({ type: 'ready' });
    expect(workers[2]!.got[1]).toEqual({ type: 'start', tid: 3, start: 300 });
    // A finished worker takes the next thread; a failed one fails the pool.
    workers[0]!.handler!({ type: 'done', tid: 1 });
    expect(pool.spawn(400)).toBe(4);
    expect(workers[0]!.got[2]).toEqual({ type: 'start', tid: 4, start: 400 });
    workers[1]!.handler!({ type: 'error', message: 'unreachable' });
    expect(pool.failure).toBe('unreachable');
    expect(pool.spawn(500)).toBe(-1);
  });
});
