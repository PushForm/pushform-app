// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The Rust kernel's WebAssembly path, kept out of the package's main entry so the worker and its module load only when
 * the first kernel request is made.
 */
import type { MeshData } from '@pushform/core';
import type { MeshProvider } from './backends/KernelBackend';
import { NativeKernelBackend } from './backends/NativeKernelBackend';
import { encodeValidateSolid } from './backends/nativeWire';
import { RustWasmKernelTransport, type RustWasmKernelTransportOptions } from './backends/RustWasmKernelTransport';
import { KernelError, type KernelErrorInfo } from './protocol';
import { createRustKernelModule } from './rustKernelModule';
import { RustKernelCaller, RustKernelRejection, trapErrorInfo } from './worker/rustKernelCore';

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

let validator: Promise<RustKernelCaller> | undefined;

/** The Rust module for {@link validateSolidWithRust}, loaded once per thread and replaced after a trap. */
function validatingModule(): Promise<RustKernelCaller> {
  validator ??= createRustKernelModule().then((module) => new RustKernelCaller(module)).catch((cause: unknown) => {
    validator = undefined;
    throw cause;
  });
  return validator;
}

/** `validateSolidMesh`'s check in the Rust kernel: Manifold must accept the mesh and it must enclose positive volume. */
export async function validateSolidWithRust(mesh: MeshData): Promise<void> {
  const caller = await validatingModule();
  try {
    caller.call(encodeValidateSolid(mesh));
  } catch (cause) {
    if (cause instanceof RustKernelRejection) throw KernelError.fromInfo(JSON.parse(cause.info) as KernelErrorInfo);
    validator = undefined;
    throw KernelError.fromInfo(JSON.parse(trapErrorInfo(cause)) as KernelErrorInfo);
  }
}
