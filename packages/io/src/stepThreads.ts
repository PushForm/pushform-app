// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { wasiImports, type StepThreadPool } from './stepWasm';

/**
 * Threads for the threaded STEP reader build (`wasm32-wasip1-threads`). The module imports a shared memory and, when
 * it meshes parts on threads, calls `wasi.thread-spawn` once per thread; the host answers by running
 * `wasi_thread_start` on a worker that instantiated the same module over the same memory. The workers are started
 * ahead of time, so a spawn only posts a message, and the thread that spawned never has to block for it.
 *
 * The host side is platform-neutral: a browser worker and a Node worker thread both fit `StepThreadWorker`.
 */

/** Messages a thread worker receives and sends. */
export type StepThreadRequest =
  | { type: 'init'; module: WebAssembly.Module; memory: WebAssembly.Memory }
  | { type: 'start'; tid: number; start: number };
export type StepThreadReply = { type: 'ready' } | { type: 'done'; tid: number } | { type: 'error'; message: string };

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
 * The pool: `count` workers started now (each instantiates the module over `memory`), one thread per spawn. A spawn
 * beyond the ready workers starts another worker, which runs the thread as soon as it is ready.
 */
export async function createStepThreadPool(module: WebAssembly.Module, memory: WebAssembly.Memory, count: number, makeWorker: () => StepThreadWorker): Promise<StepThreadPool> {
  interface Slot { worker: StepThreadWorker; ready: boolean; busy: boolean; queued: { tid: number; start: number }[] }
  const slots: Slot[] = [];
  let nextTid = 1;
  const pool = {
    memory, count, failure: undefined as string | undefined,
    spawn(start: number): number {
      if (pool.failure) return -1;
      const tid = nextTid++;
      const slot = slots.find(s => s.ready && !s.busy) ?? slots.find(s => !s.ready && !s.queued.length) ?? add();
      if (slot.ready) { slot.busy = true; slot.worker.post({ type: 'start', tid, start }); } else slot.queued.push({ tid, start });
      return tid;
    },
    terminate(): void { for (const slot of slots) slot.worker.terminate(); slots.length = 0; },
  };
  const add = (): Slot => {
    const slot: Slot = { worker: makeWorker(), ready: false, busy: false, queued: [] };
    slot.worker.onMessage(message => {
      if (message.type === 'ready') {
        slot.ready = true;
        const next = slot.queued.shift();
        if (next) { slot.busy = true; slot.worker.post({ type: 'start', ...next }); }
      } else if (message.type === 'done') {
        slot.busy = false;
        const next = slot.queued.shift();
        if (next) { slot.busy = true; slot.worker.post({ type: 'start', ...next }); }
      } else pool.failure ??= message.message;
    });
    slot.worker.post({ type: 'init', module, memory });
    slots.push(slot);
    return slot;
  };
  for (let i = 0; i < count; i++) add();
  return pool;
}

/** The worker side: instantiate the module over the shared memory, then run each thread it is asked to. */
export function runStepThread(port: { post(message: StepThreadReply): void; onMessage(handler: (message: StepThreadRequest) => void): void }): void {
  let exports: { wasi_thread_start(tid: number, start: number): void } | undefined;
  port.onMessage(async message => {
    try {
      if (message.type === 'init') {
        const { module, memory } = message;
        const imports: WebAssembly.Imports = { wasi_snapshot_preview1: wasiImports(() => memory), env: { memory }, wasi: { 'thread-spawn': () => -1 } };
        exports = (await WebAssembly.instantiate(module, imports)).exports as unknown as typeof exports;
        port.post({ type: 'ready' });
      } else if (message.type === 'start') {
        if (!exports) throw new Error('The STEP reader thread was started before its module.');
        exports.wasi_thread_start(message.tid, message.start);
        port.post({ type: 'done', tid: message.tid });
      }
    } catch (cause) {
      port.post({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  });
}
