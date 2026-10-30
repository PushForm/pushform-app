// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { encodeNativeLayoutArchiveHeader, decodeNativeLayoutArchiveHeader, encodeNativeLayoutArchiveModel, decodeNativeLayoutArchiveModel,
  encodeNativeLayoutArchiveViewport, decodeNativeLayoutArchiveViewport, streamNativeLayoutArchiveViewport, readNativeLayoutArchiveViewport,
  assembleNativeLayoutArchive, materializeNativeLayoutArchive } from './layoutArchive';
import type { NativeLayoutArchiveHeader } from './layoutArchive';
import type { NativeLayoutAsset } from './layoutAsset';
import type { NativeStoredChunk } from './container';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
const root = protobuf.parse(readFileSync(new URL('./layoutArchive.proto', import.meta.url), 'utf8')).root;
const asset: NativeLayoutAsset = { reference: { encoding: 1, prefix: '', byteLength: 3, chunks: [100], unknownFields: [] }, bytes: new Uint8Array([0, 1, 2]) };
const assets = new Map([[7, asset]]);
function header(): NativeLayoutArchiveHeader { return { id: 'archive', assetId: 7, modelCount: 1, viewportCount: 1, annotationConnectionsVersion: 1, unknownFields: [] }; }
async function fixture() {
  let id = 1; const chunks: NativeStoredChunk[] = [], stream = streamNativeLayoutArchiveViewport('viewport', { modelReferenceId: 'model', entityIds: [400, 9, 400] }, () => id++, { pageBytes: 8 });
  let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
  const reference = decodeNativeLayoutArchiveViewport(encodeNativeLayoutArchiveViewport(step.value)), budget = new NativeColumnBudget();
  const entries = chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const c = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  return { reference, budget, reader, viewport: await readNativeLayoutArchiveViewport(reference, reader),
    model: decodeNativeLayoutArchiveModel(encodeNativeLayoutArchiveModel({ id: 'model', value: { internalTarget: 'models/model.skp', externalTarget: 'X:\\Models\\House.skp' }, unknownFields: [] })) };
}
it('composes original archive bytes and exact source mappings without requiring deleted paper entities', async () => {
  const f = await fixture(), packed = assembleNativeLayoutArchive(header(), assets, [f.model], [f.viewport]);
  expect(packed.asset).toBe(asset); expect(f.budget.usedBytes).toBe(12);
  const value = materializeNativeLayoutArchive(packed, new Map([[7, 'AAEC']]));
  expect(value).toEqual({ format: 'sketchup-layout', archiveBase64: 'AAEC', annotationConnectionsVersion: 1,
    models: new Map([['model', f.model.value]]), viewports: new Map([['viewport', { modelReferenceId: 'model', entityIds: [400, 9, 400] }]]) });
});
it('matches each published schema and preserves unknown fields across record rewrites', async () => {
  const f = await fixture(), fields = [new Uint8Array([0x98, 6, 7])];
  const cases = [
    ['LayoutArchive', encodeNativeLayoutArchiveHeader({ ...header(), unknownFields: fields }), decodeNativeLayoutArchiveHeader, encodeNativeLayoutArchiveHeader],
    ['LayoutArchiveModel', encodeNativeLayoutArchiveModel({ ...f.model, unknownFields: fields }), decodeNativeLayoutArchiveModel, encodeNativeLayoutArchiveModel],
    ['LayoutArchiveViewport', encodeNativeLayoutArchiveViewport({ ...f.reference, unknownFields: fields }), decodeNativeLayoutArchiveViewport, encodeNativeLayoutArchiveViewport],
  ] as const;
  for (const [name, bytes, decode] of cases) {
    const schema = root.lookupType(`pushform.native.${name}`);
    // protobufjs intentionally discards the appended future field; compare the known wire prefix.
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes.subarray(0, bytes.length - fields[0]!.length)));
    const next = decode(bytes); bytes.fill(0); expect(next.unknownFields).toEqual(fields);
  }
  const next = decodeNativeLayoutArchiveModel(encodeNativeLayoutArchiveModel({ ...f.model, unknownFields: fields })); next.value.externalTarget = '';
  expect(decodeNativeLayoutArchiveModel(encodeNativeLayoutArchiveModel(next)).unknownFields).toEqual(fields);
});
it('preserves optional connection versions and null versus empty targets', () => {
  for (const state of ['absent', 'undefined', 'version']) {
    const h = header(); delete h.annotationConnectionsVersion;
    if (state !== 'absent') h.annotationConnectionsVersion = state === 'undefined' ? undefined : 1;
    const decoded = decodeNativeLayoutArchiveHeader(encodeNativeLayoutArchiveHeader(h)); expect(decoded).toEqual(h);
    expect(Object.hasOwn(decoded, 'annotationConnectionsVersion')).toBe(state !== 'absent');
  }
  for (const target of [null, '']) {
    const m = { id: '', value: { internalTarget: target, externalTarget: target }, unknownFields: [] };
    expect(decodeNativeLayoutArchiveModel(encodeNativeLayoutArchiveModel(m))).toEqual(m);
    const v = { id: '', modelReferenceId: target, entityCount: 0, entityChunks: [], unknownFields: [] };
    expect(decodeNativeLayoutArchiveViewport(encodeNativeLayoutArchiveViewport(v))).toEqual(v);
  }
});
it('rejects missing assets and incomplete, excess or duplicate owner records', async () => {
  const f = await fixture();
  expect(() => assembleNativeLayoutArchive(header(), new Map(), [f.model], [f.viewport])).toThrow();
  expect(() => assembleNativeLayoutArchive(header(), assets, [], [f.viewport])).toThrow();
  expect(() => assembleNativeLayoutArchive(header(), assets, [f.model], [])).toThrow();
  expect(() => assembleNativeLayoutArchive({ ...header(), modelCount: 2 }, assets, [f.model, f.model], [f.viewport])).toThrow();
  expect(() => assembleNativeLayoutArchive({ ...header(), viewportCount: 2 }, assets, [f.model], [f.viewport, f.viewport])).toThrow();
});
it('rejects unsupported archive versions and invalid numeric references', async () => {
  const schema = root.lookupType('pushform.native.LayoutArchive'), plain = schema.toObject(schema.decode(encodeNativeLayoutArchiveHeader(header())));
  for (const patch of [{ format: 1 }, { annotationConnectionsVersion: 2 }, { assetId: 0 }, { id: '' }]) {
    expect(() => decodeNativeLayoutArchiveHeader(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
  const f = await fixture();
  expect(() => encodeNativeLayoutArchiveViewport({ ...f.reference, entityChunks: [1, 1] })).toThrow();
  await expect(readNativeLayoutArchiveViewport({ ...f.reference, entityCount: 4 }, f.reader)).rejects.toThrow('size mismatch');
});
