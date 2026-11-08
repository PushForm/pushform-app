// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The Rust kernel's WebAssembly path, kept out of the package's main entry because its worker imports a module that
 * only exists after `pnpm build:kernel-wasm`. Nothing in the app imports this file by default.
 */
import { NativeKernelBackend } from './backends/NativeKernelBackend';
import { RustWasmKernelTransport, type RustWasmKernelTransportOptions } from './backends/RustWasmKernelTransport';
import { WorkerBackend, type WorkerBackendOptions } from './backends/WorkerBackend';

export { RustWasmKernelTransport, type RustWasmKernelTransportOptions };

export interface RustWasmBackendOptions extends WorkerBackendOptions {
  /** The worker running the Rust module; defaults to a module worker of `worker/rustKernel.worker.ts`. */
  createRustWorker?: () => Worker;
  moduleUrl?: string;
}

/** Push/pull through the Rust module in its own worker, everything else through the existing TypeScript worker. */
export function createRustWasmBackend(options: RustWasmBackendOptions = {}): { backend: NativeKernelBackend; transport: RustWasmKernelTransport } {
  const { createRustWorker, moduleUrl, ...workerOptions } = options;
  const transport = new RustWasmKernelTransport({
    createWorker: createRustWorker ?? (() => new Worker(new URL('./worker/rustKernel.worker.ts', import.meta.url), { type: 'module' })),
    ...(moduleUrl !== undefined ? { moduleUrl } : {}),
  });
  return { backend: new NativeKernelBackend(new WorkerBackend(workerOptions), transport, { fallback: false }), transport };
}
