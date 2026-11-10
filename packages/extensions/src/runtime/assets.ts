// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ASSET_LIMITS, ExtensionError, assetListSchema, assetReadSchema, assetStageSchema, assetUploadSchema, assetRemoveSchema, sha256Hex,
  NATIVE_FRAGMENT_MIME, type AssetDescription, type AssetStageResult, type AssetReadResult } from '@pushform/extension-protocol';
import type { ExtensionAssetStore, StoredExtensionAsset } from '../assetStore';
import type { ServiceImplementations } from './host';
import type { z } from 'zod';
type Upload = { description: AssetDescription; expected: number | null; bytes: Uint8Array; received: number; expires: number; committing: boolean };
const invalid = (message: string): never => { throw new ExtensionError('validation.failed', message); };
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, input: unknown): T {
  const result = schema.safeParse(input); if (!result.success) return invalid('The asset request is invalid or exceeds its resource limits.'); return result.data;
}

/** Session-owned transfers over an explicitly durable, account/extension-scoped host store. */
export class ExtensionAssetHost {
  private readonly uploads = new Map<string, Upload>();
  private cache: (StoredExtensionAsset & { expires: number }) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private readonly extensionId: string, private readonly storage: ExtensionAssetStore | null, private readonly now = () => Date.now()) {}
  services(): ServiceImplementations {
    return {
      'assets.list': async (input, call) => { this.live(call.signal); const parsed = parse(assetListSchema, input ?? {}); return this.store().list(this.extensionId, parsed.after, parsed.limit); },
      'assets.read': (input, call) => this.read(parse(assetReadSchema, input), call.signal),
      'assets.stage': (input, call) => { this.live(call.signal); this.store(); return this.stage(parse(assetStageSchema, input)); },
      'assets.commit': (input, call) => this.commit(parse(assetUploadSchema, input).upload, call.signal),
      'assets.discard': (input, call) => {
        this.live(call.signal); const handle = parse(assetUploadSchema, input).upload, upload = this.uploads.get(handle);
        if (upload?.committing) throw new ExtensionError('unavailable', 'An atomic asset commit is already in progress.');
        this.uploads.delete(handle); this.reap(); return null;
      },
      'assets.remove': async (input, call) => {
        this.live(call.signal); const parsed = parse(assetRemoveSchema, input);
        const result = await this.store().remove(this.extensionId, parsed.key, parsed.expectedRevision);
        if (this.cache?.asset.key === parsed.key) this.cache = null; this.reap(); return result;
      },
    };
  }
  dispose(): void { this.disposed = true; this.uploads.clear(); this.cache = null; if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private store(): ExtensionAssetStore {
    if (!this.storage) throw new ExtensionError('unavailable', 'Durable extension asset storage is unavailable. Nothing will be saved only in memory.');
    return this.storage;
  }
  private live(signal: AbortSignal): void { signal.throwIfAborted(); if (this.disposed) throw new ExtensionError('cancelled', 'The extension asset session has ended.'); }
  private async read(input: z.infer<typeof assetReadSchema>, signal: AbortSignal): Promise<AssetReadResult> {
    this.live(signal); this.reap();
    if (!this.cache || this.cache.asset.key !== input.key || this.cache.asset.revision !== input.expectedRevision) {
      const loaded = await this.store().read(this.extensionId, input.key, signal); this.live(signal);
      if (!loaded) throw new ExtensionError('unavailable', 'This saved asset no longer exists. Refresh the library list.');
      if(loaded.asset.contentType===NATIVE_FRAGMENT_MIME)throw new ExtensionError('permission.denied','Native module contents remain host-owned. Use the native module services to preview or place them.');
      if (loaded.asset.revision !== input.expectedRevision) throw new ExtensionError('revision.stale', 'The saved asset changed. Refresh its preview.');
      if (loaded.bytes.byteLength !== loaded.asset.byteLength || loaded.bytes.byteLength > ASSET_LIMITS.blobBytes || await sha256Hex(loaded.bytes) !== loaded.asset.sha256)
        return invalid('The saved asset is incomplete or failed its content checksum.');
      this.live(signal); this.cache = { ...loaded, expires: this.now() + ASSET_LIMITS.lifetimeMs };
    }
    const cached = this.cache;
    if (input.offset > cached.bytes.length) return invalid('The asset offset exceeds its byte count.');
    const end = Math.min(cached.bytes.length, input.offset + input.limit); this.reap();
    return { asset: structuredClone(cached.asset), bytes: cached.bytes.slice(input.offset,end), next: end < cached.bytes.length ? end : null };
  }
  private stage(input: z.infer<typeof assetStageSchema>): AssetStageResult {
    if(input.description?.contentType===NATIVE_FRAGMENT_MIME)return invalid('Native module assets are written only by the native module services.');
    this.reap(); let handle = input.upload, upload: Upload;
    if (handle) {
      const found = this.uploads.get(handle); if (!found) return invalid('This asset upload is unavailable or expired.'); upload = found;
      if (input.description || input.expectedRevision !== undefined) return invalid('An asset upload cannot change its captured description or revision.');
    } else {
      if (!input.description || input.expectedRevision === undefined || input.offset !== 0) return invalid('A new asset upload needs its description, expected revision and offset zero.');
      if (this.uploads.size >= ASSET_LIMITS.uploads || [...this.uploads.values()].reduce((sum,row) => sum + row.bytes.length,0) + input.description.byteLength > ASSET_LIMITS.stagingBytes)
        throw new ExtensionError('limit.exceeded', 'Asset staging is full. Finish or discard another transfer.');
      handle = `asset_${crypto.randomUUID().replaceAll('-','')}`;
      upload = { description: structuredClone(input.description), expected: input.expectedRevision, bytes: new Uint8Array(input.description.byteLength), received: 0, expires: this.now() + ASSET_LIMITS.lifetimeMs, committing: false };
      this.uploads.set(handle,upload);
    }
    if (upload.committing || input.offset !== upload.received || upload.received + input.bytes.length > upload.bytes.length) {
      if (!input.upload) this.uploads.delete(handle); this.reap(); return invalid('Asset chunks must be sequential and fit the declared size.');
    }
    upload.bytes.set(input.bytes, upload.received); upload.received += input.bytes.length; this.reap();
    return { upload: handle, received: upload.received, complete: upload.received === upload.bytes.length };
  }
  private async commit(handle: string, signal: AbortSignal) {
    this.live(signal); this.reap(); const upload = this.uploads.get(handle);
    if (!upload || upload.committing || upload.received !== upload.bytes.length) return invalid('Commit needs one complete, available asset upload.');
    upload.committing = true;
    try {
      if (await sha256Hex(upload.bytes) !== upload.description.sha256) { this.uploads.delete(handle); return invalid('The staged asset failed its complete content checksum.'); }
      this.live(signal);
      const result = await this.store().put(this.extensionId, upload.description, upload.bytes, upload.expected, signal);
      this.uploads.delete(handle); if (this.cache?.asset.key === upload.description.key) this.cache = null;
      return result;
    } finally { upload.committing = false; this.reap(); }
  }
  private reap(): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null; if (this.disposed) return;
    const now = this.now();
    for (const [handle, upload] of this.uploads) if (!upload.committing && upload.expires <= now) this.uploads.delete(handle);
    if (this.cache && this.cache.expires <= now) this.cache = null;
    const expires = [...this.uploads.values()].filter(upload => !upload.committing).map(upload => upload.expires);
    if (this.cache) expires.push(this.cache.expires);
    if (expires.length) this.timer = setTimeout(() => this.reap(), Math.max(1, Math.min(...expires) - now));
  }
}
