// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { m4translation, meshBox, type Id, type ImageId, type Mat4 } from '@pushform/core';
import { allocId, bodyFromMesh, createDocument, ImageStore, newImageEntity, type ImageAsset, type ImageEntity } from '@pushform/model';
import { decodeModelDocument, decodeModelFile, encodeModelDocument, modelJson, parseModelManifest } from './modelFile';
import { decodeModelSessionJson, hydrateModelState, modelSessionJson } from './modelSession';

describe('.pf file', () => {
  it('round-trips dimensions with their attachments and styles, and the model dimension settings', () => {
    const doc = createDocument();
    doc.transact('dimension', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
      const id = allocId(draft);
      root.dimensions.set(id, { id, kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1], text: '<> typ.', fontSizePt: 14,
        arrow: 'dot', align: 'outside', tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
        anchors: [{ kind: 'sketchVertex', path: [], id: 7 }, { kind: 'bodyVertex', path: [3], bodyId: 9, faceIds: [1, 2, 4] }] } as never);
      root.order.push(id);
      draft.meta.dimensions = { fontSizePt: 12, arrow: 'slash', align: 'above' };
    });
    const before = [...doc.state.definitions.get(doc.state.rootDefinitionId)!.entities.dimensions.values()];
    const reopened = decodeModelDocument(encodeModelDocument(doc));
    const after = [...reopened.definitions.get(doc.state.rootDefinitionId)!.entities.dimensions.values()];
    expect(after).toEqual(before);
    // The model's dimension settings too.
    expect(reopened.meta.dimensions).toEqual({ fontSizePt: 12, arrow: 'slash', align: 'above' });
  });

  it('round-trips model geometry and typed mesh arrays', () => {
    const doc = createDocument();
    doc.transact('Draw box', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 2, 3]), { container: root.entities });
    });
    const copy = decodeModelDocument(encodeModelDocument(doc));
    expect(modelJson(copy)).toBe(modelJson(doc.state));
    const body = [...copy.definitions.get(copy.rootDefinitionId)!.entities.bodies.values()][0]!;
    expect(body.mesh.verts).toBeInstanceOf(Float64Array);
    expect(body.mesh.tris).toBeInstanceOf(Uint32Array);
    expect(body.mesh.faceId).toBeInstanceOf(Uint32Array);
    expect(body.faces.size).toBeGreaterThan(0);
  });

  it('rejects invalid archives and unsupported versions', () => {
    expect(() => decodeModelDocument(new Uint8Array([1, 2, 3]))).toThrow('Invalid .pf archive');
    const state = JSON.parse(modelJson(createDocument().state)) as {
      format: string; version: number; state: { meta: { formatVersion: number } };
    };
    const archive = () => zipSync({ 'model.json': strToU8(JSON.stringify(state)) });
    state.version = 2;
    expect(() => decodeModelDocument(archive())).toThrow('Unsupported model version: 2');
    state.version = 1;
    state.state.meta.formatVersion = 2;
    expect(() => decodeModelDocument(archive())).toThrow('version does not match its manifest');
  });

  it('stores image bytes beside the manifest and still opens archives without them', () => {
    const doc = createDocument(), images = new ImageStore();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250]);
    const ids = doc.transact('Add images', (draft) => [0, 1].map((i) => {
      const id = allocId<ImageId>(draft);
      const asset: ImageAsset = { id, name: `tile${i}.png`, mime: 'image/png', width: 1, height: 1, sha256: `hash${i}` };
      (draft.images as unknown as Map<ImageId, ImageAsset>).set(id, asset);
      // Only the first image's bytes are loaded.
      if (i === 0) images.register(asset, png);
      return id;
    })).value;
    const bytes = encodeModelDocument(doc, images);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual([`images/${ids[0]}.png`, 'model.json']);
    const file = decodeModelFile(bytes);
    expect(modelJson(file.state)).toBe(modelJson(doc.state));
    expect([...file.images.keys()]).toEqual([ids[0]]);
    expect(file.images.get(ids[0]!)).toEqual({ bytes: png, mime: 'image/png' });
    // A file written before images were stored, or by a writer without them: descriptors only.
    const older = decodeModelFile(zipSync({ 'model.json': strToU8(modelJson(doc.state)) }));
    expect(older.images.size).toBe(0);
    expect(older.state.images.size).toBe(2);
    expect(modelJson(decodeModelDocument(bytes))).toBe(modelJson(doc.state));
  });

  it('keeps placed pictures with their image bytes through save and reopen', () => {
    const doc = createDocument(), images = new ImageStore();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
    const { imageId, entityId } = doc.transact('Place picture', (draft) => {
      const imageId = allocId<ImageId>(draft);
      const asset: ImageAsset = { id: imageId, name: 'site.png', mime: 'image/png', width: 400, height: 200, sha256: 'site' };
      (draft.images as unknown as Map<ImageId, ImageAsset>).set(imageId, asset);
      images.register(asset, png);
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities as unknown as { images: Map<Id, ImageEntity>; order: Id[] };
      const entityId = allocId<Id>(draft);
      root.images.set(entityId, newImageEntity(entityId, imageId, m4translation([1, 2, 3]) as unknown as Mat4, 0.4, 0.2, draft.defaultTagId));
      root.order.push(entityId);
      return { imageId, entityId };
    }).value;
    const file = decodeModelFile(encodeModelDocument(doc, images));
    const placed = file.state.definitions.get(file.state.rootDefinitionId)!.entities.images.get(entityId);
    expect(placed).toEqual(doc.state.definitions.get(doc.state.rootDefinitionId)!.entities.images.get(entityId));
    expect(file.images.get(imageId)).toEqual({ bytes: png, mime: 'image/png' });
  });
});

describe('.pf manifest hydration', () => {
  it('hydrates parsed tagged JSON to the same state as the reviving parser, without re-serializing', () => {
    const doc = createDocument();
    doc.transact('Draw box', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 2, 3]), { container: root.entities });
    });
    const json = modelSessionJson(doc.state);
    const parsed: unknown = JSON.parse(json);
    const hydrated = hydrateModelState(parsed);
    expect(modelSessionJson(hydrated)).toBe(json);
    expect(modelSessionJson(decodeModelSessionJson(json))).toBe(json);
    const body = [...hydrated.definitions.get(hydrated.rootDefinitionId)!.entities.bodies.values()][0]!;
    expect(body.mesh.verts).toBeInstanceOf(Float64Array);
    expect(body.faces).toBeInstanceOf(Map);
    expect(() => hydrateModelState({ ...(parsed as object), definitions: { $map: 'bad' } })).toThrow('Invalid model map');
    expect(() => parseModelManifest(JSON.stringify({ format: 'pushform-model', version: 1, state: { meta: {} } })))
      .toThrow('Model document has invalid state');
    expect(() => parseModelManifest('{')).toThrow('invalid JSON');
    expect(() => parseModelManifest('{"format":"other"}')).toThrow('Not a PushForm model document');
  });
});
