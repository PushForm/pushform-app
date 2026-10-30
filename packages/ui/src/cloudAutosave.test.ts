// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CloudFilesError, type CloudFilesApi, type CloudSavedFile } from '@pushform/cloud';
import { openLayoutFile, openModelFile } from '@pushform/io';
import { createApp } from './bootstrap';
import { DocumentSession, type DocumentTab } from './session';
import { CloudAutosave } from './cloudAutosave';

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  // Keep the native writer's real SHA-256 results, without OS-thread scheduling outside the fake clock.
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (algorithm !== 'SHA-256') throw new Error('Unexpected digest algorithm');
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
  });
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  let account: string | null = 'alice', sequence = 0;
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
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
  const autosave = new CloudAutosave(api, session, () => account, () => {}, 100);
  cleanups.push(() => { autosave.dispose(); session.dispose(); });
  return { session, api, autosave, switchAccount: (value: string | null) => { account = value; } };
}
function edit(tab: DocumentTab, name: string): void {
  if (tab.type === 'model') tab.app.document.edit('Edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = name; });
  else tab.doc.transact('Edit', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = name; });
}
it('ignores the untouched startup placeholder and groups nearby edits into one native save', async () => {
  const { session, api, autosave } = setup();
  await vi.advanceTimersByTimeAsync(500); expect(api.save).not.toHaveBeenCalled();
  edit(session.active, 'First'); await vi.advanceTimersByTimeAsync(50); edit(session.active, 'Latest');
  await vi.advanceTimersByTimeAsync(99); expect(api.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(api.save).toHaveBeenCalledOnce();
  const state = (await openModelFile(api.save.mock.calls[0]![0].bytes)).state;
  expect(state.definitions.get(state.rootDefinitionId)!.name).toBe('Latest');
  expect(session.isDirty(session.active)).toBe(false); expect(autosave.state(session.active).status).toBe('saved');
});
it('automatically creates native revisions for new documents in the selected project', async () => {
  const { session, api, autosave } = setup(); const tab = session.newLayout();
  autosave.track(tab, 'selected-project'); await vi.advanceTimersByTimeAsync(100);
  expect(api.listProjects).not.toHaveBeenCalled();
  expect(api.save.mock.calls[0]![0]).toMatchObject({ projectId: 'selected-project', kind: 'layout' });
  expect((await openLayoutFile(api.save.mock.calls[0]![0].bytes)).state.pageOrder).toHaveLength(1);
});
it('cancels a queued revision when undo restores the previously saved content', async () => {
  const { session, api, autosave } = setup(); const tab = session.active;
  tab.identity = 'cloud:alice:project:file:revision'; edit(tab, 'Temporary edit');
  if (tab.type !== 'model') throw new Error('Expected model');
  tab.app.document.undo(); await vi.advanceTimersByTimeAsync(1000);
  expect(api.save).not.toHaveBeenCalled(); expect(autosave.state(tab).status).toBe('saved');
});
it('creates the Documents project only when needed and shares its lookup across tabs', async () => {
  const { session, api } = setup(); api.listProjects.mockResolvedValue([]);
  session.newModel(); session.newLayout(); await vi.advanceTimersByTimeAsync(100);
  expect(api.createProject).toHaveBeenCalledOnce(); expect(api.save).toHaveBeenCalledTimes(2);
  expect(api.save.mock.calls.map(([input]) => input.projectId)).toEqual(['documents', 'documents']);
});
it('serializes saves and uploads edits made during an in-flight save against the new revision', async () => {
  const { session, api, autosave } = setup(); const tab = session.active;
  let complete!: (saved: CloudSavedFile) => void;
  const implementation = api.save.getMockImplementation()!;
  api.save.mockImplementationOnce(input => new Promise(resolve => { complete = async saved => resolve({ ...saved,
    file: { ...saved.file, kind: input.kind, name: input.name } }); }));
  edit(tab, 'First'); await vi.advanceTimersByTimeAsync(100);
  edit(tab, 'During upload'); await vi.advanceTimersByTimeAsync(500);
  expect(api.save).toHaveBeenCalledOnce(); expect(autosave.state(tab).status).toBe('saving');
  const saved = await implementation(api.save.mock.calls[0]![0]); complete(saved);
  await vi.advanceTimersByTimeAsync(0); expect(session.isDirty(tab)).toBe(true);
  await vi.advanceTimersByTimeAsync(100); expect(api.save).toHaveBeenCalledTimes(2);
  expect(api.save.mock.calls[1]![0].parentRevisionId).toBe(saved.revision.id);
  expect(session.isDirty(tab)).toBe(false);
});
it('keeps changes in different tabs independent and flushes explicitly without waiting for the timer', async () => {
  const { session, api, autosave } = setup(); const a = session.active, b = session.newLayout();
  edit(a, 'Model edit'); edit(b, 'Drawing edit');
  await autosave.saveNow(a); expect(api.save).toHaveBeenCalledOnce(); expect(session.isDirty(b)).toBe(true);
  await vi.advanceTimersByTimeAsync(100); expect(api.save).toHaveBeenCalledTimes(2); expect(session.isDirty(b)).toBe(false);
});
it('queues offline changes and resumes them after reconnecting', async () => {
  const { session, api, autosave } = setup(); autosave.setOnline(false); edit(session.active, 'Offline edit');
  await vi.advanceTimersByTimeAsync(1000); expect(api.save).not.toHaveBeenCalled(); expect(autosave.state(session.active).status).toBe('offline');
  autosave.setOnline(true); await vi.advanceTimersByTimeAsync(100); expect(api.save).toHaveBeenCalledOnce();
});
it('retries a network failure with backoff and never marks failed content saved', async () => {
  const { session, api, autosave } = setup();
  api.save.mockRejectedValueOnce(new CloudFilesError('network', 'Connection lost'));
  edit(session.active, 'Edit'); await vi.advanceTimersByTimeAsync(100);
  expect(autosave.state(session.active).status).toBe('error'); expect(session.isDirty(session.active)).toBe(true);
  await vi.advanceTimersByTimeAsync(1999); expect(api.save).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(api.save).toHaveBeenCalledTimes(2); expect(session.isDirty(session.active)).toBe(false);
});
it('blocks automatic retries after a conflict, preserving dirty changes for explicit resolution', async () => {
  const { session, api, autosave } = setup(); api.save.mockRejectedValueOnce(new CloudFilesError('conflict', 'Newer cloud revision'));
  edit(session.active, 'Stale edit'); await vi.advanceTimersByTimeAsync(100);
  edit(session.active, 'More edits'); await vi.advanceTimersByTimeAsync(60000);
  expect(api.save).toHaveBeenCalledOnce(); expect(autosave.state(session.active).status).toBe('conflict'); expect(session.isDirty(session.active)).toBe(true);
});
it('cannot start a previous account save after an asynchronous project lookup', async () => {
  const { session, api, switchAccount } = setup(); let complete!: (value: []) => void;
  api.listProjects.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  edit(session.active, 'Private edit'); await vi.advanceTimersByTimeAsync(100);
  switchAccount('bob'); complete([]); await vi.advanceTimersByTimeAsync(10000);
  expect(api.createProject).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled(); expect(session.isDirty(session.active)).toBe(true);
});
it('stops queued work on session loss or disposal', async () => {
  const { session, api, autosave } = setup(); edit(session.active, 'Pending'); autosave.setEnabled(false);
  await vi.advanceTimersByTimeAsync(1000); expect(api.save).not.toHaveBeenCalled();
  autosave.setEnabled(true); autosave.dispose(); await vi.advanceTimersByTimeAsync(1000); expect(api.save).not.toHaveBeenCalled();
});
it('restores a pending first save and its selected project after a refresh without uploading a pristine placeholder', async () => {
  const { api } = setup(); const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const first = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  const pending = new CloudAutosave(api, first, () => 'alice', () => {}, 100);
  pending.setOnline(false); const draft = first.newLayout(); pending.track(draft, 'chosen-project');
  expect(draft.cloudDraft?.projectId).toBe('chosen-project'); pending.dispose(); first.dispose();
  const restored = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  const resumed = new CloudAutosave(api, restored, () => 'alice', () => {}, 100);
  cleanups.push(() => { resumed.dispose(); restored.dispose(); });
  await vi.advanceTimersByTimeAsync(100);
  expect(api.save).toHaveBeenCalledOnce(); expect(api.save.mock.calls[0]![0].projectId).toBe('chosen-project');
  expect(restored.tabs.find(tab => tab.type === 'layout')?.cloudDraft).toBeUndefined();
});
it('continues the same cloud document when the page crashes after a first save commits but before it is recorded', async () => {
  const { api } = setup(); const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  // The server: a first save with a key it has seen continues that key's document.
  const documents = new Set<string>(), byKey = new Map<string, string>();
  let crashed: Map<string, string> | undefined;
  api.save.mockImplementation(async input => {
    const id = input.fileId ?? (input.clientKey && byKey.get(input.clientKey)) ?? `file-${documents.size + 1}`;
    documents.add(id); if (input.clientKey) byKey.set(input.clientKey, id);
    const saved: CloudSavedFile = { file: { id, project_id: input.projectId, folder_id: null, name: input.name, kind: input.kind,
      current_revision_id: 'revision', revision_number: 1, size_bytes: input.bytes.length, updated_at: '' },
    revision: { id: 'revision', document_id: id, blob_path: '', size_bytes: input.bytes.length, sha256: '', number: 1 } };
    if (crashed) return saved;
    // The commit succeeded, then the page died: only what was already in storage survives.
    crashed = new Map(records); return new Promise<CloudSavedFile>(() => {});
  });
  const first = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  // As in the app, the refresh snapshot is written before the debounced save starts.
  const pending = new CloudAutosave(api, first, () => 'alice', () => {}, 1000);
  const draft = first.newLayout(); pending.track(draft, 'chosen-project'); edit(draft, 'Before the crash');
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.save).toHaveBeenCalledOnce(); expect(crashed).toBeDefined();
  pending.dispose(); first.dispose(); records.clear(); crashed!.forEach((value, key) => records.set(key, value));
  const restored = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  const resumed = new CloudAutosave(api, restored, () => 'alice', () => {}, 100);
  cleanups.push(() => { resumed.dispose(); restored.dispose(); });
  await vi.advanceTimersByTimeAsync(100);
  expect(api.save).toHaveBeenCalledTimes(2);
  const [before, after] = api.save.mock.calls.map(([input]) => input);
  expect(before!.clientKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(after!.clientKey).toBe(before!.clientKey);
  expect([...documents]).toEqual(['file-1']);
  const layout = restored.tabs.find(tab => tab.type === 'layout');
  expect(layout?.identity).toContain(':file-1:'); expect(layout?.cloudDraft).toBeUndefined();
});
it('keeps the startup document first-save key in the refresh snapshot before its debounced save starts', async () => {
  const { api } = setup(); const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
  const autosave = new CloudAutosave(api, session, () => 'alice', () => {}, 1000);
  cleanups.push(() => { autosave.dispose(); session.dispose(); });
  expect(session.active.cloudDraft).toBeUndefined();
  edit(session.active, 'First edit'); await vi.advanceTimersByTimeAsync(999);
  expect(api.save).not.toHaveBeenCalled();
  const key = session.active.cloudDraft?.key; expect(key).toBeDefined();
  expect([...records.values()].some(value => value.includes(key!))).toBe(true);
  await vi.advanceTimersByTimeAsync(1); expect(api.save.mock.calls[0]![0].clientKey).toBe(key);
});
it('resumes automatic saving after a conflicting tab is saved as a separate cloud copy', async () => {
  const { session, api, autosave } = setup(); const tab = session.active;
  tab.identity = 'cloud:alice:project:original:old-revision';
  api.save.mockRejectedValueOnce(new CloudFilesError('conflict', 'Newer cloud revision'));
  edit(tab, 'Conflict'); await vi.advanceTimersByTimeAsync(100); autosave.pause(tab, true);
  session.markModelSaved(tab.id, 'Copy.pf', 'cloud:alice:project:copy:copy-revision');
  autosave.pause(tab, false); edit(tab, 'Edit copy'); await vi.advanceTimersByTimeAsync(100);
  expect(api.save).toHaveBeenCalledTimes(2); expect(api.save.mock.calls[1]![0]).toMatchObject({ fileId: 'copy', parentRevisionId: 'copy-revision' });
});
it('settles an explicit flush when its account workspace is disposed during project lookup', async () => {
  const { session, api, autosave } = setup(); let complete!: (value: []) => void;
  api.listProjects.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  edit(session.active, 'Pending edit');
  const saving = autosave.saveNow(session.active);
  const rejected = expect(saving).rejects.toThrow('unavailable');
  await vi.advanceTimersByTimeAsync(0); autosave.dispose(); complete([]);
  await rejected; expect(api.save).not.toHaveBeenCalled();
});
it('saves every document with pending changes at once, leaving the untouched placeholder alone', async () => {
  const { session, api, autosave } = setup(); const placeholder = session.active;
  const model = session.newModel(); const layout = session.newLayout(); edit(model, 'Model'); edit(layout, 'Layout');
  await autosave.saveAll();
  expect(api.save).toHaveBeenCalledTimes(2); expect(autosave.hasPending()).toBe(false);
  expect(api.save.mock.calls.map(call => call[0].kind).sort()).toEqual(['layout', 'model']);
  expect(session.isDirty(placeholder)).toBe(false);
});
it('rejects saving everything when a document cannot be saved, keeping its changes', async () => {
  const { session, api, autosave } = setup(); const model = session.newModel(); edit(model, 'Model');
  api.save.mockRejectedValueOnce(new CloudFilesError('conflict', 'Changed elsewhere'));
  await expect(autosave.saveAll()).rejects.toThrow('Changed elsewhere');
  expect(autosave.hasPending()).toBe(true);
});
it.each(['model', 'layout'] as const)('persists a %s tab rename to the same cloud file without content edits', async type => {
  const { session, api, autosave } = setup();
  const tab = type === 'model' ? session.active : session.newLayout();
  await autosave.saveNow(tab);
  const identity = tab.identity;
  session.rename(tab.id, 'Renamed');
  expect(session.isDirty(tab)).toBe(false);
  expect(autosave.hasPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(api.save.mock.calls.at(-1)![0]).toMatchObject({ name: `Renamed.${type === 'model' ? 'pf' : 'pfl'}`, fileId: identity!.split(':')[3] });
  expect(autosave.hasPending()).toBe(false);
});
it('keeps a rename made during upload pending and saves it against the resulting revision', async () => {
  const { session, api, autosave } = setup();
  const tab = session.active;
  let finish!: (saved: CloudSavedFile) => void;
  const implementation = api.save.getMockImplementation()!;
  api.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  session.rename(tab.id, 'First');
  await vi.advanceTimersByTimeAsync(100);
  session.rename(tab.id, 'Latest');
  const saved = await implementation(api.save.mock.calls[0]![0]);
  finish(saved);
  await vi.advanceTimersByTimeAsync(0);
  expect(tab.name).toBe('Latest.pf');
  expect(autosave.hasPending()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(api.save.mock.calls[1]![0]).toMatchObject({ name: 'Latest.pf', parentRevisionId: saved.revision.id });
});
it('stops saving a file that is in the Trash, keeps the work, and saves again after Restore', async () => {
  const { session, api, autosave } = setup();
  const restore = vi.fn(async () => {});
  (api as CloudFilesApi).restore = restore;
  const tab = session.active;
  edit(tab, 'First'); await vi.advanceTimersByTimeAsync(100);
  expect(api.save).toHaveBeenCalledOnce();
  api.save.mockRejectedValueOnce(new CloudFilesError('trashed', 'This file is in the Trash. Restore it from Home to open or save it.'));
  edit(tab, 'Trashed meanwhile'); await vi.advanceTimersByTimeAsync(100);
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(autosave.state(tab)).toMatchObject({ status: 'error', code: 'trashed', error: expect.stringContaining('in the Trash') });
  // No retry while the file is in the Trash; the work stays on the device.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(session.isDirty(tab)).toBe(true);
  await autosave.restore(tab);
  expect(restore).toHaveBeenCalledWith('document', 'file-1');
  expect(api.save).toHaveBeenCalledTimes(3);
  expect(api.save.mock.calls[2]![0]).toMatchObject({ fileId: 'file-1' });
  expect(autosave.state(tab)).toMatchObject({ status: 'saved' });
  expect(autosave.state(tab).code).toBeUndefined();
});
