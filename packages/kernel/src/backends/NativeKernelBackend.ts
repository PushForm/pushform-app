// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelErrorInfo, KernelRequest, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import { sendWithReupload, type KernelBackend, type MeshProvider } from './KernelBackend';
import { decodeResponse, encodeRequest } from './nativeWire';

/** The IPC to the native kernel process side: raw bytes in, raw bytes out; everything else stays in the transport. */
export interface NativeKernelTransport {
  /** Whether a native kernel exists in this build (rejects when the command is missing or unreachable). */
  available(): Promise<boolean>;
  /** One request; rejects with the error info as JSON when the native kernel fails. */
  call(request: Uint8Array): Promise<ArrayBuffer>;
  /** Stop in-flight native work and clear its cache, best effort. */
  abort(): Promise<void>;
}

interface PendingNative {
  reject: (error: Error) => void;
}

function nativeError(cause: unknown): KernelError {
  if (typeof cause === 'string') {
    try {
      const info = JSON.parse(cause) as KernelErrorInfo;
      if (typeof info.code === 'string' && typeof info.message === 'string') return KernelError.fromInfo(info);
    } catch {
      // not the native kernel's error format
    }
    return new KernelError('Internal', cause);
  }
  return cause instanceof Error ? new KernelError('Internal', cause.message) : new KernelError('Internal', String(cause));
}

export interface NativeKernelBackendOptions {
  /** Whether a failure of the native path quietly reruns the request in the worker (the default) or is returned to the caller. */
  fallback?: boolean;
}

/**
 * A kernel backend that runs every request in the Rust kernel over a binary transport (native on the desktop, WebAssembly
 * on the web). With a `worker` and `fallback` (the desktop), any failure of the Rust path, including the kernel being
 * absent from this build, quietly runs that one request in the TypeScript worker instead; each side has its own body
 * cache, filled from the same mesh provider through `ensureBody`/`sendWithReupload`. With `fallback: false`, as the web
 * opt-in uses, every request is answered by Rust and its failures reach the caller.
 */
export class NativeKernelBackend implements KernelBackend {
  private provider: MeshProvider | undefined;
  private availability: Promise<boolean> | undefined;
  private readonly pending = new Set<PendingNative>();
  /** Bumped by `abortAll`; a native call begun under an older value is treated as aborted, not as a fallback. */
  private epoch = 0;
  private disposed = false;
  private readonly fallback: boolean;

  constructor(
    private readonly worker: KernelBackend | undefined,
    private readonly transport: NativeKernelTransport,
    options: NativeKernelBackendOptions = {},
  ) {
    this.fallback = options.fallback ?? true;
  }

  async request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    const epoch = this.epoch;
    if (this.disposed) throw new KernelError('Aborted', 'NativeKernelBackend is disposed');
    const available = await this.isAvailable();
    if (epoch !== this.epoch || this.disposed) throw new KernelError('Aborted', 'Kernel worker aborted');
    if (available) {
      // The worker may hold a copy of the body from an earlier fallback; keep its cache in step with Rust's.
      if (req.type === 'release' && this.worker !== undefined) this.worker.request(req).catch(() => undefined);
      try {
        return await sendWithReupload(req, (q) => this.sendNative(q) as never, this.provider);
      } catch (cause) {
        // Nothing of the failed attempt is kept: an aborted request stays aborted, anything else is rerun in the worker.
        if (epoch !== this.epoch || !this.fallback) throw cause;
      }
    } else if (!this.fallback) {
      throw new KernelError('Internal', 'The kernel module is unavailable');
    }
    if (this.worker === undefined) throw new KernelError('Internal', 'The kernel module is unavailable');
    return this.worker.request(req);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
    this.worker?.setMeshProvider?.(provider);
  }

  abortAll(): void {
    this.epoch++;
    this.rejectPending(new KernelError('Aborted', 'Kernel worker aborted'));
    this.transport.abort().catch(() => undefined);
    this.worker?.abortAll();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.rejectPending(new KernelError('Aborted', 'Kernel worker disposed'));
    this.transport.abort().catch(() => undefined);
    this.worker?.dispose();
  }

  /** Whether the native kernel is usable; `false` is remembered, a transport failure is asked again next time. */
  private isAvailable(): Promise<boolean> {
    this.availability ??= this.transport.available().catch(() => {
      this.availability = undefined;
      return false;
    });
    return this.availability;
  }

  private sendNative<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    if (this.disposed) return Promise.reject(new KernelError('Aborted', 'NativeKernelBackend is disposed'));
    let bytes: Uint8Array;
    try {
      bytes = encodeRequest(req);
    } catch (e) {
      // Bad request parameters (hardware options fail validation in the encoder): the same `Internal` error the kernel reports.
      return Promise.reject(e instanceof KernelError ? e : new KernelError('Internal', e instanceof Error ? e.message : String(e)));
    }
    return new Promise((resolve, reject) => {
      const entry: PendingNative = { reject };
      this.pending.add(entry);
      this.transport.call(bytes).then(
        (buffer) => {
          if (!this.pending.delete(entry)) return;
          try {
            resolve(decodeResponse(req, buffer));
          } catch (e) {
            reject(e instanceof Error ? e : new KernelError('Internal', String(e)));
          }
        },
        (cause: unknown) => {
          if (this.pending.delete(entry)) reject(nativeError(cause));
        },
      );
    });
  }

  private rejectPending(error: KernelError): void {
    for (const entry of this.pending) entry.reject(error);
    this.pending.clear();
  }
}
