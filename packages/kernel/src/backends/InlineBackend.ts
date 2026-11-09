// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import { createKernelContext, type KernelContext } from '../worker/context';
import { dispatch } from '../worker/dispatch';
import { sendWithReupload, type KernelBackend, type MeshProvider } from './KernelBackend';
import { InlineRustTransport } from './InlineRustTransport';
import { NativeKernelBackend } from './NativeKernelBackend';

export interface InlineBackendOptions {
  /** Number of (body, version) Manifolds kept alive; default 64. */
  cacheCapacity?: number;
  /** Stay on the TypeScript kernel; for tests that compare the two. */
  typescriptOnly?: boolean;
}

/**
 * Runs the kernel in-process on this thread (Node tests, CLI, headless MCP), on the Rust kernel's WebAssembly module.
 * Requests still return promises because the module loads asynchronously; after that every op runs synchronously.
 */
export class InlineBackend implements KernelBackend {
  private context: Promise<KernelContext> | undefined;
  private provider: MeshProvider | undefined;
  private disposed = false;
  /** The Rust kernel this backend runs on, unless it was made with `typescriptOnly`. */
  private readonly other: KernelBackend | undefined;

  constructor(private readonly options: InlineBackendOptions = {}) {
    this.other = options.typescriptOnly ? undefined : new NativeKernelBackend(undefined, new InlineRustTransport(), { fallback: false });
  }

  /** The TypeScript context, for tests that want to poke at its cache or wasm module directly. */
  getContext(): Promise<KernelContext> {
    if (this.disposed) return Promise.reject(new KernelError('Aborted', 'InlineBackend is disposed'));
    this.context ??= createKernelContext(this.options.cacheCapacity);
    return this.context;
  }

  async request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    if (this.other !== undefined) return this.other.request(req);
    const ctx = await this.getContext();
    return sendWithReupload(req, (q) => Promise.resolve(dispatch(ctx, q)), this.provider);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
    this.other?.setMeshProvider?.(provider);
  }

  /** Nothing runs concurrently in-process; this just clears the body cache, like a worker restart. */
  abortAll(): void {
    this.other?.abortAll();
    void this.context?.then((ctx) => ctx.cache.clear());
  }

  dispose(): void {
    this.other?.dispose();
    this.abortAll();
    this.disposed = true;
  }
}
