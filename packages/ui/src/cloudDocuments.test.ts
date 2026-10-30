// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudFilesApi, CloudSavedFile } from '@pushform/cloud';
import { openLayoutFile, openModelFile, encodeModelSnapshot, modelArchiveImages, encodeLayoutDocument } from '@pushform/io';
import { createApp } from './bootstrap';
import { DocumentSession } from './session';
import { cloudLocation, openCloudDocument, saveCloudDocument, saveCloudLayoutTemplate } from './cloudDocuments';
import { CloudAutosave } from './cloudAutosave';
const sessions: DocumentSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); });
function setup() {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), true, null);
  sessions.push(session);
  const saved: CloudSavedFile = { file: { id: 'file', project_id: 'project', folder_id: null, name: 'Plan.pfl', kind: 'layout',
    current_revision_id: 'revision', revision_number: 1, size_bytes: 3, updated_at: '' },
    revision: { id: 'revision', document_id: 'file', blob_path: '', size_bytes: 3, sha256: '', number: 1 } };
  const api = { save: vi.fn<CloudFilesApi['save']>().mockResolvedValue(saved),
    open: vi.fn<CloudFilesApi['open']>(), listProjects: vi.fn(), createProject: vi.fn(), listFiles: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(), listFolders: vi.fn(), createFolder: vi.fn() };
  return { session, api, saved };
}
it('writes valid native bytes for both document kinds and records a cloud destination', async () => {
  const { session, api, saved } = setup(); const model = session.active;
  saved.file.kind = 'model'; saved.file.name = 'Model.pf';
  await saveCloudDocument(api, session, model, () => 'alice', 'project', 'Model');
  expect(new TextDecoder().decode(api.save.mock.calls[0]![0].bytes.subarray(0, 8))).toBe('PUSHFRM2');
  expect((await openModelFile(api.save.mock.calls[0]![0].bytes)).state).toBeTruthy();
  expect(cloudLocation(model.identity)).toEqual({ ownerId: 'alice', projectId: 'project', fileId: 'file', revisionId: 'revision' });
  const layout = session.newLayout(); saved.file.kind = 'layout'; saved.file.name = 'Plan.pfl';
  await saveCloudDocument(api, session, layout, () => 'alice', 'project', 'Plan');
  expect((await openLayoutFile(api.save.mock.calls[1]![0].bytes)).state.pageOrder).toHaveLength(1);
  expect(session.isDirty(layout)).toBe(false);
});
it('marks the captured tab and snapshot saved, keeping edits made during upload dirty', async () => {
  const { session, api, saved } = setup(); const layout = session.newLayout();
  let complete!: (value: CloudSavedFile) => void; api.save.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const saving = saveCloudDocument(api, session, layout, () => 'alice', 'project', 'Plan');
  // Edits during encoding (before the upload starts) and during the upload both stay dirty.
  session.newModel(); layout.doc.transact('Edit while encoding', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'Newer edits'; });
  await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  layout.doc.transact('Edit while uploading', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'Even newer edits'; });
  expect((await openLayoutFile(api.save.mock.calls[0]![0].bytes)).state.pages.get(layout.doc.state.pageOrder[0]!)!.name).not.toBe('Newer edits');
  complete(saved); await saving;
  expect(layout.name).toBe('Plan.pfl'); expect(session.isDirty(layout)).toBe(true);
  expect(session.active.type).toBe('model'); expect(session.active.identity).toBeUndefined();
});
it('leaves identity and dirty state unchanged after failure or an account switch', async () => {
  const { session, api, saved } = setup(); const tab = session.newLayout();
  tab.doc.transact('Edit', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'New'; });
  api.save.mockRejectedValueOnce(new Error('Upload failed'));
  await expect(saveCloudDocument(api, session, tab, () => 'alice', 'project', 'Plan')).rejects.toThrow('Upload failed');
  expect(tab.identity).toBeUndefined(); expect(session.isDirty(tab)).toBe(true);
  let owner = 'alice'; api.save.mockImplementation(async () => { owner = 'bob'; return saved; });
  await expect(saveCloudDocument(api, session, tab, () => owner, 'project', 'Plan')).rejects.toThrow('account session changed');
  expect(tab.identity).toBeUndefined(); expect(session.isDirty(tab)).toBe(true);
});
it('passes the expected revision and supports an explicit new cloud copy', async () => {
  const { session, api } = setup(); const tab = session.newLayout();
  tab.identity = 'cloud:alice:project:file:revision-old';
  await saveCloudDocument(api, session, tab, () => 'alice', 'project', 'Plan');
  expect(api.save.mock.calls[0]![0].parentRevisionId).toBe('revision-old');
  await saveCloudDocument(api, session, tab, () => 'alice', 'project', 'Plan copy', true);
  expect(api.save.mock.calls[1]![0].fileId).toBeUndefined();
  await expect(saveCloudDocument(api, session, tab, () => 'bob', 'project', 'Plan')).rejects.toThrow('different account');
});
it('opens into a new tab and activates an already-open file without replacing unsaved edits', async () => {
  const { session, api, saved } = setup(); saved.file.kind = 'model'; saved.file.name = 'Model.pf';
  const source = session.active; if (source.type !== 'model') throw new Error('Expected initial model');
  api.open.mockResolvedValue({ ...saved, bytes: await encodeModelSnapshot(source.app.document.doc.state, modelArchiveImages(source.app.document.doc.state)) });
  const tab = await openCloudDocument(api, session, saved.file, () => 'alice');
  expect(session.tabs).toHaveLength(2); expect(session.isDirty(tab)).toBe(false);
  if (tab.type === 'model') tab.app.document.doc.transact('Edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Unsaved'; });
  session.newLayout(); const same = await openCloudDocument(api, session, saved.file, () => 'alice');
  expect(same).toBe(tab); expect(api.open).toHaveBeenCalledOnce(); expect(session.isDirty(tab)).toBe(true);
});
it('rejects corrupt downloads before changing document tabs', async () => {
  const { session, api, saved } = setup(); api.open.mockResolvedValue({ ...saved, bytes: new Uint8Array([0, 1]) });
  await expect(openCloudDocument(api, session, saved.file, () => 'alice')).rejects.toThrow();
  expect(session.tabs).toHaveLength(1);
});

it('saves a template snapshot without marking or redirecting the source, including edits during upload', async () => {
  const { session, api, saved } = setup(); const tab = session.newLayout('titleblock-letter');
  tab.identity = 'cloud:alice:project:source:original';
  const name = tab.name, baseline = tab.savedContent;
  tab.doc.transact('Edit', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'Template page'; });
  const saving = saveCloudLayoutTemplate(api, tab, () => 'alice', 'project', 'Office', 'template-key');
  tab.doc.undoStack.transact('Later edit', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'Later page'; });
  expect(await saving).toBe(saved);
  const input = api.save.mock.calls[0]![0];
  expect(input).toMatchObject({ name: 'Office.pfl', kind: 'layout', isTemplate: true, clientKey: 'template-key' });
  expect(input.fileId).toBeUndefined(); expect(input.parentRevisionId).toBeUndefined();
  const snapshot = await openLayoutFile(input.bytes);
  expect(snapshot.state.pages.get(tab.doc.state.pageOrder[0]!)!.name).toBe('Template page');
  expect(snapshot.state.sharedEntities.size).toBeGreaterThan(0);
  expect(tab.name).toBe(name); expect(tab.savedContent).toBe(baseline);
  expect(tab.identity).toBe('cloud:alice:project:source:original'); expect(session.isDirty(tab)).toBe(true);
  tab.doc.undoStack.undo(); expect(tab.doc.state.pages.get(tab.doc.state.pageOrder[0]!)!.name).toBe('Template page');
});

it('reuses a cloud template as independent clean drawings whose autosaves never target the template', async () => {
  const { session, api, saved } = setup(); const source = session.newLayout('titleblock-letter');
  source.doc.transact('Second page', draft => {
    const page = draft.pages.get(draft.pageOrder[0]!)!;
    draft.pages.set(999, { ...page, id: 999, name: 'Second page' }); draft.pageOrder.push(999); draft.meta.nextId = 1000;
  });
  saved.file.is_template = true; saved.file.folder_id = 'templates-folder';
  const sourceState = source.doc.state;
  const bytes = encodeLayoutDocument(source.doc);
  api.open.mockResolvedValue({ ...saved, bytes });
  const autosave = new CloudAutosave(api, session, () => 'alice', undefined, 60_000);
  try {
    const first = await openCloudDocument(api, session, saved.file, () => 'alice');
    const second = await openCloudDocument(api, session, saved.file, () => 'alice');
    if (first.type !== 'layout' || second.type !== 'layout') throw new Error('Expected Layout');
    expect(first).not.toBe(second); expect(first.name).not.toBe(second.name);
    expect(first.doc.state.meta.guid).not.toBe(source.doc.state.meta.guid);
    expect(second.doc.state.meta.guid).not.toBe(first.doc.state.meta.guid);
    expect(first.doc.state.pageOrder).toHaveLength(2);
    expect(first.doc.state.sharedEntities).toEqual(source.doc.state.sharedEntities);
    expect(first.doc.state.settings).toEqual(source.doc.state.settings);
    expect(first.doc.undoStack.canUndo).toBe(false); expect(session.isDirty(first)).toBe(false);
    expect(first.identity).toBeUndefined(); expect(second.identity).toBeUndefined();
    expect(first.cloudDraft).toMatchObject({ projectId: 'project', folderId: 'templates-folder' });
    expect(first.cloudDraft!.key).not.toBe(second.cloudDraft!.key);
    await autosave.saveNow(first);
    expect(api.save.mock.calls[0]![0]).toMatchObject({ projectId: 'project', folderId: 'templates-folder', kind: 'layout' });
    expect(api.save.mock.calls[0]![0].fileId).toBeUndefined(); expect(api.save.mock.calls[0]![0].isTemplate).toBeUndefined();
    expect(source.doc.state).toBe(sourceState);
  } finally { autosave.dispose(); }
});

it('refuses late template opens and saves after switching accounts', async () => {
  const { session, api, saved } = setup(); const source = session.newLayout(); saved.file.is_template = true;
  let owner = 'alice';
  api.open.mockImplementation(async () => { owner = 'bob'; return { ...saved, bytes: encodeLayoutDocument(source.doc) }; });
  await expect(openCloudDocument(api, session, saved.file, () => owner)).rejects.toThrow('account session changed');
  expect(session.tabs).toHaveLength(2);
  owner = 'alice'; api.save.mockImplementation(async () => { owner = 'bob'; return saved; });
  await expect(saveCloudLayoutTemplate(api, source, () => owner, 'project', 'Office', 'key')).rejects.toThrow('account session changed');
  expect(source.identity).toBeUndefined();
});

it.each(['model', 'layout'] as const)('tracks a slow Garage %s open from download through workspace preparation', async kind => {
  const { session, api, saved } = setup();
  saved.file.kind = kind; saved.file.name = kind === 'model' ? 'Garage.pf' : 'Garage.pfl';
  const source = session.active;
  if (source.type !== 'model') throw new Error('Expected initial model');
  const bytes = kind === 'model'
    ? await encodeModelSnapshot(source.app.document.doc.state, [])
    : encodeLayoutDocument(session.newLayout().doc);
  let complete!: (value: CloudSavedFile & { bytes: Uint8Array }) => void;
  api.open.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const stages: (string | undefined)[] = [];
  const unsubscribe = session.loading.subscribe(() => { stages.push(session.loading.getSnapshot()?.stage); });
  const opening = openCloudDocument(api, session, saved.file, () => 'alice');
  expect(session.loading.getSnapshot()).toEqual({ name: saved.file.name, stage: 'Downloading file…' });
  await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
  complete({ ...saved, bytes });
  const tab = await opening;
  expect(tab.type).toBe(kind);
  expect(stages).toContain('Reading document…'); expect(stages).toContain('Preparing workspace…');
  expect(session.loading.getSnapshot()).toBeNull();
  unsubscribe();
});

it('clears loading feedback after a failed cloud download', async () => {
  const { session, api, saved } = setup();
  api.open.mockRejectedValue(new Error('offline'));
  await expect(openCloudDocument(api, session, saved.file, () => 'alice')).rejects.toThrow('offline');
  expect(session.loading.getSnapshot()).toBeNull();
});
