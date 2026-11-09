// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import type { KernelBackend, MeshProvider } from './KernelBackend';

/**
 * A backend that is created on first use, for one that lives in a separately loaded chunk. Requests wait for it, and
 * those still waiting when `abortAll` or `dispose` arrives are aborted rather than sent.
 */
export class DeferredBackend implements KernelBackend {
  private loading: Promise<KernelBackend> | undefined;
  private loaded: KernelBackend | undefined;
  private provider: MeshProvider | undefined;
  private epoch = 0;
  private disposed = false;

  constructor(private readonly load: () => Promise<KernelBackend>) {}

  async request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    const epoch = this.epoch;
    if (this.disposed) throw new KernelError('Aborted', 'Kernel is disposed');
    let backend: KernelBackend;
    try {
      backend = await this.resolve();
    } catch (cause) {
      throw new KernelError('Internal', `The kernel could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (epoch !== this.epoch || this.disposed) throw new KernelError('Aborted', 'Kernel worker aborted');
    return backend.request(req);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
    this.loaded?.setMeshProvider?.(provider);
  }

  abortAll(): void {
    this.epoch++;
    this.loaded?.abortAll();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.loaded?.dispose();
  }

  private resolve(): Promise<KernelBackend> {
    this.loading ??= this.load().then(
      (backend) => {
        this.loaded = backend;
        if (this.provider !== undefined) backend.setMeshProvider?.(this.provider);
        if (this.disposed) backend.dispose();
        return backend;
      },
      (cause: unknown) => {
        // Nothing was created, so the next request tries again.
        this.loading = undefined;
        throw cause;
      },
    );
    return this.loading;
  }
}
