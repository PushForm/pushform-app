// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cloudFileName, CloudFilesError, type CloudFile, type CloudFilesApi, type CloudSavedFile } from '@pushform/cloud';
import { encodeLayoutSnapshot, encodeModelSnapshot, modelArchiveImages, openLayoutFile, openModelFile } from '@pushform/io';
import { layoutContentKey, modelContentKey } from './documentContent';
import type { DocumentSession, DocumentTab, LayoutTab } from './session';

export interface CloudLocation { ownerId: string; projectId: string; fileId: string; revisionId: string }
export function cloudLocation(identity?: string): CloudLocation | null {
  const parts = identity?.split(':');
  if (!parts || parts.length !== 5 || parts[0] !== 'cloud' || parts.slice(1).some(p => !p)) return null;
  return { ownerId: parts[1]!, projectId: parts[2]!, fileId: parts[3]!, revisionId: parts[4]! };
}
function cloudIdentity(ownerId: string, saved: CloudSavedFile): string {
  return `cloud:${ownerId}:${saved.file.project_id}:${saved.file.id}:${saved.revision.id}`;
}
/** Capture source tab and its saved baseline before the first await, not the tab active on completion. */
export async function saveCloudDocument(api: CloudFilesApi, session: DocumentSession, tab: DocumentTab,
  owner: () => string | null, projectId: string, name: string, copy = false, folderId: string | null = null): Promise<CloudSavedFile> {
  const ownerId = owner();
  if (!ownerId) throw new CloudFilesError('auth', 'Sign in again to save cloud files.');
  const originalName = tab.name;
  const location = cloudLocation(tab.identity);
  if (!copy && location && location.ownerId !== ownerId)
    throw new CloudFilesError('auth', 'This file belongs to a different account. Save a new cloud copy in your account.');
  // Capture the baseline and immutable state before yielding. Modeling's semantic digest stays
  // separate from its binary payload; later edits cannot be marked saved by this upload.
  const savedContent = tab.type === 'model' ? modelContentKey(tab.app.document.doc) : layoutContentKey(tab.doc);
  const encoding = tab.type === 'model'
    ? encodeModelSnapshot(tab.app.document.doc.state, modelArchiveImages(tab.app.document.doc.state, tab.app.document.images))
    : encodeLayoutSnapshot(tab.doc.state);
  const fileName = cloudFileName(name, tab.type);
  const update = !copy && location && location.projectId === projectId;
  const bytes = await encoding;
  if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
  const saved = await api.save({ projectId, name: fileName, kind: tab.type, bytes, folderId: update ? undefined : folderId,
    fileId: update ? location.fileId : undefined, parentRevisionId: update ? location.revisionId : undefined,
    // A pending first save retried after a crash continues the document it created.
    clientKey: !copy && !location ? tab.cloudDraft?.key : undefined });
  if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
  if (!session.tabs.includes(tab)) return saved;
  const identity = cloudIdentity(ownerId, saved);
  if (tab.type === 'model') session.markModelSaved(tab.id, tab.name === originalName ? saved.file.name : tab.name, identity, savedContent);
  else session.markLayoutSaved(tab.id, tab.name === originalName ? saved.file.name : tab.name, identity, savedContent);
  return saved;
}
export async function openCloudDocument(api: CloudFilesApi, session: DocumentSession, file: CloudFile,
  owner: () => string | null): Promise<DocumentTab> {
  const ownerId = owner();
  if (!ownerId) throw new CloudFilesError('auth', 'Sign in again to open cloud files.');
  const existing = (): DocumentTab | undefined => file.is_template ? undefined : session.tabs.find(tab => {
    const location = cloudLocation(tab.identity);
    return location?.ownerId === ownerId && location.fileId === file.id;
  });
  const activate = (tab: DocumentTab): DocumentTab => { session.activate(tab.id); return tab; };
  const current = existing(); if (current) return activate(current);
  return session.loading.run(file.name, 'Downloading file…', async stage => {
    const saved = await api.open(file.id);
    if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
    const openedDuringDownload = existing(); if (openedDuringDownload) return activate(openedDuringDownload);
    const identity = cloudIdentity(ownerId, saved);
    await stage('Reading document…');
    // Decode off the UI thread; the returned digest seeds the saved baseline,
    // so opening does not repeat content hashing on the main thread.
    if (saved.file.kind === 'model') {
      const opened = await openModelFile(saved.bytes);
      if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
      await stage('Preparing workspace…');
      if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
      const openedDuringDecode = existing(); if (openedDuringDecode) return activate(openedDuringDecode);
      return session.openModelFile(opened, saved.file.name, identity);
    }
    const opened = await openLayoutFile(saved.bytes);
    if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
    await stage('Preparing workspace…');
    if (owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Reopen cloud files after signing in.');
    if (saved.file.is_template) {
      return session.newLayoutFromTemplate(opened, saved.file.project_id, saved.file.folder_id);
    }
    const openedDuringDecode = existing(); if (openedDuringDecode) return activate(openedDuringDecode);
    return session.openLayoutFile(opened, saved.file.name, identity);
  });
}

/** Save a snapshot without changing the source tab's name, identity, saved baseline or undo history. */
export async function saveCloudLayoutTemplate(api: CloudFilesApi, tab: LayoutTab, owner: () => string | null,
  projectId: string, name: string, clientKey: string): Promise<CloudSavedFile> {
  const ownerId = owner();
  const check = (): void => {
    if (!ownerId || owner() !== ownerId) throw new CloudFilesError('auth', 'Your account session changed. Sign in again to save a template.');
  };
  check();
  const fileName = cloudFileName(name, 'layout');
  const bytes = await encodeLayoutSnapshot(tab.doc.state);
  check();
  const saved = await api.save({ projectId, name: fileName, kind: 'layout', bytes, isTemplate: true, clientKey });
  check();
  return saved;
}

/**
 * The account's Documents project, created on first use. `check` runs between requests so
 * a changed account session aborts before anything is created under the wrong owner.
 */
export async function findOrCreateDocumentsProject(api: CloudFilesApi, check: () => void = () => {}): Promise<string> {
  const find = async (): Promise<string | undefined> => {
    check(); const projects = await api.listProjects(); check();
    return projects.find(p => p.name.toLowerCase() === 'documents')?.id;
  };
  const existing = await find(); if (existing) return existing;
  try { check(); return (await api.createProject('Documents')).id; }
  catch (error) { const raced = await find(); if (raced) return raced; throw error; }
}
