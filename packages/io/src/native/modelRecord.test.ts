// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { DefId, Id } from '@pushform/core';
import { createDocumentState } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { encodeNativeModelRecord, decodeNativeModelRecord, encodeNativeModelChunks, decodeNativeModelChunks, encodeNativePropertyModelRecord } from './modelRecord';
import type { NativeModelRecord } from './modelRecord';
import { NativeCommonPropertyWriter } from './commonProperty';
import { encodeNativeRecordChunks } from './recordStream';
const schema = protobuf.parse(readFileSync(new URL('./modelRecord.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.ModelRecord');
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of input) result.push(item); return result; }
describe('unified native model records', () => {
  it('streams mixed catalogs, definitions, properties and owned instances across page boundaries', async () => {
    const state = createDocumentState(), { entities: _e, bounds: _b, ...metadata } = state.definitions.get(state.rootDefinitionId)!;
    const pool = new NativeCommonPropertyWriter(); pool.intern({ tagId: state.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} });
    const records: NativeModelRecord[] = [
      { kind: 'material', value: state.materials.get(state.defaultMaterialId)! },
      { kind: 'definition', value: { metadata, entityOrder: { count: 1, chunks: [100] }, activeSectionPlaneId: null } },
      decodeNativeModelRecord(encodeNativePropertyModelRecord(pool.encodeRecord(1))),
      { kind: 'instance', ownerDefinitionId: state.rootDefinitionId, value: { properties: 1, value: { id: 10 as Id, definitionId: 20 as DefId, name: '', materialId: null,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } } },
    ];
    const decoded = await collect(decodeNativeModelChunks(encodeNativeModelChunks(records, { pageBytes: 31 })));
    expect(decoded.map(record => record.kind)).toEqual(records.map(record => record.kind));
    for (let i = 0; i < records.length; i++) {
      const bytes = encodeNativeModelRecord(records[i]!);
      expect(encodeNativeModelRecord(decoded[i]!)).toEqual(bytes);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves optional opaque records, owner scope and extension ownership', () => {
    const record: NativeModelRecord = { kind: 'unknown', wireKind: 90, schemaMajor: 2, required: false, ownerDefinitionId: 42 as DefId,
      payload: new Uint8Array([255, 0]), envelopeUnknown: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeNativeModelRecord(record), decoded = decodeNativeModelRecord(bytes); bytes.fill(0); expect(decoded).toEqual(record);
    expect(decodeNativeModelRecord(encodeNativeModelRecord(decoded))).toEqual(record);
  });
  it('rejects missing or forbidden owners and unknown required kinds before payload decoding', async () => {
    for (const record of [
      { kind: 9, schemaMajor: 1, required: true, payload: new Uint8Array() },
      ...[11, 12, 13, 14, 15, 16].map(kind => ({ kind, schemaMajor: 1, required: true, payload: new Uint8Array() })),
      { kind: 7, schemaMajor: 1, required: true, payload: new Uint8Array(), ownerDefinitionId: 1 },
      { kind: 1, schemaMajor: 1, required: true, payload: new Uint8Array(), ownerDefinitionId: 1 },
    ]) expect(() => decodeNativeModelRecord(schema.encode(record).finish())).toThrow('owner');
    const bytes = schema.encode({ kind: 90, schemaMajor: 1, required: true, payload: new Uint8Array([255]) }).finish();
    await expect(collect(decodeNativeModelChunks(encodeNativeRecordChunks([bytes])))).rejects.toThrow('Unsupported required');
  });
});
