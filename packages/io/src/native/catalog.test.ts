// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { MaterialId, TagId, StyleId } from '@pushform/core';
import { createDefaultMaterial, createDefaultStyle } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { encodeNativeCatalogEntry, decodeNativeCatalogEntry, encodeNativeCatalogChunks, decodeNativeCatalogChunks } from './catalog';
import type { NativeCatalogEntry } from './catalog';
const schema = protobuf.parse(readFileSync(new URL('./catalog.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.CatalogRecord');
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result; }
describe('streamed native catalogs', () => {
  it('round trips different model record types through shared compressed pages', async () => {
    const entries: NativeCatalogEntry[] = [
      { kind: 'material', value: createDefaultMaterial(1 as MaterialId) },
      { kind: 'tag', value: { id: 2 as TagId, name: 'Walls', visible: false, color: [0.2, 0.3, 0.4], dashes: '', folderId: null } },
      { kind: 'style', value: createDefaultStyle(3 as StyleId) },
    ];
    const chunks = await collect(encodeNativeCatalogChunks(entries, { pageBytes: 128 })), decoded = await collect(decodeNativeCatalogChunks(chunks));
    expect(decoded.map(record => record.kind)).toEqual(entries.map(record => record.kind));
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]!, b = decoded[i]!; if (a.kind === 'unknown' || b.kind === 'unknown') throw new Error('Unexpected unknown record');
      expect(b.value).toEqual(a.value);
      const bytes = encodeNativeCatalogEntry(a); expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves unknown optional payloads and envelope fields with independent ownership', () => {
    const entry: NativeCatalogEntry = { kind: 'unknown', wireKind: 99, schemaMajor: 2, required: false, payload: new Uint8Array([7, 8]), envelopeUnknown: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeNativeCatalogEntry(entry), decoded = decodeNativeCatalogEntry(bytes); bytes.fill(0);
    expect(decoded).toEqual(entry); expect(decodeNativeCatalogEntry(encodeNativeCatalogEntry(decoded))).toEqual(entry);
  });
  it('rejects unknown required kinds and future required schemas before interpreting payloads', () => {
    for (const [kind, schemaMajor] of [[99, 1], [1, 2]])
      expect(() => decodeNativeCatalogEntry(schema.encode({ kind, schemaMajor, required: true, payload: new Uint8Array([255]) }).finish())).toThrow('Unsupported required');
    expect(() => decodeNativeCatalogEntry(schema.encode({ kind: 1, schemaMajor: 1, required: false, payload: new Uint8Array([255]) }).finish())).toThrow();
  });
});
