// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LayoutDocument, createLayoutDocumentState, createLayoutTable, createLinearDimension, createAngularDimension } from '@pushform/layout';
import type { LayoutDocumentState, LayoutEntity } from '@pushform/layout';
import { writeNativeLayout } from './layoutWriter';
import { openNativeDocumentIndex } from './documentRoot';
import { decodeNativeLayoutDocumentHeader, encodeNativeLayoutDocumentHeader, readNativeLayoutDocumentOrders, decodeNativeLayoutCustomField, decodeNativeLayoutPageNumberField } from './layoutDocument';
import { decodeNativeLayoutRecord, encodeNativeLayoutRecord } from './layoutRecord';
import { unpackNativeRecords, encodeNativeRecordChunks } from './recordStream';
import { decodeNativeLayoutEntityRecord, encodeNativeLayoutEntityRecord } from './layoutEntityWriter';
import type { NativeLayoutEntityRecord } from './layoutEntityWriter';
import { readNativeLayoutEntity, materializeNativeLayoutEntity } from './layoutEntityReader';
import { decodeNativeLayoutAssetReference, encodeNativeLayoutAssetReference, readNativeLayoutAsset, materializeNativeLayoutAsset } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { readNativeLayout } from './layoutReader';
import { nativeLayoutState } from './layoutState';
import { writeNativeContainer } from './container';
import { encodeNativeChunks } from './chunks';
import type { NativeChunk } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
function source(bytes: Uint8Array) { return { size: bytes.length, read: async (at: number, length: number) => bytes.subarray(at, at + length) }; }
function fixture(): LayoutDocumentState {
  const state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  const alloc = () => state.meta.nextId++;
  for (const kind of ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'image', 'table'] as const) {
    const id = alloc(), e: LayoutEntity = { id, layerId: state.activeLayerId, kind, points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true };
    if (kind === 'text' || kind === 'label') e.text = createLayoutTable(1, 1).cells[0]!.text;
    if (kind === 'label') e.preservedModelConnections = { archiveId: 'archive', originalId: 'annotation', snapshot: '{"opaque":true}', viewports: [{ originalId: 'view', entityId: 999 }], fields: { Name: 'Beam' } };
    if (kind === 'dimension') { e.dimension = createLinearDimension(); e.points.pop(); }
    if (kind === 'angular-dimension') e.angularDimension = createAngularDimension();
    if (kind === 'image') e.image = { src: 'data:image/png;base64,AQID' };
    if (kind === 'table') e.table = createLayoutTable(2, 2);
    page.entities.set(id, e); page.entityOrder.push(id);
  }
  const layerId = alloc(); state.layers.set(layerId, { id: layerId, name: 'Shared', visible: true, locked: false, shared: true }); state.layerOrder.push(layerId);
  const id = alloc(); state.sharedEntities.set(id, { id, kind: 'path', layerId, points: [[1, 2], [3, 4]], closed: false }); state.sharedEntityOrder.push(id);
  const referenceId = alloc(); state.references.set(referenceId, { id: referenceId, displayName: 'Reference', target: { kind: 'path', path: 'model.skp', contentHash: null } });
  state.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'AAEC', annotationConnectionsVersion: 1,
    models: new Map([['model', { internalTarget: 'models/model.skp', externalTarget: null }]]), viewports: new Map([['view', { modelReferenceId: 'model', entityIds: [999] }]]) }]]);
  state.customFields.set('Project', 'Native fixture'); state.pageNumberFields = new Map([['PageNumber', { startPageId: page.id, startNumber: 42, style: 'upper-roman' }]]);
  return state;
}
function sink() {
  const parts: Uint8Array[] = [];
  return { write: async (bytes: Uint8Array) => { parts.push(bytes.slice()); }, bytes: () => {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { result.set(p, at); at += p.length; } return result;
  } };
}
async function inspect(bytes: Uint8Array) {
  const index = await openNativeDocumentIndex({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) }, new Set(), (kind, schema) => schema === 1 && [2, 3, 4].includes(kind) || kind === 2 && schema === 2);
  const entries = new Map(index.container.entries.map(e => [e.descriptor.id, e]));
  async function* pages() { for (const id of index.root.recordChunks) yield await index.container.read(entries.get(id)!); }
  const records = []; for await (const bytes of unpackNativeRecords(pages())) records.push(decodeNativeLayoutRecord(bytes));
  return { ...index, records, header: decodeNativeLayoutDocumentHeader(await index.container.read(index.metadata)).value };
}
it('writes indexed Layout files whose typed entities and shared assets round trip through real container reads', async () => {
  const state = fixture(), output = sink(), info = await writeNativeLayout(state, output), bytes = output.bytes(), data = await inspect(bytes);
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2'); expect(data.root.documentKind).toBe(2); expect(info.storedBytes).toBe(bytes.length);
  expect(data.header.assetCount).toBe(3); expect(data.records.filter(r => r.kind === 'asset')).toHaveLength(3);
  const budget = new NativeColumnBudget(), columns = new NativeColumnReader(data.container, budget), assets = new Map<number, NativeLayoutAsset>(), strings = new Map<number, string>();
  for (const r of data.records) if (r.kind === 'asset') { const a = await readNativeLayoutAsset(decodeNativeLayoutAssetReference(r.payload), columns); assets.set(r.assetId!, a); strings.set(r.assetId!, materializeNativeLayoutAsset(a)); }
  const entities = new Map<number, NativeLayoutEntityRecord[]>();
  for (const r of data.records) if (r.kind === 'entity') { const e = decodeNativeLayoutEntityRecord(r.payload), list = entities.get(e.ownerId) ?? []; list.push(e); entities.set(e.ownerId, list); }
  const expected = new Map([...state.sharedEntities, ...[...state.pages.values()].flatMap(p => [...p.entities])]);
  expect(entities.size).toBe(expected.size);
  for (const [id, records] of entities) expect(materializeNativeLayoutEntity(await readNativeLayoutEntity(records, columns, assets), strings)).toEqual(expected.get(id));
  const orders = await readNativeLayoutDocumentOrders(data.header, columns, state); expect(Array.from(orders.sharedEntityOrder)).toEqual(state.sharedEntityOrder);
  expect(data.records.filter(r => r.kind === 'customField').map(r => decodeNativeLayoutCustomField(r.payload).value)).toEqual(['Native fixture']);
  expect(data.records.filter(r => r.kind === 'numbering').map(r => decodeNativeLayoutPageNumberField(r.payload).value)).toEqual([...state.pageNumberFields!.values()]);
  const packed = await readNativeLayout(source(bytes)); expect(packed.hasUnsupportedExtensions).toBe(false);
  expect(nativeLayoutState(packed)).toEqual(state);
});
it('captures an immutable revision while later document state changes during sink writes', async () => {
  const doc = new LayoutDocument(fixture()), captured = doc.state, output = sink(); let changed = false;
  await writeNativeLayout(captured, { write: async bytes => { if (!changed) { changed = true; doc.undoStack.transact('Later edit', draft => { draft.customFields.set('Project', 'Later edit'); }); } await output.write(bytes); } });
  const data = await inspect(output.bytes()); expect(data.records.filter(r => r.kind === 'customField').map(r => decodeNativeLayoutCustomField(r.payload).value)).toEqual(['Native fixture']);
  expect(doc.state.customFields.get('Project')).toBe('Later edit'); expect(doc.state).not.toBe(captured);
});
it('leaves failed and cancelled writes without a valid completed container', async () => {
  const output = sink(); let writes = 0;
  await expect(writeNativeLayout(fixture(), { write: async bytes => { if (++writes === 4) throw new Error('quota'); await output.write(bytes); } })).rejects.toThrow('quota');
  await expect(inspect(output.bytes())).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); const cancelled = sink();
  await expect(writeNativeLayout(fixture(), cancelled, { signal: controller.signal })).rejects.toThrow(); expect(cancelled.bytes()).toHaveLength(0);
});
it('enforces record contexts and preserves owned future envelope fields', () => {
  const fields = [new Uint8Array([0x98, 6, 7])], value = { kind: 'entity' as const, pageId: 0, payload: new Uint8Array([1, 2]), unknownFields: fields };
  const bytes = encodeNativeLayoutRecord(value), next = decodeNativeLayoutRecord(bytes); bytes.fill(0); expect(next).toEqual(value);
  expect(() => encodeNativeLayoutRecord({ kind: 'entity', payload: new Uint8Array(), unknownFields: [] })).toThrow();
  expect(() => encodeNativeLayoutRecord({ ...value, kind: 'layer' })).toThrow();
  expect(() => encodeNativeLayoutRecord({ kind: 'archiveModel', archiveId: '', payload: new Uint8Array(), unknownFields: [] })).toThrow();
});
it('round trips absent, undefined and empty optional maps through complete files', async () => {
  for (const presence of ['absent', 'undefined', 'empty']) {
    const state = createLayoutDocumentState(); delete state.modelArchives; delete state.pageNumberFields;
    if (presence !== 'absent') for (const key of ['modelArchives', 'pageNumberFields']) Object.defineProperty(state, key, { value: presence === 'empty' ? new Map() : undefined, enumerable: true });
    const output = sink(); await writeNativeLayout(state, output); const next = nativeLayoutState(await readNativeLayout(source(output.bytes())));
    expect(next).toEqual(state); expect(Object.hasOwn(next, 'modelArchives')).toBe(presence !== 'absent'); expect(Object.hasOwn(next, 'pageNumberFields')).toBe(presence !== 'absent');
  }
});
it('rejects global ID collisions, stale allocators and incomplete page order before returning editable state', async () => {
  for (const defect of ['collision', 'group', 'allocator', 'order']) {
    const state = fixture(), page = state.pages.get(state.pageOrder[0]!)!, first = page.entities.get(page.entityOrder[0]!)!;
    if (defect === 'collision') { page.entities.delete(first.id); page.entityOrder[0] = page.id; first.id = page.id; page.entities.set(first.id, first); }
    if (defect === 'group') first.groupId = page.id;
    if (defect === 'allocator') state.meta.nextId--;
    if (defect === 'order') page.entityOrder.pop();
    const output = sink(); await writeNativeLayout(state, output);
    await expect(readNativeLayout(source(output.bytes()))).rejects.toThrow();
  }
});
it('retains future document metadata fields through editable installation and saving', async () => {
  const output = sink(); await writeNativeLayout(fixture(), output); const data = await inspect(output.bytes());
  const ext = decodeNativeLayoutDocumentHeader(await data.container.read(data.metadata)); ext.extensions.records.set('', [new Uint8Array([0x98, 6, 7])]);
  const modified = encodeNativeLayoutDocumentHeader(ext.value, ext.extensions), rebuilt = sink();
  async function* chunks() {
    for (const entry of data.container.entries) {
      const bytes = entry.descriptor.id === data.root.metadataChunk ? modified : await data.container.read(entry);
      for await (const chunk of encodeNativeChunks([bytes], { pageBytes: 256 * 1024 })) yield { descriptor: describeNativeChunk(entry.descriptor.id, entry.descriptor.kind, entry.descriptor.schemaId, true, chunk), data: chunk.data };
    }
  }
  await writeNativeContainer({ kind: 2, root: data.container.root }, chunks(), rebuilt);
  const packed = await readNativeLayout(source(rebuilt.bytes())); expect(packed.hasUnsupportedExtensions).toBe(false);
  expect(packed.document.extensions.records.get('')).toEqual(ext.extensions.records.get(''));
  const editable = nativeLayoutState(packed);
  expect(editable.nativeDocumentUnknownFields?.records.get('')).toEqual(ext.extensions.records.get(''));
  const saved = sink(); await writeNativeLayout(editable, saved);
  expect((await readNativeLayout(source(saved.bytes()))).document.extensions.records.get('')).toEqual(ext.extensions.records.get(''));
});
it('honors a shared allocation budget and cancellation on complete document reads', async () => {
  const output = sink(); await writeNativeLayout(fixture(), output); const bytes = output.bytes(), budget = new NativeColumnBudget(0);
  await expect(readNativeLayout(source(bytes), { budget })).rejects.toThrow('budget'); expect(budget.usedBytes).toBe(0);
  const c = new AbortController(); c.abort(); await expect(readNativeLayout(source(bytes), { signal: c.signal })).rejects.toThrow();
});

it.each(['outer payload', 'inner payload', 'orphan outer payload', 'orphan inner payload'])('preserves owned and rejects orphan asset fields: %s', async scope => {
  const output = sink(); await writeNativeLayout(fixture(), output); const data = await inspect(output.bytes());
  expect(data.root.recordChunks).toHaveLength(1);
  const target = data.records.find(r => r.kind === 'asset' && decodeNativeLayoutAssetReference(r.payload).prefix.startsWith('data:image/'))!;
  const fields = [new Uint8Array([0xa0, 6, 7])];
  if (scope.endsWith('outer payload')) target.unknownFields = fields;
  else target.payload = encodeNativeLayoutAssetReference({ ...decodeNativeLayoutAssetReference(target.payload), unknownFields: fields });
  if (scope.startsWith('orphan')) for (const record of data.records) if (record.kind === 'entity') {
    const entity = decodeNativeLayoutEntityRecord(record.payload);
    if (entity.kind === 'image') record.payload = encodeNativeLayoutEntityRecord({ ...entity, payload: undefined });
  }
  const pages: NativeChunk[] = [];
  for await (const chunk of encodeNativeRecordChunks(data.records.map(encodeNativeLayoutRecord))) pages.push(chunk);
  expect(pages).toHaveLength(1);
  const rebuilt = sink();
  async function* chunks() {
    for (const entry of data.container.entries) {
      if (entry.descriptor.id === data.root.recordChunks[0]) {
        const chunk = pages[0]!; yield { descriptor: describeNativeChunk(entry.descriptor.id, 3, 1, true, chunk), data: chunk.data };
      } else for await (const chunk of encodeNativeChunks([await data.container.read(entry)], { pageBytes: 256 * 1024 })) {
        yield { descriptor: describeNativeChunk(entry.descriptor.id, entry.descriptor.kind, entry.descriptor.schemaId, true, chunk), data: chunk.data };
      }
    }
  }
  await writeNativeContainer({ kind: 2, root: data.container.root }, chunks(), rebuilt);
  const packed = await readNativeLayout(source(rebuilt.bytes()));
  expect(packed.hasUnsupportedExtensions).toBe(scope.startsWith('orphan'));
  if (scope.startsWith('orphan')) expect(() => nativeLayoutState(packed)).toThrow('cannot preserve');
  else {
    const editable = nativeLayoutState(packed), saved = sink(); await writeNativeLayout(editable, saved);
    const reopened = await readNativeLayout(source(saved.bytes()));
    expect(nativeLayoutState(reopened)).toEqual(editable);
    const asset = [...reopened.assets.values()].find(asset => asset.reference.prefix.startsWith('data:image/'))!;
    expect(scope.endsWith('outer payload') ? asset.envelopeUnknown : asset.reference.unknownFields).toEqual(fields);
  }
});
