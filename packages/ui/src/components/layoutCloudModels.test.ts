// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudFilesApi, CloudSavedFile } from '@pushform/cloud';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { createLinearDimension, formatLinearDimension, LAYOUT_DEFAULT_TEXT, type LayoutEntity, type LayoutViewportCamera } from '@pushform/layout';
import type { Id } from '@pushform/core';

const renders = vi.hoisted(() => ({ next: null as { src: string; cache: object } | null }));
vi.mock('./layoutViewportRenders', () => ({ layoutViewportRender: () => renders.next }));
const { checkLayoutReferences, persistLayoutViewportRenders, linkCloudModel, layoutClipboardEntity, updateLayoutReference } = await import('./layoutCloudModels');

const camera: LayoutViewportCamera = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
const sha = 'a'.repeat(64), newer = 'b'.repeat(64);
const sessions: DocumentSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); renders.next = null; });

function head(revision: string, number: number, hash: string): CloudSavedFile {
  return { file: { id: 'doc-1', project_id: 'p', folder_id: null, name: 'House.pf', kind: 'model', current_revision_id: revision, revision_number: number, size_bytes: 3, updated_at: '' },
    revision: { id: revision, document_id: 'doc-1', blob_path: '', size_bytes: 3, sha256: hash, number } };
}
function setup() {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), true, null);
  sessions.push(session);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const api = { head: vi.fn<CloudFilesApi['head']>().mockResolvedValue(head('rev-1', 1, sha)) } as unknown as CloudFilesApi;
  return { session, tab, pageId, api };
}

it('copies model annotations as paper objects without losing resolved text or perspective measurements', () => {
  const { tab, pageId } = setup();
  const attachment = { viewportId: 1, source: { referenceId: 2 }, modelGuid: 'model',
    anchor: { kind: 'sketchVertex' as const, path: [], id: 100 as Id } };
  const dimension: LayoutEntity = { id: 3, layerId: tab.doc.state.activeLayerId, kind: 'dimension', closed: false,
    points: [[0, 0], [40, 0], [0, 10]], dimension: { ...createLinearDimension(), cachedValueMm: 2828.4, scale: 1 },
    modelAnnotation: { status: 'resolved', attachments: [attachment, attachment] } };
  const label: LayoutEntity = { id: 4, layerId: tab.doc.state.activeLayerId, kind: 'label', closed: false,
    points: [[50, 50], [80, 60], [0, 0]], text: { ...LAYOUT_DEFAULT_TEXT, content: '<Ratio> / <PageNumber>', bold: false,
      italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'elbow', endpoint: 'arrow' },
    modelAnnotation: { status: 'resolved', attachments: [attachment], fields: { Ratio: '1:50' } } };
  const copied = [dimension, label].map(entity => layoutClipboardEntity(entity, tab.doc.state));
  expect(copied.every(entity => !entity.modelAnnotation)).toBe(true);
  const ids = tab.commands.execute('layout.clipboard.paste', { pageId, entities: copied }) as number[];
  const page = tab.doc.state.pages.get(pageId)!;
  expect(formatLinearDimension(page.entities.get(ids[0]!)!.dimension!)).toBe('2828.4 mm');
  expect(page.entities.get(ids[1]!)!.text!.content).toBe('1:50 / <PageNumber>');
  expect(dimension.dimension!.scale).toBe(1);
  expect(label.text!.content).toBe('<Ratio> / <PageNumber>');
});

it('links a cloud model at its current revision and adds views that render through it', async () => {
  const { tab, pageId, api } = setup();
  const referenceId = await linkCloudModel(tab, api, { id: 'doc-1', name: 'House.pf' });
  expect(tab.doc.state.references.get(referenceId)).toMatchObject({ displayName: 'House', target: { documentId: 'doc-1', revisionId: 'rev-1', sha256: sha, pinned: false } });
  const id = tab.commands.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 60], source: { referenceId }, camera, scene: null }) as number;
  const entity = () => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  // The copy of a cloud view carries its reference for another drawing.
  expect((layoutClipboardEntity(entity(), tab.doc.state).image!.viewport!.source as unknown as { reference: unknown }).reference)
    .toMatchObject({ displayName: 'House', target: { documentId: 'doc-1' } });
  // A finished render is stored once, without an undo step, and not again while current.
  renders.next = { src: 'data:image/png;base64,AAAA', cache: { camera, widthMm: 100, heightMm: 50, sha256: sha } };
  const undoDepth = tab.doc.undoStack.canUndo;
  expect(persistLayoutViewportRenders(tab)).toBe(1);
  expect(entity().image!.src).toBe('data:image/png;base64,AAAA');
  expect(persistLayoutViewportRenders(tab)).toBe(0);
  expect(tab.doc.undoStack.canUndo).toBe(undoDepth);
});

it('follows a newer saved revision automatically, reports a pinned reference as outdated, and updates it on request', async () => {
  const { tab, api } = setup();
  const referenceId = await linkCloudModel(tab, api, { id: 'doc-1', name: 'House.pf' });
  const target = () => tab.doc.state.references.get(referenceId)!.target as { revisionId: string; sha256: string; pinned: boolean };
  expect([...(await checkLayoutReferences(tab, api)).values()]).toEqual([{ kind: 'current' }]);
  (api.head as ReturnType<typeof vi.fn>).mockResolvedValue(head('rev-2', 2, newer));
  const version = tab.doc.version;
  expect([...(await checkLayoutReferences(tab, api)).values()]).toEqual([{ kind: 'current' }]);
  expect(target()).toMatchObject({ revisionId: 'rev-2', sha256: newer });
  expect(tab.doc.version).toBeGreaterThan(version);
  tab.commands.execute('layout.reference.pin', { referenceId, pinned: true });
  (api.head as ReturnType<typeof vi.fn>).mockResolvedValue(head('rev-3', 3, 'c'.repeat(64)));
  const statuses = await checkLayoutReferences(tab, api);
  expect(statuses.get(referenceId)).toMatchObject({ kind: 'outdated', head: { revision: { id: 'rev-3' } } });
  expect(target().revisionId).toBe('rev-2');
  updateLayoutReference(tab, referenceId, (statuses.get(referenceId) as { head: CloudSavedFile }).head);
  expect(target()).toMatchObject({ revisionId: 'rev-3', pinned: true });
  (api.head as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('This file is no longer available.'));
  expect((await checkLayoutReferences(tab, api)).get(referenceId)).toEqual({ kind: 'missing', reason: 'This file is no longer available.' });
  // A check that outlives its workspace changes nothing.
  (api.head as ReturnType<typeof vi.fn>).mockResolvedValue(head('rev-4', 4, 'd'.repeat(64)));
  expect((await checkLayoutReferences(tab, api, () => false)).size).toBe(0);
  expect(target().revisionId).toBe('rev-3');
});
