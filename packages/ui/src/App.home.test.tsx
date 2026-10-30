// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CloudSession, type AuthApi, type CloudFile, type CloudFilesApi } from '@pushform/cloud';
import { importSketchUpLayoutInWorker, readSketchUpInWorker, type SketchUpImport } from '@pushform/io';
import type * as IoModule from '@pushform/io';
import { meshBox } from '@pushform/core';
import { createLayoutDocument } from '@pushform/layout';
import type { DocumentSession } from './session';
import { App } from './App';
vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));
vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), readSketchUpInWorker: vi.fn(), importSketchUpLayoutInWorker: vi.fn() }));
const readModel = vi.mocked(readSketchUpInWorker), readLayout = vi.mocked(importSketchUpLayoutInWorker);
function scene(): SketchUpImport {
  return { version: '{26.2.242}', root: { key: -1, guid: 'ROOT', name: 'Model', image: false, group: false, alwaysFaceCamera: false, shadowsFaceSun: false,
    solids: [{ mesh: meshBox([0, 0, 0], [1, 2, 3]), faces: [] }], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [], dimensions: [], texts: [], instances: [] },
    definitions: new Map(), materials: new Map(), images: [], tags: [], scenes: [], units: null, warnings: ['Textures are not imported.'] };
}
function picked(name: string): File {
  const file = new File([new Uint8Array([1, 2, 3, 4])], name, { lastModified: Date.UTC(2026, 9, 20) });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  return file;
}
const clouds: CloudSession[] = [];
afterEach(() => { cleanup(); clouds.splice(0).forEach(cloud => cloud.dispose()); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); readModel.mockReset(); readLayout.mockReset(); });
async function signedIn() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const cloud = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'artist@example.com' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  } as unknown as AuthApi);
  clouds.push(cloud); await cloud.start();
  const files: CloudFile[] = [];
  const api: CloudFilesApi = { listProjects: vi.fn().mockResolvedValue([{ id: 'project', name: 'Documents' }]),
    createProject: vi.fn(), listFiles: vi.fn().mockImplementation(async () => files), open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn().mockResolvedValue({ id: 'report' }), listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(),
    save: vi.fn().mockImplementation(async input => {
      const file: CloudFile = { id: `file-${files.length + 1}`, project_id: input.projectId, folder_id: null, name: input.name, kind: input.kind, current_revision_id: 'revision',
        revision_number: 1, size_bytes: input.bytes.length, updated_at: '2026-10-22T12:00:00Z' };
      files.push(file); return { file, revision: { id: 'revision', document_id: file.id, blob_path: '', size_bytes: input.bytes.length, sha256: '', number: 1 } };
    }) };
  return { cloud, api, files };
}
it('starts on Home, creates an autosaved document, and returns Home through the brand without closing it', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const cloud = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'artist@example.com' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  } as unknown as AuthApi);
  clouds.push(cloud); await cloud.start();
  const files: CloudFile[] = [];
  const api: CloudFilesApi = { listProjects: vi.fn().mockResolvedValue([{ id: 'project', name: 'Documents' }]),
    createProject: vi.fn(), listFiles: vi.fn().mockImplementation(async () => files), open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(), listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(),
    save: vi.fn().mockImplementation(async input => {
      const file: CloudFile = { id: 'file', project_id: input.projectId, folder_id: null, name: input.name, kind: input.kind, current_revision_id: 'revision',
        revision_number: 1, size_bytes: input.bytes.length, updated_at: '2026-10-22T12:00:00Z' };
      files.push(file); return { file, revision: { id: 'revision', document_id: 'file', blob_path: '', size_bytes: input.bytes.length, sha256: '', number: 1 } };
    }) };
  render(<App cloud={cloud} cloudFiles={api} />);
  expect(await screen.findByRole('main', { name: 'Cloud document library' })).toBeTruthy(); expect(screen.queryByLabelText('3D viewport')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /Create a model/ }));
  fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Home model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create document' }));
  await screen.findByLabelText('3D viewport');
  expect(screen.getByRole('status', { name: 'Cloud save status' }).textContent).toContain('Changes pending');
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce(), { timeout: 4000 });
  await waitFor(() => expect(screen.getByRole('status', { name: 'Cloud save status' }).textContent).toContain('All changes saved'));
  fireEvent.click(screen.getByRole('button', { name: 'PushForm home' }));
  expect(await screen.findByRole('main', { name: 'Cloud document library' })).toBeTruthy(); expect(screen.queryByLabelText('3D viewport')).toBeNull();
  expect(screen.getByRole('button', { name: 'Continue Home model' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Continue Home model' }));
  await screen.findByLabelText('3D viewport'); expect(api.save).toHaveBeenCalledOnce();
});
it('imports files through the dialog straight into the chosen folder without opening them, remembering the destination', async () => {
  const { cloud, api, files } = await signedIn();
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 'project', name: 'Documents' }, { id: 'arch', name: 'Architecture' }]);
  vi.mocked(api.listFolders).mockImplementation(async id => id === 'arch' ? [{ id: 'plans', project_id: 'arch', parent_id: null, name: 'Plans' }] : []);
  readModel.mockResolvedValueOnce(scene()).mockRejectedValueOnce(new Error('Not a SketchUp model: invalid file header.'));
  readLayout.mockResolvedValueOnce({ doc: createLayoutDocument(), warnings: ['Viewports are placeholders'], properties: { version: '26.2.242', created: null, modified: null, revision: 3, pageCount: 1 } });
  render(<App cloud={cloud} cloudFiles={api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Architecture' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open folder Plans' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create ⌄' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import files…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Import files' });
  await waitFor(() => expect((within(dialog).getByLabelText('Folder') as HTMLSelectElement).value).toBe('plans'));
  fireEvent.change(within(dialog).getByLabelText('Import SketchUp or LayOut files'), { target: { files: [picked('Chair.skp'), picked('Plan.layout'), picked('Broken.skp'), picked('Notes.txt')] } });
  expect(within(dialog).getByRole('alert').textContent).toContain('Skipped Notes.txt');
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Import 3 files' }));
  const results = await within(dialog).findByRole('list', { name: 'Import results' }, { timeout: 4000 });
  const rows = within(results).getAllByRole('listitem').map(item => item.textContent);
  expect(rows[0]).toContain('Chair.skp'); expect(rows[0]).toContain('Saved as Chair.pf with 1 note');
  expect(rows[1]).toContain('Saved as Plan.pfl with 1 note');
  expect(rows[2]).toContain('Could not import: Not a SketchUp model');
  expect(vi.mocked(api.save).mock.calls.map(([input]) => [input.name, input.kind, input.projectId, input.folderId])).toEqual([
    ['Chair.pf', 'model', 'arch', 'plans'], ['Plan.pfl', 'layout', 'arch', 'plans']]);
  expect(vi.mocked(api.recordImport).mock.calls.map(([report]) => report.status)).toEqual(['imported', 'imported', 'failed']);
  expect(files.map(file => file.name)).toEqual(['Chair.pf', 'Plan.pfl']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByLabelText('3D viewport')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Continue / })).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open Chair.pf' })).toBeTruthy());
  expect(JSON.parse(localStorage.getItem('pushform:import-destination:alice')!)).toEqual({ projectId: 'arch', folderId: 'plans' });
  fireEvent.click(screen.getByRole('button', { name: 'PushForm home' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import files' }));
  const again = await screen.findByRole('dialog', { name: 'Import files' });
  expect((within(again).getByLabelText('Project') as HTMLSelectElement).value).toBe('arch');
  await waitFor(() => expect((within(again).getByLabelText('Folder') as HTMLSelectElement).value).toBe('plans'));
});


const activeSession = (): DocumentSession => (window as unknown as { pushform: { session: DocumentSession } }).pushform.session;

it.each(['model', 'layout'] as const)('refreshes into the active %s document rather than Home (PF-278)', async type => {
  const { cloud, api } = await signedIn();
  const first = render(<App cloud={cloud} cloudFiles={api} />);
  fireEvent.click(await screen.findByRole('button', { name: /Create a model/ }));
  fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Refresh model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create document' }));
  await screen.findByLabelText('3D viewport');
  const session = activeSession();
  const model = session.active;
  let target = model;
  act(() => {
    const layout = session.newLayout();
    target = type === 'model' ? model : layout;
    session.newModel();
    session.activate(target.id);
  });
  expect(sessionStorage.getItem('pushform:account:alice:pushform:workspace-screen:v1')).toBe('workspace');
  // A real reload flushes snapshots through pagehide; unmount then constructs the new page's session.
  fireEvent(window, new Event('pagehide'));
  first.unmount();
  render(<App cloud={cloud} cloudFiles={api} />);
  await waitFor(() => expect(screen.queryByRole('main', { name: 'Loading workspace' })).toBeNull());
  await waitFor(() => expect(activeSession().active.type).toBe(type));
  expect(activeSession().active.name).toBe(target.name);
  expect(activeSession().tabs).toHaveLength(3);
  expect(screen.queryByRole('main', { name: 'Cloud document library' })).toBeNull();
  expect(api.open).not.toHaveBeenCalled();
});

it('refreshes on Home after explicitly returning Home, keeping its open documents available', async () => {
  const { cloud, api } = await signedIn();
  const first = render(<App cloud={cloud} cloudFiles={api} initialScreen="workspace" />);
  await screen.findByLabelText('3D viewport');
  act(() => { activeSession().newLayout(); });
  fireEvent.click(screen.getByRole('button', { name: 'PushForm home' }));
  expect(sessionStorage.getItem('pushform:account:alice:pushform:workspace-screen:v1')).toBe('home');
  first.unmount();
  render(<App cloud={cloud} cloudFiles={api} />);
  expect(await screen.findByRole('main', { name: 'Cloud document library' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /^Continue / }).length).toBeGreaterThan(0);
});

it('falls back to Home for a corrupt snapshot and ignores another account’s remembered editor', async () => {
  const { cloud, api } = await signedIn();
  sessionStorage.setItem('pushform:account:bob:pushform:workspace-screen:v1', 'workspace');
  sessionStorage.setItem('pushform:account:alice:pushform:workspace-screen:v1', 'workspace');
  sessionStorage.setItem('pushform:account:alice:pushform:document-session:v2', '{broken');
  render(<App cloud={cloud} cloudFiles={api} />);
  expect(await screen.findByRole('main', { name: 'Cloud document library' })).toBeTruthy();
  expect(screen.queryByLabelText('3D viewport')).toBeNull();
  expect(sessionStorage.getItem('pushform:account:bob:pushform:workspace-screen:v1')).toBe('workspace');
});
