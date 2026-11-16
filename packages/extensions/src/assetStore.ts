// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ASSET_LIMITS, ExtensionError, assetDescriptionSchema, type AssetDescription, type AssetDescriptor, type AssetPage } from '@pushform/extension-protocol';
export interface StoredExtensionAsset { asset: AssetDescriptor; bytes: Uint8Array }
/** A durable account/device adapter. Namespace is supplied only by trusted host code. */
export interface ExtensionAssetStore {
  list(extensionId: string, after: string | null, limit: number): Promise<AssetPage>;
  read(extensionId: string, key: string, signal?: AbortSignal): Promise<StoredExtensionAsset | null>;
  put(extensionId: string, description: AssetDescription, bytes: Uint8Array, expectedRevision: number | null, signal?: AbortSignal): Promise<AssetDescriptor>;
  remove(extensionId: string, key: string, expectedRevision: number): Promise<boolean>;
  clear(extensionId: string): Promise<void>;
}
export function assetConflict(): never { throw new ExtensionError('revision.stale', 'This saved asset changed. Read it again before replacing or removing it.'); }
export function assetQuota(rows: readonly { extensionId: string; asset: AssetDescriptor }[], extensionId: string, description: AssetDescription): void {
  const remaining = rows.filter(row => row.extensionId !== extensionId || row.asset.key !== description.key), own = remaining.filter(row => row.extensionId === extensionId);
  if (own.length + 1 > ASSET_LIMITS.extensionCount || remaining.length + 1 > ASSET_LIMITS.accountCount ||
    own.reduce((sum, row) => sum + row.asset.byteLength, 0) + description.byteLength > ASSET_LIMITS.extensionBytes ||
    remaining.reduce((sum, row) => sum + row.asset.byteLength, 0) + description.byteLength > ASSET_LIMITS.accountBytes)
    throw new ExtensionError('limit.exceeded', 'The saved extension asset quota is full. Remove unused libraries or presets first.');
}
/** In-memory adapter for tests; production hosts must choose explicit durable storage. */
export function memoryAssetStore(): ExtensionAssetStore {
  const rows = new Map<string, Map<string, StoredExtensionAsset>>();
  let revision = 0;
  return {
    async list(id, after, limit) {
      const found = [...rows.get(id)?.values() ?? []].map(row => row.asset).filter(asset => after === null || asset.key > after).sort((a,b) => a.key < b.key ? -1 : a.key === b.key ? 0 : 1);
      return { entries: structuredClone(found.slice(0,limit)), next: found.length > limit ? found[limit - 1]!.key : null };
    },
    async read(id, key, signal) { signal?.throwIfAborted(); return structuredClone(rows.get(id)?.get(key) ?? null); },
    async put(id, description, bytes, expected, signal) {
      signal?.throwIfAborted();
      description = assetDescriptionSchema.parse(description);
      if (description.byteLength !== bytes.byteLength) throw new ExtensionError('validation.failed', 'The saved asset byte count does not match its description.');
      const namespace = rows.get(id) ?? new Map<string, StoredExtensionAsset>();
      if ((namespace.get(description.key)?.asset.revision ?? null) !== expected) assetConflict();
      assetQuota([...rows].flatMap(([extensionId, entries]) => [...entries.values()].map(row => ({ extensionId, asset: row.asset }))), id, description);
      revision++;
      const asset = { ...structuredClone(description), revision, updatedAt: new Date().toISOString() };
      namespace.set(description.key, { asset, bytes: bytes.slice() }); rows.set(id, namespace); return structuredClone(asset);
    },
    async remove(id, key, expected) {
      const current = rows.get(id)?.get(key); if (!current) return false;
      if (current.asset.revision !== expected) assetConflict();
      rows.get(id)!.delete(key); return true;
    },
    async clear(id) { rows.delete(id); },
  };
}
