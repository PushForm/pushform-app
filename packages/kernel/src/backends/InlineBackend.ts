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
  /** Stay on the TypeScript kernel even when another was installed with {@link setInlineKernelFactory}; for tests that compare the two. */
  typescriptOnly?: boolean;
}

/** Builds the kernel that new inline backends run on, in place of the TypeScript one. */
export type InlineKernelFactory = (options: InlineBackendOptions) => KernelBackend;
let kernelFactory: InlineKernelFactory | undefined;

/** Makes every `InlineBackend` created from now on run on another kernel. Tests use this to run the suite on Rust. */
export function setInlineKernelFactory(factory: InlineKernelFactory | undefined): void {
  kernelFactory = factory;
}

/**
 * Runs the ops in-process (Node tests, CLI, headless MCP). Requests still return promises because
 * the wasm module loads asynchronously; after that every op runs synchronously on the caller's thread.
 */
export class InlineBackend implements KernelBackend {
  private context: Promise<KernelContext> | undefined;
  private provider: MeshProvider | undefined;
  private disposed = false;
  /** The other kernel this backend runs on, when one was installed with {@link setInlineKernelFactory}. */
  private readonly other: KernelBackend | undefined;

  constructor(private readonly options: InlineBackendOptions = {}) {
    this.other = options.typescriptOnly ? undefined : kernelFactory?.(options);
  }

  /** The context, for tests that want to poke at the cache or wasm module directly. */
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
