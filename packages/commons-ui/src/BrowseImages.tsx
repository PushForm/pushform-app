// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { CatalogModel } from '@pushform/cloud';
import { commonsImageSources } from './modelImages';

type ImageState = { status: 'loading' | 'error' } | { status: 'ready'; src: string };
interface Entry { state: ImageState; bytes: number; users: number }
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 8;

/** One browse session owns these transient URLs; no HTTP cache or persistent storage is required. */
export class BrowseImageCache {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private queue: string[] = [];
  private controller = new AbortController();
  private active = 0;
  private bytes = 0;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly get = (url: string | undefined) => url ? this.entries.get(url)?.state : undefined;
  private notify() { for (const listener of this.listeners) listener(); }
  retain(url: string) {
    const entry = this.entries.get(url);
    if (entry) entry.users++;
    return () => { if (entry) entry.users--; };
  }
  prefetch(models: CatalogModel[], filesUrl?: string) {
    if (this.controller.signal.aborted) return;
    for (const model of models) {
      const url = commonsImageSources(model, filesUrl)[0];
      if (!url || this.entries.has(url)) continue;
      this.entries.set(url, { state: { status: 'loading' }, bytes: 0, users: 0 });
      this.queue.push(url);
    }
    this.notify(); this.pump();
  }
  private pump() {
    while (!this.controller.signal.aborted && this.active < CONCURRENCY && this.queue.length) {
      const url = this.queue.shift()!; this.active++;
      void this.load(url).finally(() => { this.active--; this.pump(); });
    }
  }
  private makeRoom(size: number) {
    for (const [url, entry] of this.entries) {
      if (this.bytes + size <= MAX_BYTES) break;
      if (entry.users || entry.state.status !== 'ready') continue;
      URL.revokeObjectURL(entry.state.src); this.bytes -= entry.bytes; this.entries.delete(url);
    }
    return this.bytes + size <= MAX_BYTES;
  }
  private async load(url: string) {
    const entry = this.entries.get(url)!;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
    let src: string | undefined;
    try {
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', priority: 'low' });
      const type = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (!response.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type) || !response.body) throw new Error('Image is not ready');
      const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      try {
        for (;;) {
          const result = await reader.read(); if (result.done) break;
          size += result.value.byteLength;
          if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('Image is too large'); }
          chunks.push(new Uint8Array(result.value));
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      if (!this.makeRoom(size)) throw new Error('Image cache is full');
      src = URL.createObjectURL(new Blob(chunks, { type }));
      const image = new Image(); image.src = src;
      const abort = () => { image.removeAttribute('src'); };
      signal.addEventListener('abort', abort, { once: true });
      try { await image.decode(); } finally { signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      // Other decodes may have finished while this one was pending.
      if (!this.makeRoom(size)) throw new Error('Image cache is full');
      entry.state = { status: 'ready', src }; entry.bytes = size; this.bytes += size; src = undefined;
    } catch {
      if (src) URL.revokeObjectURL(src);
      entry.state = { status: 'error' };
    }
    if (!this.controller.signal.aborted) this.notify();
  }
  dispose() {
    this.controller.abort(); this.queue = [];
    for (const entry of this.entries.values()) if (entry.state.status === 'ready') URL.revokeObjectURL(entry.state.src);
    this.entries.clear(); this.bytes = 0;
  }
}
const Context = createContext<BrowseImageCache | null>(null);
export const BrowseImagesProvider = Context.Provider;
const noSubscribe = () => () => {};
export function usePrefetchedImage(url: string | undefined): ImageState | undefined {
  const cache = useContext(Context);
  const state = useSyncExternalStore(cache?.subscribe ?? noSubscribe, () => cache?.get(url));
  const present = state !== undefined;
  useEffect(() => url && present ? cache?.retain(url) : undefined, [cache, url, present]);
  return state;
}
