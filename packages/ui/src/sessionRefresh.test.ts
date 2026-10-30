// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudFilesApi } from '@pushform/cloud';
import { meshBox } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import { createApp } from './bootstrap';
import { DocumentSession, REFRESH_PERSIST_DELAY_MS, type DocumentTab, type ModelTab } from './session';
import { CloudAutosave } from './cloudAutosave';
import { contentSerializations, resetContentSerializations } from './documentContent';
import { encodeLayoutDocument, encodeModelDocument, runNativeFileRequest } from '@pushform/io';
import { createLayoutDocument } from '@pushform/layout';

const SNAPSHOT_KEY = 'pushform:document-session:v2';

/** Session storage with a per-value size limit, counting every write attempt per key. */
class QuotaStorage {
  values = new Map<string, string>();
  attempts = new Map<string, number>();
  constructor(private readonly limit: number) {}
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    if (value.length > this.limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string): void { this.values.delete(key); }
  snapshotAttempts(): number { return this.attempts.get(SNAPSHOT_KEY) ?? 0; }
}

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers(); resetContentSerializations();
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (algorithm !== 'SHA-256') throw new Error('Unexpected digest algorithm');
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
  });
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks(); });

function makeSession(storage: QuotaStorage): DocumentSession {
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  cleanups.push(() => session.dispose());
  return session;
}

function setup(limit: number) {
  const storage = new QuotaStorage(limit);
  const session = makeSession(storage);
  let sequence = 0;
  const api = {
    listProjects: vi.fn<CloudFilesApi['listProjects']>().mockResolvedValue([{ id: 'documents', name: 'Documents' }]),
    createProject: vi.fn<CloudFilesApi['createProject']>().mockResolvedValue({ id: 'documents', name: 'Documents' }),
    listFiles: vi.fn<CloudFilesApi['listFiles']>(), open: vi.fn<CloudFilesApi['open']>(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn<CloudFilesApi['recordImport']>(), listFolders: vi.fn<CloudFilesApi['listFolders']>(), createFolder: vi.fn<CloudFilesApi['createFolder']>(),
    save: vi.fn<CloudFilesApi['save']>().mockImplementation(async input => {
      sequence++;
      return { file: { id: input.fileId ?? `file-${sequence}`, project_id: input.projectId, folder_id: null, name: input.name, kind: input.kind,
        current_revision_id: `revision-${sequence}`, revision_number: sequence, size_bytes: input.bytes.length, updated_at: '' },
      revision: { id: `revision-${sequence}`, document_id: input.fileId ?? `file-${sequence}`, blob_path: '', size_bytes: input.bytes.length, sha256: '', number: sequence } };
    }),
  };
  const autosave = new CloudAutosave(api, session, () => 'alice', () => {}, 100);
  cleanups.unshift(() => autosave.dispose());
  return { storage, session, api, autosave };
}

/** A model large enough that its snapshot is far beyond a small quota. */
function addBoxes(tab: DocumentTab, count: number): void {
  if (tab.type !== 'model') throw new Error('expected a model tab');
  tab.app.document.edit('Add boxes', draft => {
    const container = draft.definitions.get(draft.rootDefinitionId)!.entities;
    for (let i = 0; i < count; i++) bodyFromMesh(draft, meshBox([i * 2, 0, 0], [i * 2 + 1, 1, 1]), { container });
  });
}

const bodyCount = (tab: DocumentTab): number =>
  tab.type === 'model' ? tab.app.document.doc.rootDefinition.entities.bodies.size : -1;

it('serializes an unchanged document once across autosave scans, activations and the refresh snapshot', async () => {
  const { storage, session, api, autosave } = setup(Infinity);
  const model = session.active as ModelTab;
  resetContentSerializations();
  addBoxes(model, 60);
  const layout = session.newLayout();
  for (let i = 0; i < 5; i++) { session.activate(model.id); session.activate(layout.id); }
  session.reorderTab(layout.id, 0);
  session.setActivePage(layout.activePageId);
  // Every notification above checked dirtiness through autosave and nothing was written yet.
  expect(storage.snapshotAttempts()).toBe(0);
  expect(contentSerializations).toEqual({ modelIdentity: 1, layoutIdentity: 1, modelSessionJson: 0, layoutJson: 0 });

  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  await autosave.saveNow(model);
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(session.isDirty(model)).toBe(false); expect(session.isDirty(layout)).toBe(false);
  expect(storage.snapshotAttempts()).toBe(1);
  // The save completions changed the saved baseline, not the content: no further serialization.
  expect(contentSerializations).toEqual({ modelIdentity: 1, layoutIdentity: 1, modelSessionJson: 1, layoutJson: 1 });

  // Metadata-only notifications persist later without re-serializing anything.
  session.activate(model.id);
  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  expect(storage.snapshotAttempts()).toBe(2);
  expect(contentSerializations).toEqual({ modelIdentity: 1, layoutIdentity: 1, modelSessionJson: 1, layoutJson: 1 });

  // The hand-assembled snapshot restores every tab, the active one, and the model geometry.
  session.dispose(); cleanups.splice(0);
  const restored = makeSession(storage);
  expect(restored.tabs.map(tab => tab.name)).toEqual([layout.name, model.name]);
  expect(restored.active.name).toBe(model.name);
  expect(bodyCount(restored.active)).toBe(60);
  expect(restored.isDirty(restored.active)).toBe(false);
  expect(restored.tabs[0]?.identity).toBe(layout.identity);
});

it('saves to the cloud when session storage rejects the refresh snapshot, and retries it only after a content change', async () => {
  const { storage, session, api, autosave } = setup(20_000);
  const model = session.active;
  addBoxes(model, 60);
  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  await autosave.saveNow(model);
  expect(api.save).toHaveBeenCalledOnce();
  expect(session.isDirty(model)).toBe(false);
  expect(autosave.state(model).status).toBe('saved');
  expect(storage.snapshotAttempts()).toBe(1);
  expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();

  // Switching tabs changes only metadata: the oversized snapshot is not offered again.
  const layout = session.newLayout();
  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  expect(storage.snapshotAttempts()).toBe(2);
  for (let i = 0; i < 5; i++) {
    session.activate(model.id); session.activate(layout.id);
    await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  }
  expect(storage.snapshotAttempts()).toBe(2);

  // A content change is tried again, saved to the cloud regardless, and rejected again.
  addBoxes(model, 1);
  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  await autosave.saveNow(model);
  expect(api.save).toHaveBeenCalledTimes(3);
  expect(session.isDirty(model)).toBe(false);
  expect(storage.snapshotAttempts()).toBe(3);
  expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
});

it('flushes the pending snapshot when the page is hidden or unloaded', async () => {
  const storage = new QuotaStorage(Infinity);
  const session = makeSession(storage);
  const model = session.active;
  addBoxes(model, 2);
  expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
  window.dispatchEvent(new Event('pagehide'));
  expect(storage.snapshotAttempts()).toBe(1);
  const written = JSON.parse(storage.getItem(SNAPSHOT_KEY)!) as { tabs: { dirty?: boolean }[] };
  expect(written.tabs[0]?.dirty).toBe(true);

  // The scheduled flush then has nothing new to write.
  await vi.advanceTimersByTimeAsync(REFRESH_PERSIST_DELAY_MS);
  expect(storage.snapshotAttempts()).toBe(1);

  session.newLayout();
  window.dispatchEvent(new Event('beforeunload'));
  expect(storage.snapshotAttempts()).toBe(2);
  expect((JSON.parse(storage.getItem(SNAPSHOT_KEY)!) as { tabs: unknown[] }).tabs).toHaveLength(2);
});

it('seeds the content cache from a worker-decoded file, so opening and the first dirty check serialize nothing', () => {
  const { session } = setup(1_000_000);
  const source = session.tabs[0]!;
  addBoxes(source, 20);
  const modelBytes = encodeModelDocument(source.type === 'model' ? source.app.document.doc : (() => { throw new Error('model'); })());
  const layoutBytes = encodeLayoutDocument(createLayoutDocument());
  const openedModel = runNativeFileRequest({ type: 'decode-model', bytes: modelBytes });
  const openedLayout = runNativeFileRequest({ type: 'decode-layout', bytes: layoutBytes });
  resetContentSerializations();
  const model = session.openModelFile(openedModel, 'Opened.pf', 'cloud:alice:p:f1:r1');
  const layout = session.openLayoutFile(openedLayout, 'Opened.pfl', 'cloud:alice:p:f2:r1');
  // addModelTab/addLayoutTab emit synchronously, which runs the autosave scan and its dirty checks.
  expect(session.isDirty(model)).toBe(false);
  expect(session.isDirty(layout)).toBe(false);
  expect(bodyCount(model)).toBe(20);
  expect(contentSerializations).toEqual({ modelIdentity: 0, layoutIdentity: 0, modelSessionJson: 0, layoutJson: 0 });
  // Reopening the same identity activates the existing tab without decoding again.
  expect(session.openModelFile(openedModel, 'Opened.pf', 'cloud:alice:p:f1:r1')).toBe(model);
  expect(session.activeId).toBe(model.id);
});
