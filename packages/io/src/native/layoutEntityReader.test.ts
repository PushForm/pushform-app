// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutTable, createLinearDimension, createAngularDimension } from '@pushform/layout';
import type { LayoutEntity } from '@pushform/layout';
import type { Id } from '@pushform/core';
import { streamNativeLayoutEntity, NativeLayoutAssetCatalog, encodeNativeLayoutEntityRecord, decodeNativeLayoutEntityRecord } from './layoutEntityWriter';
import type { NativeLayoutEntityRecord } from './layoutEntityWriter';
import { readNativeLayoutEntity, materializeNativeLayoutEntity } from './layoutEntityReader';
import { streamNativeLayoutAsset, readNativeLayoutAsset, materializeNativeLayoutAsset } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
import type { NativeStoredChunk } from './container';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
import { encodeNativeLayoutText } from './layoutText';
function fixture(kind: LayoutEntity['kind']): LayoutEntity {
  const value: LayoutEntity = { id: 50, layerId: 2, kind, points: [[-0, 0], [10, 0], [10, 10], [0, 10]], closed: true, hidden: false, name: 'Object',
    groupId: 90, nestedGroupIds: [91], style: { strokeColor: '#123456', strokeWeightPt: 1.25, fillColor: null, strokeDashMm: [1, 2] } };
  if (kind === 'text' || kind === 'label') value.text = createLayoutTable(1, 1).cells[0]!.text;
  if (kind === 'dimension') { value.dimension = createLinearDimension(); value.points.pop(); }
  if (kind === 'angular-dimension') value.angularDimension = createAngularDimension();
  if (kind === 'image') value.image = { src: 'data:image/png;base64,AQID', clip: { points: [[0, 0], [1, 0], [1, 1]], handles: [{}, {}, {}] } };
  if (kind === 'table') value.table = createLayoutTable(3, 3);
  return value;
}
async function stored(source: LayoutEntity) {
  let id = 1; const catalog = new NativeLayoutAssetCatalog(), chunks: NativeStoredChunk[] = [], records: NativeLayoutEntityRecord[] = [];
  for await (const output of streamNativeLayoutEntity(source, catalog, () => id++, { pageBytes: 16 })) {
    if (output.type === 'chunk') chunks.push(output.chunk); else records.push(decodeNativeLayoutEntityRecord(encodeNativeLayoutEntityRecord(output.record)));
  }
  const references = [];
  for (const entry of catalog.entries()) {
    const stream = streamNativeLayoutAsset(entry.source, entry.kind, () => id++, { pageBytes: 16 });
    let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
    references.push({ id: entry.id, value: step.value });
  }
  const budget = new NativeColumnBudget(), entries = chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const columns = new NativeColumnReader({ entries, read: async entry => {
    const c = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  const assets = new Map<number, NativeLayoutAsset>(), strings = new Map<number, string>();
  for (const r of references) { const a = await readNativeLayoutAsset(r.value, columns); assets.set(r.id, a); strings.set(r.id, materializeNativeLayoutAsset(a)); }
  return { records, columns, budget, assets, strings };
}
it('round trips all seven complete entity kinds from real streamed numeric and asset chunks', async () => {
  for (const kind of ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'table'] as const) {
    const source = fixture(kind), s = await stored(source);
    const packed = await readNativeLayoutEntity(s.records, s.columns, s.assets);
    expect(packed.geometry.points).toBeInstanceOf(Float64Array);
    expect(materializeNativeLayoutEntity(packed, s.strings)).toEqual(source);
  }
});
it('composes model-linked annotations and opaque source connections without fetching a model', async () => {
  const source = fixture('label'); source.modelAnnotation = { status: 'unavailable', attachments: [{ viewportId: 20, source: { referenceId: 30 }, modelGuid: 'guid', anchor: { kind: 'sketchVertex', path: [80 as Id], id: 81 as Id } }], fields: { Name: 'Beam' } };
  source.preservedModelConnections = { archiveId: 'archive', originalId: 'original', snapshot: '{"opaque":true}', viewports: [{ originalId: 'view', entityId: 20 }], fields: { Name: 'Beam' } };
  const s = await stored(source), packed = await readNativeLayoutEntity(s.records, s.columns, s.assets);
  expect(materializeNativeLayoutEntity(packed, s.strings)).toEqual(source);
});
it('preserves explicit undefined payload presence and owned envelope/payload extensions', async () => {
  const source = fixture('text'); Object.defineProperty(source, 'image', { value: undefined, enumerable: true });
  const s = await stored(source), fields = [new Uint8Array([0x98, 6, 7])];
  s.records[0]!.unknownFields = fields;
  const text = s.records.find(r => r.kind === 'text')!; text.payload = encodeNativeLayoutText(source.text!, new Map([['', fields]])); text.unknownFields = fields;
  const packed = await readNativeLayoutEntity(s.records, s.columns, s.assets);
  expect(packed.extensions.get('envelope/header')).toEqual(fields); expect(packed.extensions.get('envelope/text')).toEqual(fields); expect(packed.extensions.get('text/')).toEqual(fields);
  expect(Object.hasOwn(packed, 'image')).toBe(true); expect(packed.image).toBeUndefined();
});
it('rejects missing, duplicate, unannounced and cross-owner records', async () => {
  const s = await stored(fixture('text')), text = s.records.find(r => r.kind === 'text')!;
  for (const records of [[], s.records.slice(1), s.records.slice(0, 1), [...s.records, text], [s.records[0]!, { ...text, ownerId: 99 }],
    [...s.records, { ...text, kind: 'image' as const, payload: undefined }]]) {
    await expect(readNativeLayoutEntity(records, s.columns, s.assets)).rejects.toThrow();
  }
});
it('validates complete table-cell sequences and entity semantics before installation', async () => {
  const table = await stored(fixture('table'));
  await expect(readNativeLayoutEntity(table.records.slice(0, -1), table.columns, table.assets)).rejects.toThrow();
  const badCells = [...table.records]; [badCells[2], badCells[3]] = [badCells[3]!, badCells[2]!];
  await expect(readNativeLayoutEntity(badCells, table.columns, table.assets)).rejects.toThrow();
  const source = fixture('dimension'); source.points.push([0, 0]); const invalid = await stored(source);
  const packed = await readNativeLayoutEntity(invalid.records, invalid.columns, invalid.assets);
  expect(() => materializeNativeLayoutEntity(packed, invalid.strings)).toThrow('assembly');
});
it('consumes table cells through an async iterable and cancels before geometry allocation', async () => {
  const source = fixture('table'); source.table = createLayoutTable(20, 20); const s = await stored(source); let consumed = 0;
  async function* records() { for (const r of s.records) { consumed++; yield r; } }
  const packed = await readNativeLayoutEntity(records(), s.columns, s.assets); expect(consumed).toBe(402);
  expect(materializeNativeLayoutEntity(packed, s.strings)).toEqual(source); expect(s.budget.usedBytes).toBe(64);
  const c = new AbortController(); c.abort(); const other = await stored(fixture('path'));
  await expect(readNativeLayoutEntity(other.records, other.columns, other.assets, c.signal)).rejects.toThrow(); expect(other.budget.usedBytes).toBe(0);
});
