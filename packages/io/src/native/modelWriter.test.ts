// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import type { DefId, Id, ImageId } from '@pushform/core';
import { allocId, bodyFromMesh, createDocument, createEntityContainer } from '@pushform/model';
import { writeNativeModel } from './modelWriter';
import { openNativeDocumentIndex } from './documentRoot';
import { decodeNativeModelSettings } from './modelSettings';
import { decodeNativeModelRecord } from './modelRecord';
import { unpackNativeRecords } from './recordStream';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { NativeCommonPropertyReader, encodeNativeCommonProperty } from './commonProperty';
import { readNativeBody } from './body';
import { readNativeSketch } from './sketch';
import { readNativeImageAsset } from './imageAsset';
import { readNativeModel } from './modelReader';
import { nativeModelState } from './modelState';
function document() {
  const doc = createDocument();
  doc.transact('mixed entities', d => {
    const e = d.definitions.get(d.rootDefinitionId)!.entities;
    bodyFromMesh(d, meshBox([0, 0, 0], [1, 2, 3]), { container: e });
    const common = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    const id = (): Id => { const id = allocId<Id>(d); e.order.push(id); return id; };
    const guide = id(); e.guides.set(guide, { ...common, id: guide, kind: 'segment', origin: [0, 0, 0], end: [1, 2, 3] });
    const imageId = allocId<ImageId>(d); d.images.set(imageId, { id: imageId, name: 'fixture', mime: 'image/png', width: 1, height: 1, sha256: 'source hash' });
    const image = id(); e.images.set(image, { ...common, id: image, imageId, widthM: 2, heightM: 3, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
    const plane = id(); e.sectionPlanes.set(plane, { ...common, id: plane, name: 'cut', symbol: 'A', plane: { n: [0, 0, 1], d: 1 }, origin: [0, 0, 1] }); e.activeSectionPlaneId = plane;
    const text = id(); e.texts.set(text, { ...common, id: text, text: 'hello', kind: 'screen', position: [0.5, 0.5, 0], offset: null, leader: 'none', fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0], bold: undefined });
    const dimension = id(); e.dimensions.set(dimension, { ...common, id: dimension, kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1], text: null, fontSizePt: 10, anchors: [null, null] });
    const child = allocId<DefId>(d); d.definitions.set(child, { ...d.definitions.get(d.rootDefinitionId)!, id: child, name: 'child', entities: createEntityContainer() as unknown as typeof e });
    const instance = id(); e.instances.set(instance, { ...common, id: instance, definitionId: child, name: 'placement', materialId: null, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  }); return doc;
}
function sink() {
  const parts: Uint8Array[] = [];
  return { write: async (bytes: Uint8Array) => { parts.push(bytes.slice()); }, bytes: () => {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } return all;
  } };
}
async function inspect(bytes: Uint8Array) {
  const index = await openNativeDocumentIndex({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, new Set(), (kind, schema) => (schema === 1 && [2, 3, 4].includes(kind)) || (kind === 2 && schema === 2));
  const entries = new Map(index.container.entries.map(e => [e.descriptor.id, e]));
  async function* pages() { for (const id of index.root.recordChunks) yield await index.container.read(entries.get(id)!); }
  const records = []; for await (const bytes of unpackNativeRecords(pages())) records.push(decodeNativeModelRecord(bytes));
  return { ...index, records, settings: decodeNativeModelSettings(await index.container.read(index.metadata)).value };
}
describe('streamed Modeling document writer', () => {
  it('writes complete known entity records, shared properties, indexed geometry and one asset payload', async () => {
    const doc = document(), output = sink(), blob = { mime: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]) }; let assetReads = 0;
    const info = await writeNativeModel(doc.state, output, { pageBytes: 64, imageBlob: () => { assetReads++; return blob; } });
    const bytes = output.bytes(), data = await inspect(bytes); expect(bytes.length).toBe(info.storedBytes); expect(assetReads).toBe(1);
    const staged = await readNativeModel({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
    expect(nativeModelState(staged)).toEqual(doc.state);
    expect(staged.definitions.size).toBe(doc.state.definitions.size);
    expect(staged.catalogs.values.images).toEqual(doc.state.images);
    expect([...staged.imageBlobs.values()]).toEqual([blob]);
    for (const [id, definition] of doc.state.definitions) {
      const loaded = staged.definitions.get(id)!;
      expect(Array.from(loaded.order)).toEqual(definition.entities.order);
      for (const name of ['instances', 'guides', 'images', 'sectionPlanes', 'texts', 'dimensions'] as const) expect(loaded[name]).toEqual(definition.entities[name]);
    }
    const kinds = data.records.map(r => r.kind);
    for (const kind of ['material', 'tag', 'style', 'image', 'definition', 'sketch', 'body', 'instance', 'guide', 'imagePlacement', 'sectionPlane', 'text', 'dimension', 'commonProperty']) expect(kinds).toContain(kind);
    expect(kinds.filter(k => k === 'commonProperty').length).toBe(1);
    expect(data.settings.meta).toEqual(doc.state.meta);
    const properties = new NativeCommonPropertyReader();
    for (const r of data.records) if (r.kind === 'commonProperty') properties.add(encodeNativeCommonProperty(r.value));
    const columns = new NativeColumnReader(data.container, new NativeColumnBudget());
    for (const r of data.records) {
      if (r.kind === 'body') { const body = await readNativeBody(r.value, columns, properties, id => doc.state.materials.has(id as never), id => doc.state.tags.has(id as never)); expect(body.mesh).toEqual([...doc.rootDefinition.entities.bodies.values()][0]!.mesh); }
      if (r.kind === 'sketch') expect((await readNativeSketch(r.value, columns, properties, () => true)).vertices.ids.length).toBe(0);
      if (r.kind === 'image') expect(await readNativeImageAsset(r.value, columns)).toEqual(blob);
      if (r.kind === 'definition') expect(r.value.activeSectionPlaneId).toBe(doc.state.definitions.get(r.value.metadata.id)!.entities.activeSectionPlaneId);
      if (r.kind === 'text') expect(r.value.value).toMatchObject({ text: 'hello', bold: undefined });
    }
  });
  it('holds one captured revision while later edits occur during sink backpressure', async () => {
    const doc = document(), captured = doc.state, output = sink(); let edited = false;
    await writeNativeModel(captured, { write: async bytes => {
      if (!edited) { edited = true; doc.transact('later edit', d => { d.definitions.get(d.rootDefinitionId)!.name = 'later'; }); }
      await output.write(bytes);
    } });
    const data = await inspect(output.bytes()), definition = data.records.find(r => r.kind === 'definition');
    expect(definition?.kind).toBe('definition'); if (definition?.kind === 'definition') expect(definition.value.metadata.name).toBe(captured.definitions.get(captured.rootDefinitionId)!.name);
    expect(doc.rootDefinition.name).toBe('later');
  });
  it('propagates sink failure and abort without publishing a finished index', async () => {
    const doc = document(); let writes = 0;
    await expect(writeNativeModel(doc.state, { write: async () => { writes++; throw new Error('quota'); } })).rejects.toThrow('quota'); expect(writes).toBe(1);
    const controller = new AbortController(), output = sink();
    await expect(writeNativeModel(doc.state, { write: async bytes => { await output.write(bytes); controller.abort(); } }, { signal: controller.signal })).rejects.toThrow();
    await expect(inspect(output.bytes())).rejects.toThrow();
  });
});
