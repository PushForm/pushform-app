// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CLOUD_THUMBNAIL_LIMIT, type CloudFile, type CloudFilesApi } from '@pushform/cloud';
import { LocalThumbnailCache, type CachedThumbnail, type ThumbnailCache } from './thumbnailCache';

export const THUMBNAIL_INTERVAL_MS = 30_000;
const RETRY_MS = 30_000;
/** One resource-heavy operation at a time, including across account changes in this app. */
let serial: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = serial.then(async () => {
    // Other tabs of this origin share the resource limit where Web Locks is available.
    if (globalThis.navigator?.locks) return navigator.locks.request('pushform-thumbnail-service', work);
    return work();
  });
  serial = next.catch(() => {});
  return next;
}
export interface ThumbnailServiceOptions {
  api: CloudFilesApi;
  ownerId: string;
  /** Render a file from local document data or its saved cloud bytes, without opening a tab. */
  render: (file: CloudFile) => Promise<Uint8Array | null>;
  cache?: ThumbnailCache;
  online?: () => boolean;
  active?: () => boolean;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Cache → cloud → serial generation, with a durable outbox for generated JPEGs. */
export class ThumbnailService {
  private cache: ThumbnailCache;
  private jobs = new Map<string, Promise<Uint8Array | null>>();
  private known = new Map<string, CloudFile>();
  private failures = new Map<string, number>();
  private lastSaved = new Map<string, number>();
  private listeners = new Set<(fileId?: string) => void>();
  private enabled = true;
  private epoch = 0;
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = new Map<string, CloudFile>();
  constructor(private readonly options: ThumbnailServiceOptions) { this.cache = options.cache ?? new LocalThumbnailCache(); }
  private now = (): number => (this.options.now ?? Date.now)();
  private online = (): boolean => (this.options.online ?? (() => globalThis.navigator?.onLine !== false))();
  private active = (): boolean => this.enabled && (this.options.active?.() ?? true);
  subscribe = (listener: (fileId?: string) => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed(fileId?: string): void { for (const listener of this.listeners) listener(fileId); }
  setEnabled(value: boolean): void {
    if (this.enabled !== value) { this.enabled = value; this.epoch++; }
    clearTimeout(this.timer); this.timer = undefined;
    if (value) { void this.sync(); this.schedule(); }
  }
  dispose(): void { this.setEnabled(false); this.listeners.clear(); this.dirty.clear(); }
  private remember(file: CloudFile): CloudFile {
    const old = this.known.get(file.id);
    if (!old || file.revision_number >= old.revision_number) this.known.set(file.id, file);
    return this.known.get(file.id)!;
  }
  /** Returns image bytes, never an expiring URL. Concurrent requests for the same revision share a job. */
  async request(input: CloudFile, regenerate = false): Promise<Uint8Array | null> {
    if (!this.active()) return null;
    const epoch = this.epoch, file = this.remember(input);
    const cached = await this.cache.get(this.options.ownerId, file.id);
    if (!this.active() || epoch !== this.epoch) return null;
    if (!regenerate && cached?.revisionId === file.current_revision_id) {
      if (cached.pendingUpload && this.online()) void this.sync();
      return cached.jpeg;
    }
    const key = `${file.id}/${file.current_revision_id}`;
    const existing = this.jobs.get(key);
    if (existing) return regenerate ? existing.then(() => this.request(file, true)) : existing;
    if (!regenerate && this.now() - (this.failures.get(key) ?? -Infinity) < RETRY_MS) return cached?.jpeg ?? null;
    const valid = (): boolean => this.active() && epoch === this.epoch && this.known.get(file.id)?.current_revision_id === file.current_revision_id;
    const job = enqueue(async () => {
      if (!valid()) return null;
      // A different browser tab may have populated the shared local cache while this job waited.
      const latest = await this.cache.get(this.options.ownerId, file.id);
      if (!valid()) return null;
      if (!regenerate && latest?.revisionId === file.current_revision_id) return latest.jpeg;
      let jpeg: Uint8Array | null = null;
      if (!regenerate && this.online() && this.options.api.thumbnailUrls) {
        try {
          const urls = await this.options.api.thumbnailUrls([file.id]);
          if (!valid()) return null;
          const url = urls.get(file.id);
          if (url) {
            const response = await (this.options.fetch ?? fetch)(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
            if (response.ok && Number(response.headers.get('content-length') ?? 0) <= CLOUD_THUMBNAIL_LIMIT) {
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.length <= CLOUD_THUMBNAIL_LIMIT && bytes[0] === 0xff && bytes[1] === 0xd8) {
                // Do not persist an undecodable cloud image and permanently strand its view on an icon.
                if (typeof globalThis.createImageBitmap === 'function') {
                  const picture = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
                  picture.close();
                }
                jpeg = bytes;
              }
            }
          }
        } catch { /* Try locally available document data when the network is unavailable. */ }
      }
      if (!valid()) return null;
      const generated = !jpeg;
      if (!jpeg) jpeg = await this.options.render(file);
      if (!valid() || !jpeg?.length || jpeg.length > CLOUD_THUMBNAIL_LIMIT) return null;
      const entry: CachedThumbnail = { ownerId: this.options.ownerId, fileId: file.id, revisionId: file.current_revision_id,
        jpeg, pendingUpload: generated, touched: this.now() };
      await this.cache.put(entry);
      if (!valid()) return null;
      this.failures.delete(key);
      this.changed(file.id);
      if (generated) await this.upload(entry, valid);
      return jpeg;
    }).catch(() => null).then(result => {
      if (!result && valid()) this.failures.set(key, this.now());
      return result ?? (valid() ? cached?.jpeg ?? null : null);
    }).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
    this.jobs.set(key, job);
    return job;
  }
  /** Save notifications coalesce; a final edit during the throttle window is eventually regenerated. */
  saved(file: CloudFile): void {
    this.remember(file); this.dirty.set(file.id, file); this.schedule();
  }
  private schedule(): void {
    if (!this.active() || this.timer) return;
    let delay = Infinity;
    for (const file of this.dirty.values()) delay = Math.min(delay, Math.max(0, THUMBNAIL_INTERVAL_MS - (this.now() - (this.lastSaved.get(file.id) ?? -Infinity))));
    if (!Number.isFinite(delay)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const [id, file] of this.dirty) if (this.now() - (this.lastSaved.get(id) ?? -Infinity) >= THUMBNAIL_INTERVAL_MS) {
        this.dirty.delete(id); this.lastSaved.set(id, this.now()); void this.request(file, true);
      }
      this.schedule();
    }, delay);
  }
  private async upload(entry: CachedThumbnail, valid: () => boolean): Promise<void> {
    if (!valid() || !this.online() || !this.options.api.saveThumbnail) return;
    try {
      const head = await this.options.api.head(entry.fileId);
      if (!valid()) return;
      if (head.file.current_revision_id !== entry.revisionId) {
        // An obsolete queued upload must not replace a newer document's preview.
        const current = await this.cache.get(entry.ownerId, entry.fileId);
        if (current?.revisionId === entry.revisionId) await this.cache.put({ ...current, pendingUpload: false });
        return;
      }
      await this.options.api.saveThumbnail(entry.fileId, entry.jpeg);
      if (!valid()) return;
      const current = await this.cache.get(entry.ownerId, entry.fileId);
      if (current?.revisionId === entry.revisionId) await this.cache.put({ ...current, pendingUpload: false });
    } catch { /* Keep the outbox entry for reconnection or a later visit. */ }
  }
  reconnect(): void { this.failures.clear(); this.changed(); void this.sync(); }
  /** Called on startup/reconnection; never regenerates pixels just to retry an upload. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!this.active() || !this.online()) return Promise.resolve();
    const epoch = this.epoch, valid = (): boolean => this.active() && this.epoch === epoch;
    const pending = enqueue(async () => {
      for (const entry of await this.cache.pending(this.options.ownerId)) {
        if (!valid() || !this.online()) break;
        await this.upload(entry, valid);
      }
    }).catch(() => {}).finally(() => { if (this.syncing === pending) this.syncing = null; });
    this.syncing = pending;
    return pending;
  }
}
