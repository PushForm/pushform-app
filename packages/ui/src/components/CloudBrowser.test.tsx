// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudSession, type AuthApi, type CloudFile, type CloudFilesApi, type CloudSavedFile } from '@pushform/cloud';
import { encodeLayoutDocument, encodeModelDocument } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { CloudBrowser } from './CloudBrowser';
import { useState } from 'react';
import { LayoutTemplateChooser } from './LayoutTemplateChooser';
import { TopBar } from './TopBar';
const sessions: DocumentSession[] = [];
afterEach(() => { cleanup(); sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks(); });
function setup(save = false) {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), true, null); sessions.push(session);
  const file: CloudFile = { id: 'file', project_id: 'project', folder_id: null, name: 'Building.pf', kind: 'model',
    current_revision_id: 'revision', revision_number: 2, size_bytes: 2048, updated_at: '2026-10-22T00:00:00Z' };
  const saved: CloudSavedFile = { file, revision: { id: 'revision', document_id: 'file', blob_path: '', size_bytes: 2048, sha256: '', number: 2 } };
  const api = { listProjects: vi.fn().mockResolvedValue([{ id: 'project', name: 'Architecture' }]),
    listFiles: vi.fn<CloudFilesApi['listFiles']>().mockResolvedValue([file]),
    createProject: vi.fn<CloudFilesApi['createProject']>().mockResolvedValue({ id: 'new', name: 'New project' }),
    head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn<CloudFilesApi['recordImport']>(), listFolders: vi.fn<CloudFilesApi['listFolders']>().mockResolvedValue([]), createFolder: vi.fn<CloudFilesApi['createFolder']>(),
    open: vi.fn<CloudFilesApi['open']>().mockResolvedValue({ ...saved, bytes: encodeModelDocument(app.document.doc) }),
    save: vi.fn<CloudFilesApi['save']>().mockResolvedValue(saved) };
  const close = vi.fn();
  const view = render(<><div className="pf-app">Workspace</div><CloudBrowser api={api} session={session}
    owner={() => 'alice'} saveTab={save ? session.active : undefined} onClose={close} /></>);
  return { api, file, saved, session, close, view };
}
it('browses projects, searches files, and opens in a new tab', async () => {
  const { api, session, close } = setup(); await screen.findByRole('button', { name: /Building.pf/ });
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'Building' } });
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Building', 0));
  const file = await screen.findByRole('button', { name: /Building.pf/ }); fireEvent.click(file);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(session.tabs).toHaveLength(2);
});
it('creates a project and saves the captured active document there', async () => {
  const { api, close, session, saved } = setup(true); saved.file.project_id = 'new'; await screen.findByRole('button', { name: 'Architecture' });
  const input = screen.getByLabelText('New project'); fireEvent.change(input, { target: { value: 'New project' } });
  fireEvent.submit(input.closest('form')!); await screen.findByRole('button', { name: 'New project' });
  fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'Building' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(api.save.mock.calls[0]![0].projectId).toBe('new');
  expect(session.active.identity).toBe('cloud:alice:new:file:revision');
});
it('ignores old search responses and keeps stale rows unavailable', async () => {
  const { api, file } = setup(); await screen.findByRole('button', { name: /Building.pf/ });
  let old!: (files: CloudFile[]) => void;
  api.listFiles.mockImplementationOnce(() => new Promise(resolve => { old = resolve; })).mockResolvedValueOnce([]);
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'old' } });
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'new' } });
  await screen.findByText('No files match your search.'); await act(async () => old([file]));
  expect(screen.queryByRole('button', { name: /Building.pf/ })).toBeNull();
});
it('shows request failures with refresh and keeps the footer available', async () => {
  const { api } = setup(); await screen.findByRole('button', { name: /Building.pf/ });
  api.listFiles.mockRejectedValueOnce(new Error('Cloud unavailable'));
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'test' } });
  expect((await screen.findByRole('alert')).textContent).toContain('Cloud unavailable');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByRole('button', { name: /Building.pf/ });
});
it('shields workspace shortcuts, traps focus and closes with Escape when idle', async () => {
  const { close } = setup(); await screen.findByRole('button', { name: /Building.pf/ });
  const shortcut = vi.fn(); window.addEventListener('keydown', shortcut);
  try {
    fireEvent.keyDown(window, { key: 'l' }); expect(shortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Architecture' }));
    fireEvent.keyDown(window, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('keydown', shortcut); }
});
it('prevents duplicate saves and dismissal while a save is in flight', async () => {
  const { api, close, saved } = setup(true); await screen.findByRole('button', { name: 'Architecture' });
  let finish!: (value: CloudSavedFile) => void; api.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); fireEvent.keyDown(window, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  // The archive is encoded off the UI thread before the upload call, so the save arrives on a later tick.
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
  await act(async () => finish(saved)); expect(close).toHaveBeenCalledOnce();
});
it('pages files on the server and resets to the first page when searching', async () => {
  const { api, file } = setup(); await screen.findByRole('button', { name: /Building.pf/ });
  api.listFiles.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ ...file, id: String(i), name: `File ${i}.pf` })));
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'File' } });
  await screen.findByRole('button', { name: /File 49.pf/ });
  api.listFiles.mockResolvedValueOnce([]); fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('No more files on this page.'); expect(api.listFiles).toHaveBeenLastCalledWith('project', 'File', 50);
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'Building' } });
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Building', 0));
});

it('saves a separate template, retains the source tab, and retries with the same creation key', async () => {
  const { api, session, close, view } = setup();
  const source = session.newLayout('titleblock-a4'); source.identity = 'cloud:alice:project:source:source-rev';
  const name = source.name;
  view.rerender(<CloudBrowser api={api} session={session} owner={() => 'alice'} saveTab={source} saveAsTemplate onClose={close} />);
  await screen.findByRole('dialog', { name: 'Save as Template' });
  await screen.findByRole('button', { name: 'Architecture' });
  fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'Office' } });
  api.save.mockRejectedValueOnce(new Error('Upload interrupted'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Upload interrupted');
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0]![0]).toMatchObject({ name: 'Office.pfl', isTemplate: true });
  expect(api.save.mock.calls[1]![0].clientKey).toBe(api.save.mock.calls[0]![0].clientKey);
  expect(source.identity).toBe('cloud:alice:project:source:source-rev'); expect(source.name).toBe(name);
});

it('browses only saved templates and creates an independent drawing on selection', async () => {
  const { api, session, file, saved, view, close } = setup();
  const source = session.newLayout('titleblock-letter');
  file.kind = 'layout'; file.name = 'Office.pfl'; file.is_template = true;
  api.open.mockResolvedValue({ ...saved, bytes: encodeLayoutDocument(source.doc) });
  view.rerender(<CloudBrowser api={api} session={session} owner={() => 'alice'} templatesOnly onClose={close} />);
  fireEvent.click(await screen.findByRole('button', { name: /Office.pfl.*Layout template/ }));
  expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, undefined, true);
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(session.active).not.toBe(source); expect(session.active.identity).toBeUndefined();
  expect(session.active.cloudDraft?.projectId).toBe('project');
});

it('keeps browsing and cloud save in the menu without a cloud-files header button and directs Save to an associated cloud file', async () => {
  const { session, api, view } = setup();
  const cloud = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'alice@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  try {
    view.rerender(<TopBar session={session} cloud={cloud} cloudFiles={api} />);
    expect(screen.queryByRole('button', { name: 'Browse cloud files' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    expect(screen.getByRole('menuitem', { name: 'Browse Cloud…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Cloud…' }));
    await screen.findByRole('button', { name: 'Architecture' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(session.active.identity).toBe('cloud:alice:project:file:revision');
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(api.save.mock.calls[1]![0].fileId).toBe('file');
    expect(api.save.mock.calls[1]![0].parentRevisionId).toBe('revision');
  } finally { view.unmount(); cloud.dispose(); }
});


it('browses saved templates inside the fourth chooser tab and keeps creation in that dialog', async () => {
  const { api, session, file, saved, view, close } = setup();
  const source = session.newLayout('titleblock-letter');
  file.kind = 'layout'; file.name = 'Office.pfl'; file.is_template = true;
  const opened = { ...saved, bytes: encodeLayoutDocument(source.doc) };
  let finish!: (value: typeof opened) => void;
  api.open.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  function Chooser() {
    const [busy, setBusy] = useState(false);
    return <LayoutTemplateChooser onCreate={vi.fn()} onCancel={close} busy={busy} savedTemplates={
      <CloudBrowser api={api} session={session} owner={() => 'alice'} templatesOnly embedded onBusyChange={setBusy} onClose={close} />
    } />;
  }
  view.rerender(<Chooser />);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Paper', 'Storyboard', 'Titleblock', 'My Templates']);
  expect(screen.queryByRole('button', { name: /My templates/i })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Titleblock' }));
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Titleblock' }), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'My Templates', selected: true }));
  expect(screen.getByRole('tabpanel', { name: 'My Templates' })).toBeTruthy();
  await screen.findByRole('button', { name: /Office.pfl.*Layout template/ });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Choose a Template' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'Office' } });
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Office', 0, undefined, true));
  fireEvent.click(await screen.findByRole('button', { name: /Office.pfl.*Layout template/ }));
  const create = screen.getByRole('button', { name: 'Create Layout' });
  create.focus(); fireEvent.keyDown(create, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close template chooser' }));
  fireEvent.click(create);
  await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
  expect(screen.getByRole('tab', { name: 'Paper' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(opened));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(session.active).not.toBe(source); expect(session.active.identity).toBeUndefined();
  expect(session.active.cloudDraft?.projectId).toBe('project');
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Titleblock' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('tab', { name: 'Titleblock' }));
  expect(screen.getByRole('radio', { name: 'Titleblock: A4 Landscape' }).getAttribute('aria-checked')).toBe('true');
});
