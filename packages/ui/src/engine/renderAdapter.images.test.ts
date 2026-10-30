// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4translation, type DefId, type Id, type ImageId, type Mat4, type TagId } from '@pushform/core';
import { allocId, createDocument, createEntityContainer, ImageStore, newImageEntity, type EntityContainer } from '@pushform/model';
import { renderKey } from '@pushform/render';
import { describeRef } from '../panels/entityInfo';
import { highlightFor, imagesToRender } from './renderAdapter';

// Placed pictures as the renderer draws them and as Entity Info describes them.
function fixture() {
  const doc = createDocument();
  const images = new ImageStore();
  let shown = 0 as Id, hidden = 0 as Id, tagged = 0 as Id, inner = 0 as Id, inst = 0 as Id, imageId = 0 as ImageId, tag = 0 as TagId;
  doc.transact('fixture', (d) => {
    imageId = allocId<ImageId>(d);
    const asset = { id: imageId, name: 'plan.png', mime: 'image/png', width: 800, height: 400, sha256: 'x' };
    d.images.set(imageId, asset);
    images.register(asset, new Uint8Array([1]), 'image/png');
    tag = allocId<TagId>(d);
    d.tags.set(tag, { id: tag, name: 'Off', color: [0, 0, 0], visible: false, folderId: null, dashes: null });
    const root = d.definitions.get(d.rootDefinitionId)!.entities as unknown as EntityContainer;
    const place = (container: EntityContainer, transform: Mat4, extra: Partial<ReturnType<typeof newImageEntity>> = {}): Id => {
      const id = allocId<Id>(d);
      container.images.set(id, { ...newImageEntity(id, imageId, transform, 0.8, 0.4, d.defaultTagId), ...extra });
      container.order.push(id);
      return id;
    };
    shown = place(root, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 1]);
    hidden = place(root, m4translation([0, 0, 0]) as unknown as Mat4, { hidden: true });
    tagged = place(root, m4translation([0, 0, 0]) as unknown as Mat4, { tagId: tag });
    const def = allocId<DefId>(d);
    d.definitions.set(def, { ...d.definitions.get(d.rootDefinitionId)!, id: def, name: 'G', isGroup: true, entities: createEntityContainer(), bounds: null } as never);
    inner = place(d.definitions.get(def)!.entities as unknown as EntityContainer, m4translation([0, 1, 0]) as unknown as Mat4, { castShadows: false });
    inst = allocId<Id>(d);
    root.instances.set(inst, { id: inst, definitionId: def, transform: m4translation([10, 0, 0]) as unknown as Mat4, name: '', materialId: null,
      tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: false, attributes: {} } as never);
    root.order.push(inst);
  });
  return { doc, images, shown, hidden, tagged, inner, inst, imageId };
}

describe('placed pictures in the renderer and Entity Info', () => {
  it('draws visible pictures of the model and its groups in world coordinates, with their image and shadow flags', () => {
    const { doc, images, shown, inner, inst, imageId } = fixture();
    const out = imagesToRender(doc.state, images);
    expect(out.map(i => i.key)).toEqual([renderKey([], shown), renderKey([inst], inner)]);
    expect(out[0]).toMatchObject({ entityId: shown, widthM: 0.8, heightM: 0.4, textureUrl: images.objectUrl(imageId), castShadows: true, receiveShadows: true });
    expect(out[1]!.transform.slice(12, 15)).toEqual([10, 1, 0]);
    expect(out[1]).toMatchObject({ path: [inst], castShadows: false, receiveShadows: false });
    // Unchanged pictures keep their objects, so the renderer rebuilds nothing.
    const again = imagesToRender(doc.state, images);
    expect(again[0]).toBe(out[0]);
    expect(again[1]).toBe(out[1]);
  });

  it('highlights a picture by its world rectangle', () => {
    const { doc, inner, inst } = fixture();
    expect(highlightFor(doc.state, { kind: 'image', path: [inst], id: inner })).toEqual({ kind: 'image', key: renderKey([inst], inner),
      corners: [[10, 1, 0], [10.8, 1, 0], [10.8, 1.4, 0], [10, 1.4, 0]] });
  });

  it('describes a picture with its image name, pixels and placed size', () => {
    const { doc, shown } = fixture();
    expect(describeRef(doc.state, { kind: 'image', path: [], id: shown })).toMatchObject({ kind: 'image', title: 'Image', name: 'plan.png',
      pixels: [800, 400], width: 1.6, height: 0.8, hidden: false });
  });
});
