// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DeferredBackend, type KernelBackend } from '@pushform/kernel';

/** Set by the app's build config; present and true only in a build made with `PF_RUST_KERNEL=1`. */
declare const __PF_RUST_KERNEL__: boolean | undefined;

/**
 * The kernel backend of a build made with the Rust kernel flag: every request runs in the Rust kernel's WebAssembly
 * module, in its own worker, with no TypeScript kernel behind it. Without the flag this is `undefined` and the import
 * below resolves to a stub, so a normal build needs no Emscripten.
 */
export function rustKernelBackend(): KernelBackend | undefined {
  if (typeof __PF_RUST_KERNEL__ === 'undefined' || !__PF_RUST_KERNEL__) return undefined;
  return new DeferredBackend(async () => (await import('@pushform/kernel/rust-wasm')).createRustWasmBackend().backend);
}
