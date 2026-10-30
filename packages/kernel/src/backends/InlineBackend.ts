// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import { createKernelContext, type KernelContext } from '../worker/context';
import { dispatch } from '../worker/dispatch';
import { sendWithReupload, type KernelBackend, type MeshProvider } from './KernelBackend';

export interface InlineBackendOptions {
  /** Number of (body, version) Manifolds kept alive; default 64. */
  cacheCapacity?: number;
}

/**
 * Runs the ops in-process (Node tests, CLI, headless MCP). Requests still return promises because
 * the wasm module loads asynchronously; after that every op runs synchronously on the caller's thread.
 */
export class InlineBackend implements KernelBackend {
  private context: Promise<KernelContext> | undefined;
  private provider: MeshProvider | undefined;
  private disposed = false;

  constructor(private readonly options: InlineBackendOptions = {}) {}

  /** The context, for tests that want to poke at the cache or wasm module directly. */
  getContext(): Promise<KernelContext> {
    if (this.disposed) return Promise.reject(new KernelError('Aborted', 'InlineBackend is disposed'));
    this.context ??= createKernelContext(this.options.cacheCapacity);
    return this.context;
  }

  async request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    const ctx = await this.getContext();
    return sendWithReupload(req, (q) => Promise.resolve(dispatch(ctx, q)), this.provider);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
  }

  /** Nothing runs concurrently in-process; this just clears the body cache, like a worker restart. */
  abortAll(): void {
    void this.context?.then((ctx) => ctx.cache.clear());
  }

  dispose(): void {
    this.abortAll();
    this.disposed = true;
  }
}
