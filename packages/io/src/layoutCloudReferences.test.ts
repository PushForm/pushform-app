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
  expect(exported.warnings).toHaveLength(1);
  expect(exported.warnings[0]).toContain('Page 1: 1 model view was exported as page artwork, not editable model views: View 1 (a PushForm cloud model).');
  expect(exported.warnings[0]).toContain('model editing, camera changes and model-linked behavior are lost for these views in the exported file');
});

function addCloudViews(doc: ReturnType<typeof createLayoutDocument>, pageId: number, count: number) {
  doc.undoStack.transact('More cloud views', draft => {
    for (let i = 0; i < count; i++) {
      const id = draft.meta.nextId++, base = withCloudEntity(id, draft.activeLayerId);
      draft.pages.get(pageId)!.entities.set(id, base); draft.pages.get(pageId)!.entityOrder.push(id);
    }
  });
}

function withCloudEntity(id: number, layerId: number): LayoutEntity {
  return { id, kind: 'image', layerId, closed: true, points: [[10, 10], [110, 10], [110, 60], [10, 60]],
    image: { src: picture, viewport: { source: { referenceId: 2 }, templateId: null, originalId: null, camera, scene: null, background: null,
      cache: { camera, widthMm: 100, heightMm: 50, sha256: sha } } } };
}

it('groups flattened views by page, names them, and shortens long lists', async () => {
  const { doc, pageId } = withCloudView();
  addCloudViews(doc, pageId, 7);
  doc.undoStack.transact('Name a view', draft => { draft.pages.get(pageId)!.entities.get(3)!.name = 'Front elevation'; });
  const before = encodeLayoutDocument(doc);
  const exported = await exportSketchUpLayout(doc.state);
  expect(exported.warnings).toHaveLength(1);
  const note = exported.warnings[0]!;
  expect(note).toContain('Page 1: 8 model views were exported as page artwork');
  expect(note).toContain('Front elevation (a PushForm cloud model)');
  expect(note).toContain('and 3 more.');
  expect(note.match(/a PushForm cloud model/g)).toHaveLength(5);
  expect(encodeLayoutDocument(doc)).toEqual(before);
});

it('reports each page with flattened views separately and cuts off a long page list', async () => {
  const { doc } = withCloudView();
  for (let i = 0; i < 12; i++) {
    doc.undoStack.transact('Add page', draft => {
      const pageId = draft.meta.nextId++, source = draft.pages.get(draft.pageOrder[0]!)!;
      draft.pages.set(pageId, { ...source, id: pageId, name: `Sheet ${i + 2}`, entities: new Map(), entityOrder: [] });
      draft.pageOrder.push(pageId);
      const id = draft.meta.nextId++;
      draft.pages.get(pageId)!.entities.set(id, withCloudEntity(id, draft.activeLayerId)); draft.pages.get(pageId)!.entityOrder.push(id);
    });
  }
  const exported = await exportSketchUpLayout(doc.state);
  expect(exported.warnings).toHaveLength(11);
  expect(exported.warnings[0]).toMatch(/^Page 1: /);
  expect(exported.warnings[1]).toMatch(/^Sheet 2: /);
  expect(exported.warnings[10]).toBe('and 3 more pages with model views exported as page artwork');
});
