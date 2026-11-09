// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DeferredBackend, type KernelBackend } from '@pushform/kernel';

/** The app's kernel: every request runs in the Rust kernel's WebAssembly module, in its own worker, loaded on first use. */
export function rustKernelBackend(): KernelBackend {
  return new DeferredBackend(async () => (await import('@pushform/kernel/rust-wasm')).createRustWasmBackend().backend);
}
