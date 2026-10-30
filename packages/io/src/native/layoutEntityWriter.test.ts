// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutTable, createLinearDimension, createAngularDimension } from '@pushform/layout';
import type { LayoutEntity } from '@pushform/layout';
import { streamNativeLayoutEntity, NativeLayoutAssetCatalog, encodeNativeLayoutEntityRecord, decodeNativeLayoutEntityRecord, decodeNativeLayoutEntityHeader } from './layoutEntityWriter';
import type { NativeLayoutEntityOutput } from './layoutEntityWriter';
import { decodeNativeLayoutText } from './layoutText';
import { decodeNativeLayoutLinearDimension, decodeNativeLayoutAngularDimension } from './layoutDimension';
import { decodeNativeLayoutTableHeader, decodeNativeLayoutTableCell, assembleNativeLayoutTable } from './layoutTable';
import { decodeNativeLayoutImage } from './layoutImage';
import { readNativeLayoutGeometry, materializeNativeLayoutGeometry } from './layoutGeometry';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { decodeNativeChunks } from './chunks';
const schema = protobuf.parse(readFileSync(new URL('./layoutEntity.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutEntityRecord');
function base(kind: LayoutEntity['kind']): LayoutEntity { return { id: 50, kind, layerId: 2, points: [[-0, 0], [10, 0], [10, 10], [0, 10]], closed: true, name: 'Object' }; }
async function collect(value: LayoutEntity, assets = new NativeLayoutAssetCatalog()) {
  let id = 1; const outputs: NativeLayoutEntityOutput[] = [];
  for await (const item of streamNativeLayoutEntity(value, assets, () => id++, { pageBytes: 16 })) outputs.push(item);
  return { outputs, assets, records: outputs.flatMap(o => o.type === 'record' ? [decodeNativeLayoutEntityRecord(encodeNativeLayoutEntityRecord(o.record))] : []),
    chunks: outputs.flatMap(o => o.type === 'chunk' ? [o.chunk] : []) };
}
it('writes all seven entity kinds with owned typed payloads and a complete header', async () => {
  for (const kind of ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'table'] as const) {
    const value = base(kind);
    if (kind === 'text' || kind === 'label') value.text = createLayoutTable(1, 1).cells[0]!.text;
    if (kind === 'dimension') value.dimension = createLinearDimension();
    if (kind === 'angular-dimension') value.angularDimension = createAngularDimension();
    if (kind === 'image') value.image = { src: 'data:image/png;base64,AQID' };
    if (kind === 'table') value.table = createLayoutTable(2, 2);
    const result = await collect(value), header = decodeNativeLayoutEntityHeader(result.records[0]!.payload!);
    expect(header.metadata.value).toEqual({ id: 50, kind, layerId: 2, name: 'Object' });
    expect(header.geometry.columns.points.count).toBe(8);
    expect(result.records.every(r => r.ownerId === value.id)).toBe(true);
    for (const r of result.records) {
      const bytes = encodeNativeLayoutEntityRecord(r); expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
      if (r.kind === 'text') expect(decodeNativeLayoutText(r.payload!).value).toEqual(value.text);
      if (r.kind === 'dimension') expect(decodeNativeLayoutLinearDimension(r.payload!).value).toEqual(value.dimension);
      if (r.kind === 'angularDimension') expect(decodeNativeLayoutAngularDimension(r.payload!).value).toEqual(value.angularDimension);
      if (r.kind === 'image') expect(decodeNativeLayoutImage(r.payload!).assetId).toBe(1);
      if (r.kind === 'table') expect(assembleNativeLayoutTable(decodeNativeLayoutTableHeader(r.payload!).value, result.records.filter(r => r.kind === 'tableCell').map(r => decodeNativeLayoutTableCell(r.payload!))).value).toEqual(value.table);
    }
    expect(header.payloads).toEqual(result.records.slice(1).filter(r => r.kind !== 'tableCell').map(r => r.kind));
  }
});
it('retains geometry as streamed columns before the entity header', async () => {
  const source = base('path'); source.handles = [{ out: [3, 4] }, {}, {}, {}];
  const result = await collect(source), header = decodeNativeLayoutEntityHeader(result.records[0]!.payload!), budget = new NativeColumnBudget();
  const entries = result.chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const c = result.chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  const geometry = materializeNativeLayoutGeometry(await readNativeLayoutGeometry(header.geometry, reader));
  expect(geometry).toEqual({ points: source.points, closed: source.closed, handles: source.handles }); expect(budget.usedBytes).toBe(84);
  expect(result.outputs[0]!.type).toBe('chunk');
});
it('streams 10,000 table cells separately instead of accumulating one table record', async () => {
  const source = base('table'); source.table = createLayoutTable(100, 100); let records = 0, cells = 0, id = 1;
  for await (const output of streamNativeLayoutEntity(source, new NativeLayoutAssetCatalog(), () => id++)) {
    if (output.type !== 'record') continue; records++; if (output.record.kind === 'tableCell') cells++;
    expect(encodeNativeLayoutEntityRecord(output.record).length).toBeLessThan(2048);
  }
  expect(records).toBe(10002); expect(cells).toBe(10000);
});
it('preserves explicit undefined payloads and deduplicates assets by exact source and representation', async () => {
  const source = base('path'), keys = ['table', 'image', 'dimension', 'angularDimension', 'text', 'labelAnchor', 'modelAnnotation', 'preservedModelConnections'];
  for (const key of keys) Object.defineProperty(source, key, { value: undefined, enumerable: true });
  const result = await collect(source); expect(decodeNativeLayoutEntityHeader(result.records[0]!.payload!).payloads).toEqual(keys);
  expect(result.records.slice(1).every(r => r.payload === undefined)).toBe(true);
  const assets = new NativeLayoutAssetCatalog(), image = { ...base('image'), image: { src: 'data:image/png;base64,AQID' } };
  await collect(image, assets); await collect({ ...image, id: 51 }, assets); expect(assets.size).toBe(1);
  expect(assets.register(image.image.src, 'text')).toBe(2); expect(assets.register(image.image.src, 'text')).toBe(2);
  expect([...assets.entries()].map(e => e.kind)).toEqual(['image', 'text']);
});
it('retains envelope extensions, rejects ambiguous envelopes and cancels at entity boundaries', async () => {
  const value = { ownerId: 1, kind: 'text' as const, payload: undefined, unknownFields: [new Uint8Array([0x98, 6, 7])] };
  const bytes = encodeNativeLayoutEntityRecord(value), next = decodeNativeLayoutEntityRecord(bytes); bytes.fill(0); expect(next).toEqual(value);
  for (const v of [{ ownerId: 0, kind: 0, state: 1, payload: new Uint8Array() }, { ownerId: 1, kind: 0, state: 0 },
    { ownerId: 1, kind: 10, state: 1, payload: new Uint8Array() }, { ownerId: 1, kind: 5, state: 0, payload: new Uint8Array() }]) {
    expect(() => decodeNativeLayoutEntityRecord(schema.encode(v).finish())).toThrow();
  }
  const controller = new AbortController(); controller.abort();
  const stream = streamNativeLayoutEntity(base('path'), new NativeLayoutAssetCatalog(), () => 1, { signal: controller.signal });
  await expect(stream.next()).rejects.toThrow();
});

it('shares assets only when both content and extension envelopes match exactly', () => {
  const assets = new NativeLayoutAssetCatalog(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])];
  const plain = assets.register('same', 'image');
  const first = assets.register('same', 'image', { unknownFields: a, envelopeUnknown: b });
  const second = assets.register('same', 'image', { unknownFields: a, envelopeUnknown: a });
  expect(new Set([plain, first, second]).size).toBe(3);
  expect(assets.register('same', 'image', { unknownFields: a.map(bytes => bytes.slice()), envelopeUnknown: b.map(bytes => bytes.slice()) })).toBe(first);
  expect(assets.register('same', 'image')).toBe(plain);
  expect(assets.register('same', 'image', { unknownFields: [], envelopeUnknown: [] })).toBe(plain);
  expect(assets.size).toBe(3);
});
