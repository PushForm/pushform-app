// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CloudFile, CloudFilesApi } from '@pushform/cloud';
import { CloudHome } from './CloudHome';
afterEach(() => cleanup());
const file: CloudFile = { id: 'file', project_id: 'project', folder_id: null, name: 'Building.pf', kind: 'model', current_revision_id: 'rev',
  revision_number: 2, size_bytes: 500, updated_at: '2026-10-22T12:00:00Z' };
function setup() {
  const api = { listProjects: vi.fn<CloudFilesApi['listProjects']>().mockResolvedValue([{ id: 'project', name: 'Architecture' }]),
    listFiles: vi.fn<CloudFilesApi['listFiles']>().mockResolvedValue([file]), createProject: vi.fn<CloudFilesApi['createProject']>().mockResolvedValue({ id: 'new', name: 'New project' }),
    open: vi.fn<CloudFilesApi['open']>(), save: vi.fn<CloudFilesApi['save']>(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn<CloudFilesApi['recordImport']>(),
    listFolders: vi.fn<CloudFilesApi['listFolders']>().mockResolvedValue([]), createFolder: vi.fn<CloudFilesApi['createFolder']>() };
  const onOpen = vi.fn().mockResolvedValue(undefined), onCreate = vi.fn().mockResolvedValue(undefined);
  const view = render(<CloudHome api={api} cloud={undefined} recents={[file]} openTabs={[]} onResume={() => {}} onOpen={onOpen} onCreate={onCreate} ownerId="alice" />);
  return { api, onOpen, onCreate, view };
}
it('lists the owned library across projects and opens a document with one click', async () => {
  const { api, onOpen } = setup();
  expect(screen.getByRole('heading', { name: 'Owned by me' })).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Building.pf' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(file));
  expect(api.listFiles).toHaveBeenCalledWith('', '', 0);
});

it('identifies saved templates in list and grid views', async () => {
  const { api, onOpen } = setup();
  await screen.findByRole('button', { name: 'Open Building.pf' });
  const template = { ...file, name: 'Office.pfl', kind: 'layout' as const, is_template: true };
  api.listFiles.mockResolvedValue([template]);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  let tile = await screen.findByRole('button', { name: 'Open Office.pfl' });
  expect(tile.textContent).toContain('Layout template');
  expect(tile.querySelector('.pf-home-file-art.template')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
  tile = screen.getByRole('button', { name: 'Open Office.pfl' });
  expect(tile.textContent).toContain('Layout template');
  fireEvent.click(tile); await waitFor(() => expect(onOpen).toHaveBeenCalledWith(template));
});
it('filters by project and filename and ignores responses from previous requests', async () => {
  const { api } = setup(); await screen.findByRole('button', { name: 'Architecture' });
  let old!: (files: CloudFile[]) => void;
  api.listFiles.mockImplementationOnce(() => new Promise(resolve => { old = resolve; })).mockResolvedValueOnce([{ ...file, name: 'Current.pf' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Architecture' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Current' } });
  await screen.findByRole('button', { name: 'Open Current.pf' });
  old([{ ...file, name: 'Stale.pf' }]);
  await waitFor(() => expect(screen.queryByRole('button', { name: /Stale/ })).toBeNull());
  expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Current', 0, null);
});
it('creates a named document with an explicit project and prevents duplicate submits', async () => {
  const { onCreate } = setup(); await screen.findByRole('button', { name: 'Architecture' });
  fireEvent.click(screen.getByRole('button', { name: 'Architecture' }));
  fireEvent.click(screen.getByRole('button', { name: /Create/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New drawing' }));
  fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Plan' } });
  expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('project');
  let finish!: () => void; onCreate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const form = screen.getByRole('form', { name: 'Create document' }); fireEvent.submit(form); fireEvent.submit(form);
  expect(onCreate).toHaveBeenCalledOnce(); expect(onCreate).toHaveBeenCalledWith('layout', 'Plan.pfl', 'project', null);
  finish(); await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
});
it('shows recent metadata in its own view and preserves usable controls after a failed open', async () => {
  const { onOpen } = setup(); onOpen.mockRejectedValueOnce(new Error('Download failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Recently opened' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Building.pf' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Download failed');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open Building.pf' }).hasAttribute('disabled')).toBe(false));
});
it('keeps a clear unavailable screen without product actions when storage is missing', () => {
  render(<CloudHome api={undefined} cloud={undefined} recents={[]} openTabs={[]} onResume={() => {}} onOpen={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Import files' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('unavailable');
  expect(screen.getByRole('button', { name: 'Create a model' }).hasAttribute('disabled')).toBe(true);
});
it('browses folders inside a project with breadcrumbs, creates folders, and creates documents in the current folder', async () => {
  const { api, onCreate } = setup();
  const plans = { id: 'plans', project_id: 'project', parent_id: null, name: 'Plans' }, site = { id: 'site', project_id: 'project', parent_id: 'plans', name: 'Site' };
  api.listFolders.mockResolvedValue([site, plans]);
  api.createFolder.mockResolvedValue({ id: 'details', project_id: 'project', parent_id: 'site', name: 'Details' });
  fireEvent.click(await screen.findByRole('button', { name: 'Architecture' }));
  await screen.findByRole('button', { name: 'Open folder Plans' });
  expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, null);
  expect(screen.queryByRole('button', { name: 'Open folder Site' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open folder Plans' }));
  await screen.findByRole('button', { name: 'Open folder Site' });
  expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, 'plans');
  fireEvent.click(screen.getByRole('button', { name: 'Open folder Site' }));
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, 'site'));
  const path = screen.getByRole('navigation', { name: 'Folder path' });
  expect([...path.querySelectorAll('button[aria-current]')].map(b => b.textContent)).toEqual(['Site']);
  expect(path.textContent).toContain('Architecture'); expect(path.textContent).toContain('Plans');
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Details' } });
  fireEvent.submit(screen.getByRole('form', { name: 'New folder' }));
  await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith('project', 'site', 'Details'));
  await screen.findByRole('button', { name: 'Open folder Details' });
  fireEvent.change(screen.getByLabelText('Search cloud files'), { target: { value: 'wall' } });
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', 'wall', 0, 'site'));
  expect(screen.queryByRole('button', { name: 'Open folder Details' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Search cloud files'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create ⌄' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New model' }));
  await waitFor(() => expect((screen.getByLabelText('Folder') as HTMLSelectElement).value).toBe('site'));
  fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'Wall' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create document' }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith('model', 'Wall.pf', 'project', 'site'));
  fireEvent.click(within(path).getByRole('button', { name: 'Architecture' }));
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, null));
});
it('opens the import dialog from the welcome card and the Create menu, pre-filled with the browsed project and folder', async () => {
  const { api } = setup();
  api.listFolders.mockResolvedValue([{ id: 'plans', project_id: 'project', parent_id: null, name: 'Plans' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Import files' }));
  const dialog = await screen.findByRole('dialog', { name: 'Import files' });
  // No Documents project exists yet, so the dialog creates it as the default destination.
  await waitFor(() => expect((within(dialog).getByLabelText('Project') as HTMLSelectElement).value).toBe('new'));
  expect(api.createProject).toHaveBeenCalledWith('Documents');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Architecture' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open folder Plans' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create ⌄' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import files…' }));
  const second = await screen.findByRole('dialog', { name: 'Import files' });
  expect((within(second).getByLabelText('Project') as HTMLSelectElement).value).toBe('project');
  await waitFor(() => expect((within(second).getByLabelText('Folder') as HTMLSelectElement).value).toBe('plans'));
});

/** Home with the rename, move and Trash calls. */
function setupTrash() {
  const base = setup(); base.view.unmount();
  const api = { ...base.api,
    rename: vi.fn<NonNullable<CloudFilesApi['rename']>>().mockResolvedValue(undefined),
    moveFile: vi.fn<NonNullable<CloudFilesApi['moveFile']>>().mockResolvedValue(undefined),
    moveFolder: vi.fn<NonNullable<CloudFilesApi['moveFolder']>>().mockResolvedValue(undefined),
    trash: vi.fn<NonNullable<CloudFilesApi['trash']>>().mockResolvedValue(undefined),
    restore: vi.fn<NonNullable<CloudFilesApi['restore']>>().mockResolvedValue(undefined),
    deleteForever: vi.fn<NonNullable<CloudFilesApi['deleteForever']>>().mockResolvedValue(undefined),
    listTrash: vi.fn<NonNullable<CloudFilesApi['listTrash']>>().mockResolvedValue([]),
    trashedFiles: vi.fn<NonNullable<CloudFilesApi['trashedFiles']>>().mockResolvedValue(new Set()),
  };
  api.listProjects.mockResolvedValue([{ id: 'project', name: 'Architecture' }, { id: 'other', name: 'Other' }]);
  const onForgetRecents = vi.fn(), onRenamed = vi.fn(), onMoved = vi.fn();
  render(<CloudHome api={api} cloud={undefined} recents={[file, { ...file, id: 'gone', name: 'Gone.pf' }]} openTabs={[]} onResume={() => {}} onOpen={base.onOpen} onCreate={base.onCreate} ownerId="alice"
    onForgetRecents={onForgetRecents} onRenamed={onRenamed} onMoved={onMoved} />);
  return { api, onForgetRecents, onRenamed, onMoved };
}
it('renames and moves a file from its row menu, telling open editors, and renames or trashes the browsed project', async () => {
  const { api, onRenamed, onMoved } = setupTrash();
  api.listFolders.mockResolvedValue([{ id: 'plans', project_id: 'other', parent_id: null, name: 'Plans' }]);
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Building' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  const rename = screen.getByRole('form', { name: 'Rename' });
  expect((within(rename).getByLabelText('New name') as HTMLInputElement).value).toBe('Building');
  fireEvent.change(within(rename).getByLabelText('New name'), { target: { value: 'Tower' } });
  fireEvent.submit(rename);
  await waitFor(() => expect(api.rename).toHaveBeenCalledWith('document', 'file', 'Tower.pf'));
  expect(onRenamed).toHaveBeenCalledWith('file', 'Tower.pf');
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Rename' })).toBeNull());
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Building' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
  const move = screen.getByRole('form', { name: 'Move' });
  fireEvent.change(within(move).getByLabelText('Destination project'), { target: { value: 'other' } });
  await waitFor(() => expect(within(move).getByRole('option', { name: 'Plans' })).toBeTruthy());
  fireEvent.change(within(move).getByLabelText('Destination folder'), { target: { value: 'plans' } });
  fireEvent.submit(move);
  await waitFor(() => expect(api.moveFile).toHaveBeenCalledWith('file', 'other', 'plans'));
  expect(onMoved).toHaveBeenCalledWith('file', 'other', 'plans');
  // The browsed project can be renamed and trashed from the title.
  fireEvent.click(screen.getByRole('button', { name: 'Architecture' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Rename project' }));
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Homes' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Rename' }));
  await waitFor(() => expect(api.rename).toHaveBeenCalledWith('project', 'project', 'Homes'));
  await screen.findByRole('heading', { name: 'Homes' });
  fireEvent.click(screen.getByRole('button', { name: 'Move project to Trash' }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledWith('project', 'project'));
  await screen.findByRole('heading', { name: 'Owned by me' });
  expect(screen.queryByRole('button', { name: 'Homes' })).toBeNull();
});
it('trashes a file, lists the Trash with Restore and a confirmed permanent delete, and drops trashed files from Recently opened', async () => {
  const { api, onForgetRecents } = setupTrash();
  await waitFor(() => expect(api.trashedFiles).toHaveBeenCalledWith(['file', 'gone']));
  api.trashedFiles.mockResolvedValue(new Set(['gone']));
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for Building' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledWith('document', 'file'));
  expect(onForgetRecents).toHaveBeenCalledWith(['file']);
  await waitFor(() => expect(onForgetRecents).toHaveBeenCalledWith(['gone']));
  api.listTrash.mockResolvedValue([
    { kind: 'document', id: 'file', name: 'Building.pf', project_id: 'project', project_name: 'Architecture', folder_id: null, trashed_at: '2026-10-29T10:00:00Z', purge_after: '2026-11-28T10:00:00Z', document_kind: 'model' },
    { kind: 'project', id: 'old', name: 'Old project', project_id: 'old', project_name: 'Old project', folder_id: null, trashed_at: '2026-10-28T10:00:00Z', purge_after: '2026-11-27T10:00:00Z' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
  await screen.findByRole('heading', { name: 'Trash' });
  const rows = await screen.findAllByRole('row');
  expect(rows.map(row => row.textContent)).toEqual([expect.stringContaining('Name'), expect.stringContaining('Building3D modelArchitecture'), expect.stringContaining('Old projectProject—')]);
  fireEvent.click(screen.getByRole('button', { name: 'Restore Building' }));
  await waitFor(() => expect(api.restore).toHaveBeenCalledWith('document', 'file'));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Old project permanently' }));
  expect(api.deleteForever).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting Old project' }));
  await waitFor(() => expect(api.deleteForever).toHaveBeenCalledWith('project', 'old'));
  api.listTrash.mockResolvedValue([]);
  await screen.findByText('The Trash is empty');
});
