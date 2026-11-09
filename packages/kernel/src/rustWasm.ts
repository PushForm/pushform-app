// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The Rust kernel's WebAssembly path, kept out of the package's main entry because its worker imports a module that
 * only exists after `pnpm build:kernel-wasm`. Nothing in the app imports this file by default.
 */
import type { MeshProvider } from './backends/KernelBackend';
import { NativeKernelBackend } from './backends/NativeKernelBackend';
import { RustWasmKernelTransport, type RustWasmKernelTransportOptions } from './backends/RustWasmKernelTransport';

export { RustWasmKernelTransport, type RustWasmKernelTransportOptions };

export interface RustWasmBackendOptions {
  /** The worker running the Rust module; defaults to a module worker of `worker/rustKernel.worker.ts`. */
  createRustWorker?: () => Worker;
  moduleUrl?: string;
  meshProvider?: MeshProvider;
}

/** A backend that answers every kernel request from the Rust module in its own worker, with no TypeScript kernel behind it. */
export function createRustWasmBackend(options: RustWasmBackendOptions = {}): { backend: NativeKernelBackend; transport: RustWasmKernelTransport } {
  const { createRustWorker, moduleUrl, meshProvider } = options;
  const transport = new RustWasmKernelTransport({
    createWorker: createRustWorker ?? (() => new Worker(new URL('./worker/rustKernel.worker.ts', import.meta.url), { type: 'module' })),
    ...(moduleUrl !== undefined ? { moduleUrl } : {}),
  });
  const backend = new NativeKernelBackend(undefined, transport, { fallback: false });
  if (meshProvider !== undefined) backend.setMeshProvider(meshProvider);
  return { backend, transport };
}
