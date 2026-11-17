// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Calls the Rust kernel's WebAssembly module (`crates/kernel-wasm`) over its C ABI: one request's bytes in, one
 * response's bytes out. Shared by the worker and the tests that run the module in Node.
 */
import type { RustKernelModule } from '../../wasm/pushform-kernel.js';

/** The error the kernel module reported, as the JSON text of a `KernelErrorInfo`. */
export class RustKernelRejection extends Error {
  constructor(readonly info: string) {
    super(info);
    this.name = 'RustKernelRejection';
  }
}

/** Wraps a loaded module; each call copies the request in and the response out so nothing outlives the call. */
export class RustKernelCaller {
  constructor(private readonly module: RustKernelModule) {}

  /** Runs one request. Throws {@link RustKernelRejection} for an answered error; anything else thrown means the module trapped. */
  call(request: Uint8Array): ArrayBuffer {
    const { module } = this;
    const ptr = module._pf_kernel_alloc(request.byteLength);
    if (ptr === 0) throw new RustKernelRejection(JSON.stringify({ code: 'Internal', message: 'The kernel module is out of memory' }));
    module.HEAPU8.set(request, ptr);
    // The call may grow memory: HEAPU8 and HEAPU32 are read afterwards, never held across it. Nothing below runs after a
    // trap, so a crashed instance is never asked to free anything.
    const result = module._pf_kernel_call(ptr, request.byteLength);
    const status = module.HEAPU32[result >>> 2]!;
    const responsePtr = module.HEAPU32[(result >>> 2) + 1]!;
    const responseLen = module.HEAPU32[(result >>> 2) + 2]!;
    const bytes = module.HEAPU8.slice(responsePtr, responsePtr + responseLen);
    module._pf_kernel_free(responsePtr, responseLen);
    module._pf_kernel_free(ptr, request.byteLength);
    if (status !== 0) throw new RustKernelRejection(new TextDecoder().decode(bytes));
    return bytes.buffer as ArrayBuffer;
  }

  /** Current size of the module's linear memory. */
  get memoryBytes(): number {
    return this.module.HEAPU8.buffer.byteLength;
  }

  /** Drops every cached solid; later requests see `BodyNotCached`. */
  abort(): void {
    this.module._pf_kernel_abort();
  }
}

/** The JSON a trap in the module is reported as: the module is unusable from here on and gets reinstantiated. */
export function trapErrorInfo(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return JSON.stringify({ code: 'Internal', message: `Kernel module crashed and was restarted (${message})` });
}
