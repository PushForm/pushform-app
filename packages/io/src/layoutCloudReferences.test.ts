// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, type LayoutEntity, type LayoutViewportCamera } from '@pushform/layout';
import { decodeLayoutDocument, encodeLayoutDocument } from './layoutFile';
import { exportSketchUpLayout } from './sketchupLayoutExport';

const camera: LayoutViewportCamera = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
const sha = 'a'.repeat(64);
const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function withCloudView() {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Cloud view fixture', draft => {
    draft.references.set(2, { id: 2, displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1', revisionId: 'rev-1', revisionNumber: 1, sha256: sha, pinned: false } });
    const entity: LayoutEntity = { id: 3, kind: 'image', layerId: draft.activeLayerId, closed: true, points: [[10, 10], [110, 10], [110, 60], [10, 60]],
      image: { src: picture, viewport: { source: { referenceId: 2 }, templateId: null, originalId: null, camera, scene: null, background: null,
        cache: { camera, widthMm: 100, heightMm: 50, sha256: sha } } } };
    draft.pages.get(pageId)!.entities.set(3, entity); draft.pages.get(pageId)!.entityOrder.push(3); draft.meta.nextId = 4;
  });
  return { doc, pageId };
}

it('saves cloud model references and views losslessly, and rejects views whose reference is missing or malformed', () => {
  const { doc, pageId } = withCloudView();
  const read = decodeLayoutDocument(encodeLayoutDocument(doc)).state;
  expect(read.references.get(2)).toEqual(doc.state.references.get(2));
  expect(read.pages.get(pageId)!.entities.get(3)).toEqual(doc.state.pages.get(pageId)!.entities.get(3));
  const broken = (edit: (draft: Parameters<Parameters<typeof doc.undoStack.transact>[1]>[0]) => void) => {
    doc.undoStack.transact('Broken fixture', edit);
    expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
    doc.undoStack.undo();
  };
  broken(draft => { draft.references.delete(2); });
  broken(draft => { (draft.references.get(2)!.target as { sha256: string }).sha256 = 'not a hash'; });
  broken(draft => { (draft.references.get(2)!.target as { pinned: unknown }).pinned = 'yes'; });
  broken(draft => { draft.pages.get(pageId)!.entities.get(3)!.image!.viewport!.templateId = 'id60'; });
  broken(draft => { (draft.pages.get(pageId)!.entities.get(3)!.image!.viewport!.cache as { sha256: unknown }).sha256 = 7; });
});

it('exports a view of a cloud model as its picture and says so', async () => {
  const { doc } = withCloudView();
  const exported = await exportSketchUpLayout(doc.state);
  expect(exported.warnings).toContain('A view of a PushForm cloud model was exported as its picture; LayOut cannot edit it as a model viewport');
});
