// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutDocumentState } from '@pushform/layout';
import { streamNativeLayoutDocumentHeader, encodeNativeLayoutDocumentHeader, decodeNativeLayoutDocumentHeader, readNativeLayoutDocumentOrders,
  encodeNativeLayoutCustomField, decodeNativeLayoutCustomField, encodeNativeLayoutPageNumberField, decodeNativeLayoutPageNumberField } from './layoutDocument';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { decodeNativeChunks } from './chunks';
import type { NativeStoredChunk } from './container';
const root = protobuf.parse(readFileSync(new URL('./layoutDocument.proto', import.meta.url), 'utf8')).root;
async function fixture(state = createLayoutDocumentState()) {
  let id = 1; const chunks: NativeStoredChunk[] = [], stream = streamNativeLayoutDocumentHeader(state, 3, () => id++, { pageBytes: 8 });
  let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
  const value = decodeNativeLayoutDocumentHeader(encodeNativeLayoutDocumentHeader(step.value)).value;
  const budget = new NativeColumnBudget(), entries = chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const c = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  return { state, value, reader, budget };
}
it('streams all document order columns and matches catalog membership and published header schema', async () => {
  const f = await fixture(), bytes = encodeNativeLayoutDocumentHeader(f.value), schema = root.lookupType('pushform.native.LayoutDocumentHeader');
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const orders = await readNativeLayoutDocumentOrders(f.value, f.reader, f.state);
  for (const key of ['pageOrder', 'layerOrder', 'sharedEntityOrder'] as const) expect(Array.from(orders[key])).toEqual(f.state[key]);
  expect(f.budget.usedBytes).toBe((f.state.pageOrder.length + f.state.layerOrder.length + f.state.sharedEntityOrder.length) * 4);
  expect(f.value.assetCount).toBe(3);
});
it('distinguishes absent, explicitly undefined and empty optional document maps', async () => {
  for (const presence of [0, 1, 2]) {
    const state = createLayoutDocumentState(); delete state.modelArchives; delete state.pageNumberFields;
    for (const key of ['modelArchives', 'pageNumberFields']) if (presence) Object.defineProperty(state, key, { value: presence === 1 ? undefined : new Map(), enumerable: true });
    const f = await fixture(state); expect(f.value.archivesState).toBe(presence); expect(f.value.numberingState).toBe(presence);
    expect(f.value.archiveCount).toBe(0); expect(f.value.numberingCount).toBe(0);
  }
});
it('retains owned root, order and composed metadata extensions across known changes', async () => {
  const f = await fixture(), decoded = decodeNativeLayoutDocumentHeader(encodeNativeLayoutDocumentHeader(f.value)), fields = [new Uint8Array([0x98, 6, 7])];
  for (const key of ['', 'pageOrder', 'layerOrder', 'sharedEntityOrder']) decoded.extensions.records.set(key, fields);
  decoded.extensions.metadata.records.set('meta', fields); decoded.extensions.metadata.settings.set('grid', fields);
  const bytes = encodeNativeLayoutDocumentHeader(f.value, decoded.extensions), next = decodeNativeLayoutDocumentHeader(bytes); bytes.fill(0);
  next.value.metadata.settings.precision = 4;
  expect(decodeNativeLayoutDocumentHeader(encodeNativeLayoutDocumentHeader(next.value, next.extensions)).extensions).toEqual(decoded.extensions);
});
it('preserves custom fields and all page numbering styles with exact signed safe integers', () => {
  const fields = [new Uint8Array([0x98, 6, 7])];
  expect(decodeNativeLayoutCustomField(encodeNativeLayoutCustomField('__proto__', 'Authored value', fields))).toEqual({ name: '__proto__', value: 'Authored value', unknownFields: fields });
  for (const style of ['arabic', 'two-digit', 'upper-letter', 'lower-letter', 'upper-roman', 'lower-roman'] as const) for (const startPageId of [null, 123, -0]) {
    const value = { startPageId, startNumber: -9007199254740991, style }, bytes = encodeNativeLayoutPageNumberField('PageNumber', value);
    expect(decodeNativeLayoutPageNumberField(bytes).value).toEqual(value);
    const schema = root.lookupType('pushform.native.LayoutPageNumberField'); expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('rejects aliased order columns, missing members, inconsistent map states and invalid numbering', async () => {
  const f = await fixture(), invalid = structuredClone(f.value); invalid.orders.layerOrder = invalid.orders.pageOrder;
  expect(() => encodeNativeLayoutDocumentHeader(invalid)).toThrow();
  expect(() => encodeNativeLayoutDocumentHeader({ ...f.value, archivesState: 0, archiveCount: 1 })).toThrow();
  const missing = { pages: new Map([[999, {}]]), layers: f.state.layers, sharedEntities: f.state.sharedEntities };
  await expect(readNativeLayoutDocumentOrders(f.value, f.reader, missing)).rejects.toThrow();
  for (const n of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => encodeNativeLayoutPageNumberField('PageNumber', { startPageId: null, startNumber: n, style: 'arabic' })).toThrow();
  const schema = root.lookupType('pushform.native.LayoutPageNumberField'); expect(() => decodeNativeLayoutPageNumberField(schema.encode({ name: 'PageNumber', startNumber: 1, style: 6 }).finish())).toThrow();
});
