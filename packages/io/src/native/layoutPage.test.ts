// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutDocumentState } from '@pushform/layout';
import { decodeNativeLayoutPage, encodeNativeLayoutPage, streamNativeLayoutPage, readNativeLayoutPage } from './layoutPage';
import type { NativeLayoutPageRecord } from './layoutPage';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./layoutPage.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutPage');
function fixture(): NativeLayoutPageRecord {
  const source = [...createLayoutDocumentState().pages.values()][0]!;
  const { entities: _e, entityOrder: _o, ...metadata } = source;
  return { metadata, entityOrder: { count: 0, chunks: [] } };
}
it('preserves actual paper settings and all visibility presence states with schema interoperability', () => {
  for (const state of ['absent', 'undefined', 'empty', 'values']) {
    const value = fixture(); value.metadata.margin.left = -0;
    if (state === 'undefined') Object.defineProperty(value.metadata, 'layerVisibility', { value: undefined, enumerable: true });
    else if (state !== 'absent') value.metadata.layerVisibility = state === 'empty' ? new Map() : new Map([[2, false], [9, true]]);
    const bytes = encodeNativeLayoutPage(value), decoded = decodeNativeLayoutPage(bytes);
    expect(decoded.value).toEqual(value);
    expect(Object.hasOwn(decoded.value.metadata, 'layerVisibility')).toBe(state !== 'absent');
    expect(Object.is(decoded.value.metadata.margin.left, -0)).toBe(true);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('streams and validates entity order without embedding entities in metadata', async () => {
  const source = [...createLayoutDocumentState().pages.values()][0]!;
  source.entityOrder = [90, 20, 70]; source.layerVisibility = new Map([[2, false]]);
  let id = 1; const stream = streamNativeLayoutPage(source, () => id++, { pageBytes: 8 }), chunks: NativeStoredChunk[] = [];
  let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
  const value = decodeNativeLayoutPage(encodeNativeLayoutPage(step.value)).value;
  expect(Object.hasOwn(value.metadata, 'entities')).toBe(false); expect(chunks).toHaveLength(2);
  const entries = chunks.map(chunk => ({ descriptor: chunk.descriptor, offset: 0 })), budget = new NativeColumnBudget();
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const chunk = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const page of decodeNativeChunks([{ codec: chunk.descriptor.codec, decodedBytes: chunk.descriptor.decodedBytes, data: chunk.data, digest: chunk.descriptor.sha256 }])) return page;
    throw new Error('missing page');
  } }, budget);
  const layers = new Map([[2, {}]]), entities = new Map(source.entityOrder.map(id => [id, {}]));
  expect(Array.from((await readNativeLayoutPage(value, reader, layers, entities)).order)).toEqual(source.entityOrder);
  expect(budget.usedBytes).toBe(12);
  await expect(readNativeLayoutPage(value, reader, new Map(), entities)).rejects.toThrow();
  await expect(readNativeLayoutPage(value, reader, layers, new Map([[90, {}], [20, {}], [71, {}]]))).rejects.toThrow();
});
it('retains nested extensions after known edits and prunes deleted visibility owners', () => {
  const value = fixture(); value.metadata.layerVisibility = new Map([[2, false], [9, true]]);
  const fields = [new Uint8Array([0x98, 6, 7])], extensions = new Map(['', 'margin', 'entityOrder', 'layerVisibility', 'visibility/2', 'visibility/9'].map(key => [key, fields]));
  const bytes = encodeNativeLayoutPage(value, extensions), decoded = decodeNativeLayoutPage(bytes); bytes.fill(0);
  decoded.value.metadata.name = 'Renamed'; decoded.value.metadata.layerVisibility!.delete(9);
  const rewritten = decodeNativeLayoutPage(encodeNativeLayoutPage(decoded.value, decoded.extensions)); extensions.delete('visibility/9');
  expect(rewritten.extensions).toEqual(extensions); expect(rewritten.value.metadata.name).toBe('Renamed');
});
it('rejects duplicate visibility IDs, ambiguous presence, nonfinite margins and invalid chunk references', () => {
  const base = schema.toObject(schema.decode(encodeNativeLayoutPage(fixture())));
  for (const layerVisibility of [{ state: 1, entries: [{ id: 2, visible: true }, { id: 2, visible: false }] }, { state: 0, entries: [{ id: 2, visible: true }] }, { state: 3 }]) {
    expect(() => decodeNativeLayoutPage(schema.encode({ ...base, layerVisibility }).finish())).toThrow();
  }
  const value = fixture(); value.metadata.margin.top = Infinity; expect(() => encodeNativeLayoutPage(value)).toThrow();
  expect(() => encodeNativeLayoutPage({ ...fixture(), entityOrder: { count: 1, chunks: [] } })).toThrow();
  expect(() => encodeNativeLayoutPage({ ...fixture(), entityOrder: { count: 2, chunks: [1, 1] } })).toThrow();
});
