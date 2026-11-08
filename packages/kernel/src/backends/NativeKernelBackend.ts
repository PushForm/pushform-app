// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { EnsureBodyRequest, KernelErrorInfo, KernelRequest, PushPullPreview, PushPullPreviewRequest, PushPullRequest, PushPullResult, ReleaseRequest, ResFor } from '../protocol';
import { KernelError } from '../protocol';
import { sendWithReupload, type KernelBackend, type MeshProvider } from './KernelBackend';
import { decodeEnsureBody, decodePushPull, decodeRelease, encodeEnsureBody, encodePushPull, encodeRelease } from './nativeWire';

/** The IPC to the native kernel process side: raw bytes in, raw bytes out; everything else stays in the transport. */
export interface NativeKernelTransport {
  /** Whether a native kernel exists in this build (rejects when the command is missing or unreachable). */
  available(): Promise<boolean>;
  /** One request; rejects with the error info as JSON when the native kernel fails. */
  call(request: Uint8Array): Promise<ArrayBuffer>;
  /** Stop in-flight native work and clear its cache, best effort. */
  abort(): Promise<void>;
}

type NativeRequest = EnsureBodyRequest | PushPullRequest | PushPullPreviewRequest | ReleaseRequest;

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

/**
 * A kernel backend for the desktop app that runs push/pull natively and everything else in the WebAssembly worker. The
 * two have separate body caches, each filled through `ensureBody`/`sendWithReupload` from the same mesh provider, so a
 * body the native side has not seen is uploaded to it on its first push/pull. Any failure of the native path (including
 * the kernel being absent from this build) quietly runs that one request in WebAssembly instead.
 */
export class NativeKernelBackend implements KernelBackend {
  private provider: MeshProvider | undefined;
  private availability: Promise<boolean> | undefined;
  private readonly pending = new Set<PendingNative>();
  /** Bumped by `abortAll`; a native call begun under an older value is treated as aborted, not as a fallback. */
  private epoch = 0;
  private disposed = false;

  constructor(
    private readonly worker: KernelBackend,
    private readonly transport: NativeKernelTransport,
  ) {}

  request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    if (req.type === 'pushPull') return this.pushPull(req as PushPullRequest | PushPullPreviewRequest) as Promise<ResFor<R>>;
    if (req.type === 'release') this.releaseNative(req);
    return this.worker.request(req);
  }

  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
    this.worker.setMeshProvider?.(provider);
  }

  abortAll(): void {
    this.epoch++;
    this.rejectPending(new KernelError('Aborted', 'Kernel worker aborted'));
    this.transport.abort().catch(() => undefined);
    this.worker.abortAll();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.rejectPending(new KernelError('Aborted', 'Kernel worker disposed'));
    this.transport.abort().catch(() => undefined);
    this.worker.dispose();
  }

  private async pushPull(req: PushPullRequest | PushPullPreviewRequest): Promise<PushPullResult | PushPullPreview> {
    const epoch = this.epoch;
    if (this.disposed) throw new KernelError('Aborted', 'NativeKernelBackend is disposed');
    if (await this.isAvailable()) {
      try {
        return await sendWithReupload(req, (q) => this.sendNative(q as NativeRequest) as never, this.provider);
      } catch (cause) {
        // Nothing of the failed attempt is kept: an aborted request stays aborted, anything else is rerun in WebAssembly.
        if (epoch !== this.epoch) throw cause;
      }
    }
    return this.worker.request(req);
  }

  /** Whether the native kernel is usable; `false` is remembered, a transport failure is asked again next time. */
  private isAvailable(): Promise<boolean> {
    this.availability ??= this.transport.available().catch(() => {
      this.availability = undefined;
      return false;
    });
    return this.availability;
  }

  private releaseNative(req: ReleaseRequest): void {
    void this.availability?.then((available) => {
      if (available) this.transport.call(encodeRelease(req)).catch(() => undefined);
    });
  }

  private sendNative(req: NativeRequest): Promise<unknown> {
    if (this.disposed) return Promise.reject(new KernelError('Aborted', 'NativeKernelBackend is disposed'));
    return new Promise((resolve, reject) => {
      const entry: PendingNative = { reject };
      this.pending.add(entry);
      const request = req.type === 'ensureBody' ? encodeEnsureBody(req) : req.type === 'release' ? encodeRelease(req) : encodePushPull(req);
      this.transport.call(request).then(
        (buffer) => {
          if (!this.pending.delete(entry)) return;
          try {
            resolve(req.type === 'ensureBody' ? decodeEnsureBody(buffer) : req.type === 'release' ? decodeRelease(buffer) : decodePushPull(buffer));
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
