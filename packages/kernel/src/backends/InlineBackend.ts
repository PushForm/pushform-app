// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, ResFor } from '../protocol';
import { InlineRustTransport } from './InlineRustTransport';
import type { KernelBackend, MeshProvider } from './KernelBackend';
import { NativeKernelBackend } from './NativeKernelBackend';

/**
 * Runs the kernel in-process on this thread (Node tests, CLI, headless MCP), on the Rust kernel's WebAssembly module.
 * Requests still return promises because the module loads asynchronously; after that every op runs synchronously.
 */
export class InlineBackend implements KernelBackend {
  private readonly rust = new NativeKernelBackend(undefined, new InlineRustTransport(), { fallback: false });

  request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    return this.rust.request(req);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.rust.setMeshProvider(provider);
  }

  /** Nothing runs concurrently in-process; this just clears the body cache, like a worker restart. */
  abortAll(): void {
    this.rust.abortAll();
  }

  dispose(): void {
    this.rust.dispose();
  }
}
