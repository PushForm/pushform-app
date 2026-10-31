// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createStepThreadPool, importedMemoryLimits, spawnThread, threadWorkerCapacity, type StepThreadReply, type StepThreadRequest, type StepThreadWorker } from './stepThreads';

/** A minimal module importing a shared memory: (import "env" "memory" (memory 18 65536 shared)). */
function moduleImportingMemory(min: number, max: number, shared: boolean): Uint8Array {
  const leb = (v: number): number[] => { const out: number[] = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; out.push(b); } while (v); return out; };
  const str = (s: string): number[] => [s.length, ...new TextEncoder().encode(s)];
  const entry = [...str('env'), ...str('memory'), 2, shared ? 3 : 1, ...leb(min), ...leb(max)];
  const section = [1, ...entry];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, ...leb(section.length), ...section]);
}

interface Fake { handler?: (m: StepThreadReply) => void; got: StepThreadRequest[] }
const fakeWorker = (list: Fake[]): StepThreadWorker => {
  const w: Fake = { got: [] };
  list.push(w);
  return { post: m => w.got.push(m), onMessage: h => { w.handler = h; }, terminate: () => {} };
};

describe('threaded STEP reader host', () => {
  it('reads the limits of the memory a module imports', () => {
    expect(importedMemoryLimits(moduleImportingMemory(18, 65536, true))).toEqual({ min: 18, max: 65536, shared: true });
    expect(importedMemoryLimits(moduleImportingMemory(1, 2, false))).toEqual({ min: 1, max: 2, shared: false });
    expect(importedMemoryLimits(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).toBeUndefined();
  });

  it('claims an idle slot of the thread table for each spawn and numbers the threads', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const table = 64, words = new Int32Array(memory.buffer);
    words[(table >> 2) + 1] = 2; // two worker slots
    expect(spawnThread(memory, table, 100)).toBe(1);
    expect(spawnThread(memory, table, 200)).toBe(2);
    // Both busy: a third thread cannot start.
    expect(spawnThread(memory, table, 300)).toBe(-1);
    expect([...words.subarray((table >> 2) + 2, (table >> 2) + 10)]).toEqual([2, 1, 100, 0, 2, 2, 200, 0]);
    // A worker back to idle serves the next spawn.
    Atomics.store(words, (table >> 2) + 2, 0);
    expect(spawnThread(memory, table, 300)).toBe(3);
  });

  it('makes the workers when started and hands each its slot', () => {
    const workers: Fake[] = [];
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const pool = createStepThreadPool({} as WebAssembly.Module, memory, 2, () => fakeWorker(workers));
    expect(pool.capacity).toBe(threadWorkerCapacity(2));
    expect(pool.spawn(100)).toBe(-1); // not started
    const started = pool.start(128);
    started.catch(() => {}); // the fake that fails below rejects it
    expect(workers).toHaveLength(pool.capacity);
    expect(workers[3]!.got).toEqual([{ type: 'init', module: {}, memory, table: 128, index: 3 }]);
    expect(new Int32Array(memory.buffer)[(128 >> 2) + 1]).toBe(pool.capacity);
    expect(pool.spawn(100)).toBe(1);
    workers[0]!.handler!({ type: 'error', message: 'unreachable' });
    expect(pool.failure).toBe('unreachable');
    expect(pool.spawn(500)).toBe(-1);
  });
});
