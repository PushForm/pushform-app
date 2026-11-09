// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Web Worker running the Rust kernel's WebAssembly module: `{ id, ... }` in, `{ id, ok, ... }` out. A trap inside the
 * module (a C++ exception Rust cannot catch, running out of memory, `abort`) surfaces here as a thrown JavaScript error;
 * that module instance is unusable afterwards, so it is thrown away and the next request loads a fresh one. Bodies come
 * back through the backend's `BodyNotCached` re-upload.
 */
import type { RustKernelModule } from '../../wasm/pushform-kernel.js';
import { RustKernelCaller, RustKernelRejection, trapErrorInfo } from './rustKernelCore';

export type RustKernelWorkerRequest =
  | { id: number; type: 'load'; moduleUrl?: string }
  | { id: number; type: 'call'; request: Uint8Array };

export type RustKernelWorkerResponse =
  | { id: number; ok: true; response?: ArrayBuffer; loadMs?: number; memoryBytes?: number }
  | { id: number; ok: false; error: string; loadMs?: number };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<RustKernelWorkerRequest>) => void) | null;
  postMessage(message: RustKernelWorkerResponse, transfer?: ArrayBuffer[]): void;
}

const scope = self as unknown as WorkerScope;
let moduleUrl: string | undefined;
let caller: Promise<RustKernelCaller> | undefined;

async function loadModule(): Promise<RustKernelCaller> {
  const factory: (options?: object) => Promise<RustKernelModule> = moduleUrl === undefined
    ? (await import('../../wasm/pushform-kernel.js')).default
    : ((await import(/* @vite-ignore */ moduleUrl)) as { default: (options?: object) => Promise<RustKernelModule> }).default;
  return new RustKernelCaller(await factory());
}

function currentCaller(): Promise<RustKernelCaller> {
  caller ??= loadModule().catch((e: unknown) => {
    caller = undefined;
    throw e;
  });
  return caller;
}

async function handle(message: RustKernelWorkerRequest): Promise<void> {
  const { id } = message;
  if (message.type === 'load') {
    moduleUrl = message.moduleUrl;
    const t0 = performance.now();
    try {
      const loaded = await currentCaller();
      scope.postMessage({ id, ok: true, loadMs: performance.now() - t0, memoryBytes: loaded.memoryBytes });
    } catch (e) {
      scope.postMessage({ id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), loadMs: performance.now() - t0 });
    }
    return;
  }
  let active: RustKernelCaller;
  try {
    active = await currentCaller();
  } catch (e) {
    scope.postMessage({ id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    return;
  }
  try {
    const response = active.call(message.request);
    scope.postMessage({ id, ok: true, response, memoryBytes: active.memoryBytes }, [response]);
  } catch (e) {
    if (e instanceof RustKernelRejection) {
      scope.postMessage({ id, ok: false, error: e.info });
      return;
    }
    // A trap: this instance's linear memory can no longer be trusted, so the next request starts a new one.
    caller = undefined;
    scope.postMessage({ id, ok: false, error: trapErrorInfo(e) });
  }
}

let queue: Promise<void> = Promise.resolve();
scope.onmessage = (ev) => {
  const message = ev.data;
  queue = queue.then(() => handle(message));
};
