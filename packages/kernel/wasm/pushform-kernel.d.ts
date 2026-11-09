// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Types of the Emscripten glue `pushform-kernel.js`, built by `pnpm build:kernel-wasm` into this directory.
export interface RustKernelModule {
  readonly HEAPU8: Uint8Array;
  readonly HEAPU32: Uint32Array;
  /** Allocate `len` bytes; 0 when the heap cannot grow. */
  _pf_kernel_alloc(len: number): number;
  _pf_kernel_free(ptr: number, len: number): void;
  /** Run one request; the result is a pointer to `[status, response pointer, response length]`. */
  _pf_kernel_call(request: number, len: number): number;
  _pf_kernel_abort(): void;
}

export default function createRustKernelModule(options?: { locateFile?: (path: string, prefix: string) => string }): Promise<RustKernelModule>;
