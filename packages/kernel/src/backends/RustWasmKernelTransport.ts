// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { NativeKernelTransport } from './NativeKernelBackend';
import type { RustKernelWorkerRequest, RustKernelWorkerResponse } from '../worker/rustKernel.worker';

export interface RustWasmKernelTransportOptions {
  /** Worker factory; the worker must run `worker/rustKernel.worker.ts`. */
  createWorker: () => Worker;
  /** Load a module other than the default one (the failure tests' build). */
  moduleUrl?: string;
}

interface Pending {
  resolve: (value: RustKernelWorkerResponse & { ok: true }) => void;
  reject: (cause: unknown) => void;
}

/**
 * The binary kernel protocol over a Web Worker running the Rust kernel's WebAssembly module. `abort` terminates the
 * worker, the only way to interrupt a running operation; the next request starts a new one and bodies are re-uploaded.
 */
export class RustWasmKernelTransport implements NativeKernelTransport {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private availability: Promise<boolean> | undefined;
  /** Time the module took to compile and instantiate, measured in the worker. */
  loadMs: number | undefined;
  /** Size of the module's linear memory after the last answered request. */
  memoryBytes: number | undefined;

  constructor(private readonly options: RustWasmKernelTransportOptions) {}

  available(): Promise<boolean> {
    this.availability ??= this.load();
    return this.availability;
  }

  async call(request: Uint8Array): Promise<ArrayBuffer> {
    await this.available();
    // The buffer's view may be a slice of a larger buffer, so it is copied rather than transferred.
    const reply = await this.send({ type: 'call', request: request.slice() });
    return reply.response as ArrayBuffer;
  }

  async abort(): Promise<void> {
    this.rejectAll(JSON.stringify({ code: 'Aborted', message: 'Kernel worker aborted' }));
    this.worker?.terminate();
    this.worker = undefined;
    this.availability = undefined;
  }

  dispose(): void {
    void this.abort();
  }

  private async load(): Promise<boolean> {
    try {
      const reply = await this.send({ type: 'load', ...(this.options.moduleUrl !== undefined ? { moduleUrl: this.options.moduleUrl } : {}) });
      this.loadMs = reply.loadMs;
      return true;
    } catch {
      this.availability = undefined;
      return false;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.onmessage = (ev: MessageEvent<RustKernelWorkerResponse>) => this.onResponse(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      // A worker that died outside any request: reject what was waiting and start over on the next request.
      this.rejectAll(JSON.stringify({ code: 'Internal', message: ev.message || 'Kernel worker crashed' }));
      this.worker = undefined;
      this.availability = undefined;
    };
    this.worker = worker;
    return worker;
  }

  private send(message: Omit<Extract<RustKernelWorkerRequest, { type: 'load' }>, 'id'> | Omit<Extract<RustKernelWorkerRequest, { type: 'call' }>, 'id'>): Promise<RustKernelWorkerResponse & { ok: true }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const envelope = { id, ...message } as RustKernelWorkerRequest;
      this.ensureWorker().postMessage(envelope, envelope.type === 'call' ? [envelope.request.buffer as ArrayBuffer] : []);
    });
  }

  private onResponse(reply: RustKernelWorkerResponse): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok) {
      if (reply.memoryBytes !== undefined) this.memoryBytes = reply.memoryBytes;
      pending.resolve(reply);
    } else {
      pending.reject(reply.error);
    }
  }

  private rejectAll(cause: string): void {
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
  }
}
