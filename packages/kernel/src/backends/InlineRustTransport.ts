// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createRustKernelModule, type RustKernelModuleFactory } from '../rustKernelModule';
import { RustKernelCaller, RustKernelRejection, trapErrorInfo } from '../worker/rustKernelCore';
import type { NativeKernelTransport } from './NativeKernelBackend';

/** The Rust kernel's WebAssembly module running on this thread, with the worker's behaviour on a trap: a crash answers as a kernel error and the next call starts a fresh module. */
export class InlineRustTransport implements NativeKernelTransport {
  private caller: Promise<RustKernelCaller> | undefined;
  constructor(private readonly factory: RustKernelModuleFactory = createRustKernelModule) {}
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  private get(): Promise<RustKernelCaller> {
    this.caller ??= this.factory().then(
      (module) => new RustKernelCaller(module),
      (cause: unknown) => {
        this.caller = undefined;
        throw cause;
      },
    );
    return this.caller;
  }
  async call(request: Uint8Array): Promise<ArrayBuffer> {
    const caller = await this.get();
    try {
      return caller.call(request);
    } catch (e) {
      if (e instanceof RustKernelRejection) throw e.info;
      this.caller = undefined;
      throw trapErrorInfo(e);
    }
  }
  async abort(): Promise<void> {
    (await this.caller)?.abort();
  }
}
