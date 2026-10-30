// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createDocumentState } from '@pushform/model';
import type { ImageId, TagFolderId } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { NativeCatalogStore, readNativeCatalogStore } from './catalogStore';
import { encodeNativeCatalogChunks, decodeNativeCatalogChunks, encodeNativeCatalogEntry, decodeNativeCatalogEntry } from './catalog';
import type { NativeCatalogEntry } from './catalog';

describe('native catalog assembly', () => {
  it('streams directly into catalog Maps and rejects duplicate owners before replacement', async () => {
    const state = createDocumentState(), seed = new NativeCatalogStore();
    const entries = [...seed.entries(state, () => { throw new Error('Unexpected image'); })];
    entries.push({ kind: 'tagFolder', value: { id: 99 as TagFolderId, name: 'Folder', parentId: null, visible: true } });
    entries.push({ kind: 'image', value: { asset: { id: 100 as ImageId, name: 'Image', mime: 'image/png', width: 1, height: 1, sha256: 'hash' }, unknownFields: [] } });
    const store = await readNativeCatalogStore(decodeNativeCatalogChunks(encodeNativeCatalogChunks(entries, { pageBytes: 128 })));
    expect(store.values.materials).toEqual(state.materials);
    expect(store.values.tags).toEqual(state.tags);
    expect(store.values.styles).toEqual(state.styles);
    expect(store.values.tagFolders.size).toBe(1); expect(store.values.images.size).toBe(1);
    for (const entry of entries) expect(() => store.add(entry)).toThrow('Duplicate');
    expect(store.values.materials).toEqual(state.materials);
  });

  it('retains unknown fields across known-owner edits and omits deleted owners', async () => {
    const state = createDocumentState(), material = state.materials.get(state.defaultMaterialId)!;
    const extension = new Uint8Array([0x98, 6, 7]);
    const entry: NativeCatalogEntry = { kind: 'material', value: material, required: false, envelopeUnknown: [extension], extensions: new Map([['', [extension]]]) };
    const store = await readNativeCatalogStore([decodeNativeCatalogEntry(encodeNativeCatalogEntry(entry))]);
    store.values.materials.set(material.id, { ...material, name: 'Edited' });
    const restored = decodeNativeCatalogEntry(encodeNativeCatalogEntry([...store.entries(store.values, id => store.imageRecord(id))][0]!));
    expect(restored).toEqual({ ...entry, value: { ...material, name: 'Edited' } });
    store.values.materials.delete(material.id);
    expect([...store.entries(store.values, id => store.imageRecord(id))]).toEqual([]);
    // Restoring an owner (e.g. undo) can reuse its stable-ID extension without retaining its old value.
    store.values.materials.set(material.id, material);
    expect(decodeNativeCatalogEntry(encodeNativeCatalogEntry([...store.entries(store.values, id => store.imageRecord(id))][0]!))).toEqual(entry);
  });

  it('uses newly assigned asset payload references while preserving image extensions', () => {
    const id = 20 as ImageId, store = new NativeCatalogStore(), extension = new Uint8Array([0x98, 6, 7]);
    const asset = { id, name: 'Image', mime: 'image/png', width: 1, height: 1, sha256: 'hash' };
    store.add({ kind: 'image', value: { asset, payload: { chunks: [3], byteLength: 9 }, unknownFields: [extension] } });
    expect(store.imageRecord(id).payload?.chunks).toEqual([3]);
    const entries = [...store.entries(store.values, () => ({ asset, payload: { chunks: [100], byteLength: 9 }, unknownFields: [] }))];
    expect(entries).toEqual([{ kind: 'image', value: { asset, payload: { chunks: [100], byteLength: 9 }, unknownFields: [extension] } }]);
  });

  it('preserves optional unknown records and never returns partial staging on stream failure', async () => {
    const unknown: NativeCatalogEntry = { kind: 'unknown', wireKind: 90, schemaMajor: 1, required: false, payload: new Uint8Array([1]) };
    const store = await readNativeCatalogStore([unknown]);
    expect([...store.entries(store.values, id => store.imageRecord(id))]).toEqual([unknown]);
    async function* failed() { yield unknown; throw new Error('truncated stream'); }
    await expect(readNativeCatalogStore(failed())).rejects.toThrow('truncated stream');
  });
});
