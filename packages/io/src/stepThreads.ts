// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { wasiImports, type StepThreadPool } from './stepWasm';

/**
 * Threads for the threaded STEP reader build (`wasm32-wasip1-threads`). The module imports a shared memory and
 * calls `wasi.thread-spawn` for every thread it starts: the kernel's conversion workers, its tessellation pools and
 * the meshing threads. The host answers each spawn by running `wasi_thread_start` on a worker that instantiated the
 * same module over the same memory.
 *
 * Threads are spawned from threads too (a conversion worker starts its own tessellation pool), and the spawning
 * thread blocks right after, waiting for the new one. A browser starts a new worker only once the thread that made
 * it returns to its event loop, so a spawn can never make a worker: all workers are made ahead of time by the main
 * instance, and each waits in the shared memory for work. A spawn, from any thread, claims an idle worker's slot with
 * an atomic exchange, writes the thread id and start argument into it and wakes the worker; nothing passes through
 * an event loop. Thread ids come from a counter in the same table.
 *
 * The host side is platform-neutral: a browser worker and a Node worker thread both fit `StepThreadWorker`.
 */

/** Messages a thread worker receives and sends. */
export type StepThreadRequest = { type: 'init'; module: WebAssembly.Module; memory: WebAssembly.Memory; table: number; index: number };
export type StepThreadReply = { type: 'ready' } | { type: 'error'; message: string };

export interface StepThreadWorker {
  post(message: StepThreadRequest): void;
  onMessage(handler: (message: StepThreadReply) => void): void;
  terminate(): void;
}

/** The limits of the memory a module imports (`env.memory`), read from its import section; undefined when it imports none. */
export function importedMemoryLimits(bytes: Uint8Array): { min: number; max?: number; shared: boolean } | undefined {
  let at = 8;
  const leb = (): number => { let result = 0, shift = 0, byte: number; do { byte = bytes[at++]!; result |= (byte & 127) << shift; shift += 7; } while (byte & 128); return result >>> 0; };
  const name = (): string => { const len = leb(); const s = new TextDecoder().decode(bytes.subarray(at, at + len)); at += len; return s; };
  while (at < bytes.length) {
    const id = bytes[at++]!, len = leb(), end = at + len;
    if (id === 2) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const module = name(), field = name(), kind = bytes[at++]!;
        if (kind === 2) {
          const flags = bytes[at++]!, min = leb(), max = flags & 1 ? leb() : undefined;
          if (module === 'env' && field === 'memory') return { min, ...(max === undefined ? {} : { max }), shared: (flags & 2) !== 0 };
        } else if (kind === 0) leb();
        else if (kind === 1) { at++; const flags = bytes[at++]!; leb(); if (flags & 1) leb(); }
        else if (kind === 3) at += 2;
      }
      return undefined;
    }
    at = end;
  }
  return undefined;
}

/**
 * A shared memory for the module's import limits. The maximum is the module's (4 GiB for the reader) or the largest
 * the engine will reserve; `undefined` when the engine refuses even 1 GiB, in which case the threaded build cannot run.
 */
export function sharedStepMemory(limits: { min: number; max?: number }): WebAssembly.Memory | undefined {
  const top = Math.min(limits.max ?? 65536, 65536);
  for (const maximum of [top, 32768, 16384].filter((m, i, all) => m >= limits.min && all.indexOf(m) === i && m <= top)) {
    try { return new WebAssembly.Memory({ initial: limits.min, maximum, shared: true }); } catch { /* try a smaller reservation */ }
  }
  return undefined;
}

/**
 * The thread table in the shared memory, in 32-bit words: the thread id counter, the number of worker slots, then
 * one slot of four words per worker (state, thread id, start argument, unused).
 */
const TABLE_HEADER = 2, SLOT = 4;
const IDLE = 0, CLAIMED = 1, REQUESTED = 2, RUNNING = 3;
/** Bytes a table of `capacity` slots takes. */
export function threadTableBytes(capacity: number): number { return (TABLE_HEADER + SLOT * capacity) * 4; }

/**
 * Start a thread from any instance: claim an idle worker's slot, hand it the thread and wake it. Returns the thread
 * id, or -1 when every worker is busy (the module treats that as a thread that could not start).
 */
export function spawnThread(memory: WebAssembly.Memory, table: number, start: number): number {
  const words = new Int32Array(memory.buffer), base = table >> 2, count = Atomics.load(words, base + 1);
  for (let i = 0; i < count; i++) {
    const slot = base + TABLE_HEADER + i * SLOT;
    if (Atomics.compareExchange(words, slot, IDLE, CLAIMED) !== IDLE) continue;
    const tid = Atomics.add(words, base, 1) + 1;
    Atomics.store(words, slot + 1, tid);
    Atomics.store(words, slot + 2, start);
    Atomics.store(words, slot, REQUESTED);
    Atomics.notify(words, slot, 1);
    return tid;
  }
  return -1;
}

/**
 * How many workers to make for a module told it has `threads` threads: the kernel's pool, its conversion workers
 * and their tessellation pools, and the meshing threads can all be alive at once.
 */
export function threadWorkerCapacity(threads: number): number { return threads * 4 + 4; }

/**
 * The main instance's pool. `start` gets the address of the thread table (zeroed, `threadTableBytes(capacity)` long,
 * allocated by the main instance once its module is instantiated) and makes the workers; `count` is what the module
 * is told it may use.
 */
export function createStepThreadPool(module: WebAssembly.Module, memory: WebAssembly.Memory, count: number, makeWorker: () => StepThreadWorker): StepThreadPool {
  const workers: StepThreadWorker[] = [];
  let table = -1;
  const pool = {
    memory, count, capacity: threadWorkerCapacity(count), failure: undefined as string | undefined,
    start(at: number): Promise<void> {
      table = at;
      new Int32Array(memory.buffer, at, TABLE_HEADER + SLOT * pool.capacity).fill(0);
      Atomics.store(new Int32Array(memory.buffer), (at >> 2) + 1, pool.capacity);
      // Resolves once every worker holds its instance: a browser loads a worker's script through the thread that made
      // it, so the workers must be ready before that thread blocks in the module waiting for one of them.
      const ready: Promise<void>[] = [];
      for (let index = 0; index < pool.capacity; index++) {
        const worker = makeWorker();
        ready.push(new Promise<void>((resolve, reject) => worker.onMessage(message => {
          if (message.type === 'ready') resolve();
          else { pool.failure ??= message.message; reject(new Error(message.message)); }
        })));
        worker.post({ type: 'init', module, memory, table: at, index });
        workers.push(worker);
      }
      return Promise.all(ready).then(() => undefined);
    },
    spawn(start: number): number { return pool.failure || table < 0 ? -1 : spawnThread(memory, table, start); },
    terminate(): void { for (const worker of workers) worker.terminate(); workers.length = 0; },
  };
  return pool;
}

/**
 * The worker side: instantiate the module over the shared memory, report ready, then serve the worker's slot of the
 * thread table for good: wait for a thread, run it, go idle again. The wait blocks this worker, which is what it is for.
 */
export function runStepThread(port: { post(message: StepThreadReply): void; onMessage(handler: (message: StepThreadRequest) => void): void }): void {
  port.onMessage(async message => {
    try {
      const { module, memory, table, index } = message;
      const imports: WebAssembly.Imports = { wasi_snapshot_preview1: wasiImports(() => memory), env: { memory }, wasi: { 'thread-spawn': (start: number) => spawnThread(memory, table, start) } };
      const exports = (await WebAssembly.instantiate(module, imports)).exports as unknown as { wasi_thread_start(tid: number, start: number): void };
      port.post({ type: 'ready' });
      const slot = (table >> 2) + TABLE_HEADER + index * SLOT;
      for (;;) {
        // A fresh view each time: the shared memory's buffer object changes when the module grows it.
        let words = new Int32Array(memory.buffer);
        while (Atomics.load(words, slot) !== REQUESTED) { Atomics.wait(words, slot, Atomics.load(words, slot)); words = new Int32Array(memory.buffer); }
        const tid = Atomics.load(words, slot + 1), start = Atomics.load(words, slot + 2);
        Atomics.store(words, slot, RUNNING);
        exports.wasi_thread_start(tid, start);
        Atomics.store(new Int32Array(memory.buffer), slot, IDLE);
      }
    } catch (cause) {
      port.post({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}
