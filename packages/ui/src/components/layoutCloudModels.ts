// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CloudFile, CloudFilesApi, CloudSavedFile } from '@pushform/cloud';
import { readPreservedSketchUpModel, readSketchUpInWorker } from '@pushform/io';
import {
  detachedLayoutModelAnnotation, isCloudReference, isCloudSource, isViewport, viewportCacheCurrent, viewportCloudReference,
  type CloudModelReference, type LayoutDocumentState, type LayoutEntity,
} from '@pushform/layout';
import { cloudLocation, findOrCreateDocumentsProject, openCloudDocument, saveCloudDocument } from '../cloudDocuments';
import type { DocumentSession, LayoutTab } from '../session';
import type { ModelClipboardView } from '../modelClipboard';
import { DEFAULT_CAMERA } from '@pushform/render';
import { croppedViewportCamera } from './layoutViewportCameras';
import { layoutViewportRender } from './layoutViewportRenders';

/**
 * Cloud model references of a Layout document.
 * A reference names a saved revision of a PushForm model; views render from it on demand and keep
 * their raster in the document, so a drawing opens without fetching any model.
 */

/** Cloud access a Layout workspace needs; absent when the host supplied no cloud files. */
export interface LayoutCloudAccess { api: CloudFilesApi; owner: () => string | null; session: DocumentSession }

export type LayoutReferenceStatus =
  | { kind: 'checking' }
  | { kind: 'current' }
  /** A pinned reference whose model has a newer saved revision. */
  | { kind: 'outdated'; head: CloudSavedFile }
  | { kind: 'missing'; reason: string };

const revisionOf = (head: CloudSavedFile) => ({ revisionId: head.revision.id, revisionNumber: head.revision.number ?? head.file.revision_number, sha256: head.revision.sha256 });

/**
 * Compare every cloud reference with its model's current revision. A reference that
 * follows the latest revision moves to it without an undo step; a pinned one is reported outdated.
 */
export async function checkLayoutReferences(tab: LayoutTab, api: CloudFilesApi, live: () => boolean = () => true): Promise<Map<number, LayoutReferenceStatus>> {
  const statuses = new Map<number, LayoutReferenceStatus>();
  const references = [...tab.doc.state.references.values()].filter(isCloudReference);
  await Promise.all(references.map(async reference => {
    try {
      const head = await api.head(reference.target.documentId);
      if (!live()) return;
      const current = tab.doc.state.references.get(reference.id);
      if (!isCloudReference(current)) return;
      if (head.revision.id === current.target.revisionId) { statuses.set(reference.id, { kind: 'current' }); return; }
      if (current.target.pinned) { statuses.set(reference.id, { kind: 'outdated', head }); return; }
      tab.commands.execute('layout.reference.follow', { referenceId: reference.id, ...revisionOf(head) });
      statuses.set(reference.id, { kind: 'current' });
    } catch (error) {
      if (live()) statuses.set(reference.id, { kind: 'missing', reason: error instanceof Error ? error.message : 'The model could not be reached.' });
    }
  }));
  return statuses;
}

/** Move a pinned reference to its model's current revision explicitly; one undoable step. */
export function updateLayoutReference(tab: LayoutTab, referenceId: number, head: CloudSavedFile): void {
  tab.commands.execute('layout.reference.update', { referenceId, ...revisionOf(head) });
}

/** Link a cloud model document to the drawing at its current revision, or reuse its existing reference. */
export async function linkCloudModel(tab: LayoutTab, api: CloudFilesApi, file: Pick<CloudFile, 'id' | 'name'>): Promise<number> {
  const head = await api.head(file.id);
  return tab.commands.execute('layout.reference.add', { displayName: file.name.replace(/\.pf$/i, ''), documentId: file.id, ...revisionOf(head) }) as number;
}

/**
 * Store finished renders of cloud views whose picture is stale in the document.
 * Returns how many pictures were stored; the renders it requests arrive through the image loads.
 */
export function persistLayoutViewportRenders(tab: LayoutTab): number {
  const state = tab.doc.state;
  let stored = 0;
  const stores: [number, Iterable<LayoutEntity>][] = [...state.pages.values()].map(page => [page.id, page.entities.values()] as [number, Iterable<LayoutEntity>]);
  const firstPage = state.pageOrder[0];
  if (firstPage !== undefined) stores.push([firstPage, state.sharedEntities.values()]);
  for (const [pageId, entities] of stores) for (const entity of entities) {
    if (!isViewport(entity) || !isCloudSource(entity.image.viewport.source)) continue;
    if (entity.image.src && viewportCacheCurrent(entity.image.viewport, entity.points, state)) continue;
    const render = layoutViewportRender(state, entity);
    if (!render) continue;
    tab.commands.execute('layout.viewport.snapshot', { pageId, entityId: entity.id, src: render.src, cache: render.cache });
    stored++;
  }
  return stored;
}

/** A copied cloud view carries its reference so it can be pasted into another drawing. */
export function layoutClipboardEntity(entity: LayoutEntity, state: LayoutDocumentState): LayoutEntity {
  if (!isViewport(entity)) return detachedLayoutModelAnnotation(entity);
  const reference = viewportCloudReference(state, entity.image.viewport.source);
  if (!reference) return entity;
  const source = { referenceId: reference.id, reference: { displayName: reference.displayName, target: { ...reference.target } } };
  return { ...entity, image: { ...entity.image, viewport: { ...entity.image.viewport, source: source as unknown as typeof entity.image.viewport.source } } };
}

/** Open the referenced model for editing in its own tab; edits reach the views once saved. */
export async function openReferencedModel(reference: CloudModelReference, cloud: LayoutCloudAccess): Promise<void> {
  const head = await cloud.api.head(reference.target.documentId);
  await openCloudDocument(cloud.api, cloud.session, head.file, cloud.owner);
}

/**
 * Make an embedded SketchUp model editable (note, user decision 2026-10-26): convert it to a
 * PushForm model saved in the drawing's project, link it, and move every view of it to that link.
 * The original package stays in the document for LayOut export of untouched views and for relinking.
 */
export async function convertEmbeddedModel(tab: LayoutTab, source: { archiveId: string; modelReferenceId: string }, name: string,
  cloud: LayoutCloudAccess): Promise<number> {
  const bytes = readPreservedSketchUpModel(tab.doc.state, source.archiveId, source.modelReferenceId);
  if (!bytes) throw new Error('The model is linked to an external file that is not embedded in this document.');
  const scene = await readSketchUpInWorker(bytes);
  const ownerId = cloud.owner();
  if (!ownerId) throw new Error('Sign in again to convert the model.');
  const location = cloudLocation(tab.identity);
  const projectId = location?.ownerId === ownerId ? location.projectId : await findOrCreateDocumentsProject(cloud.api);
  const { tab: modelTab } = cloud.session.openSketchUpModel(scene, name);
  const saved = await saveCloudDocument(cloud.api, cloud.session, modelTab, cloud.owner, projectId, name);
  if (!cloud.session.tabs.includes(tab)) throw new Error('The drawing was closed before the model was linked.');
  const referenceId = tab.commands.execute('layout.reference.add', { displayName: saved.file.name.replace(/\.pf$/i, ''), documentId: saved.file.id, ...revisionOf(saved) }) as number;
  tab.commands.execute('layout.viewport.relink', { source, referenceId });
  cloud.session.activate(modelTab.id);
  return referenceId;
}

/**
 * A view of the cloud model a Modeling copy came from, with its camera cropped to the
 * copy, centered on the page and linking the model's last saved revision in one undoable step.
 */
export async function pasteModelView(tab: LayoutTab, api: CloudFilesApi, pageId: number, view: ModelClipboardView): Promise<number> {
  if (!view.source) throw new Error('Save the model to the cloud before pasting it into Layout.');
  const head = await api.head(view.source.documentId);
  const page = tab.doc.state.pages.get(pageId);
  if (!page) throw new Error('The page is no longer available.');
  const [pageWidth, pageHeight] = page.size;
  const { camera, width, height } = croppedViewportCamera(view.camera ?? DEFAULT_CAMERA, view.extent, pageWidth / 2, pageHeight / 2);
  const left = (pageWidth - width) / 2, top = (pageHeight - height) / 2;
  return tab.commands.execute('layout.viewport.add', {
    pageId, first: [left, top], second: [left + width, top + height], camera, scene: null,
    source: { model: { displayName: view.source.name.replace(/\.pf$/i, '') || 'Model', documentId: view.source.documentId, ...revisionOf(head) } },
  }) as number;
}
