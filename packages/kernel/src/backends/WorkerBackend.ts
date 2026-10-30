// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, KernelRequestEnvelope, KernelResponseEnvelope, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import { sendWithReupload, type KernelBackend, type MeshProvider } from './KernelBackend';

export interface WorkerBackendOptions {
  /** Custom worker factory (tests, non-Vite bundlers). Defaults to the module worker `kernel.worker.ts`. */
  createWorker?: () => Worker;
  meshProvider?: MeshProvider;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Runs the kernel in a dedicated module Web Worker. `abortAll()` terminates the worker (the only
 * way to interrupt a running boolean) and spawns a fresh one; bodies are re-uploaded lazily
 * through the mesh provider when the new worker reports `BodyNotCached`.
 */
export class WorkerBackend implements KernelBackend {
  private worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private provider: MeshProvider | undefined;
  private disposed = false;

  constructor(private readonly options: WorkerBackendOptions = {}) {
    this.provider = options.meshProvider;
    this.worker = this.spawn();
  }

  request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    return sendWithReupload(req, (q) => this.send(q), this.provider);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
  }

  abortAll(): void {
    this.rejectAll(new KernelError('Aborted', 'Kernel worker aborted'));
    this.worker.terminate();
    if (!this.disposed) this.worker = this.spawn();
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new KernelError('Aborted', 'Kernel worker disposed'));
    this.worker.terminate();
  }

  private spawn(): Worker {
    const worker =
      this.options.createWorker?.() ?? new Worker(new URL('../worker/kernel.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<KernelResponseEnvelope>) => this.onResponse(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      this.rejectAll(new KernelError('Internal', ev.message || 'Kernel worker crashed'));
    };
    return worker;
  }

  private send<Q extends KernelRequest>(req: Q): Promise<ResFor<Q>> {
    if (this.disposed) return Promise.reject(new KernelError('Aborted', 'WorkerBackend is disposed'));
    const id = this.nextId++;
    const envelope: KernelRequestEnvelope = { id, req };
    return new Promise<ResFor<Q>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(envelope);
    });
  }

  private onResponse(res: KernelResponseEnvelope): void {
    const p = this.pending.get(res.id);
    if (p === undefined) return;
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(KernelError.fromInfo(res.error));
  }

  private rejectAll(error: KernelError): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
