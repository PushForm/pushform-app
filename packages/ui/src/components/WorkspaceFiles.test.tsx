// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CLOUD_PAGE_SIZE, type CloudFile, type CloudFilesApi, type CloudFolder } from '@pushform/cloud';
import { ThumbnailService } from '../thumbnailService';
import { ThumbnailContext } from '../useThumbnails';
import { WorkspaceFiles } from './WorkspaceFiles';

afterEach(cleanup);
const file = (id: string, folder: string | null = null): CloudFile => ({ id, name: `${id}.pfl`, kind: 'layout', project_id: 'project', folder_id: folder,
  current_revision_id: `${id}-rev`, revision_number: 1, size_bytes: 100, updated_at: '2026-10-29T00:00:00Z' });
function setup() {
  const folders: CloudFolder[] = [{ id: 'plans', project_id: 'project', parent_id: null, name: 'Plans' }, { id: 'detail', project_id: 'project', parent_id: 'plans', name: 'Details' }];
  const files = [file('Root'), file('Plan', 'plans'), file('Detail', 'detail')];
  const api: CloudFilesApi = { listProjects: vi.fn().mockResolvedValue([{ id: 'project', name: 'Architecture' }]), createProject: vi.fn().mockResolvedValue({ id: 'new', name: 'New project' }),
    listFolders: vi.fn().mockImplementation(async () => folders), createFolder: vi.fn().mockResolvedValue({ id: 'created' }),
    listFiles: vi.fn().mockImplementation(async (_project, search, _offset, folder) => files.filter(value => search ? value.name.includes(search) : value.folder_id === folder)),
    thumbnailUrls: vi.fn().mockImplementation(async (ids: string[]) => new Map(ids.map(id => [id, `https://example.test/${id}.jpg`]))),
    open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), save: vi.fn(), recordImport: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined), moveFile: vi.fn().mockResolvedValue(undefined), moveFolder: vi.fn().mockResolvedValue(undefined), trash: vi.fn().mockResolvedValue(undefined) };
  const props = { api, open: true, onOpen: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onRenamed: vi.fn(), onMoved: vi.fn(), onForgetRecents: vi.fn() };
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() });
  const service = new ThumbnailService({ ownerId: 'alice', api, render: async () => null, fetch: vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array([255, 216, 255, 217]).buffer }) });
  const view = render(<WorkspaceFiles {...props} />, { wrapper: ({ children }) => <ThumbnailContext.Provider value={service}>{children}</ThumbnailContext.Provider> });
  return { api, props, view };
}
async function project() { fireEvent.click(await screen.findByRole('button', { name: 'Open project Architecture' })); await screen.findByRole('button', { name: 'Open Root.pfl' }); }

it('starts at projects and pushes roots and nested folders, with previews and Back at each level', async () => {
  const { api, props } = setup();
  expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
  await project();
  expect(api.listFiles).toHaveBeenLastCalledWith('project', '', 0, null);
  expect(screen.queryByRole('button', { name: 'Open Plan.pfl' })).toBeNull();
  expect(await screen.findByRole('img', { name: 'Preview of Root' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open folder Plans' }));
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.click(screen.getByRole('button', { name: 'Open folder Details' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open Detail.pfl' }));
  await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(file('Detail', 'detail')));
  expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Plans' }));
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Architecture' }));
  await screen.findByRole('button', { name: 'Open Root.pfl' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Projects' }));
  expect(await screen.findByRole('button', { name: 'Open project Architecture' })).toBeTruthy();
});

it('ignores stale responses, hides old rows while loading, and recovers from list and preview failures', async () => {
  const { api } = setup();
  await project();
  let finish!: (files: CloudFile[]) => void;
  vi.mocked(api.listFiles).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('Offline'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old' } });
  expect(screen.queryByRole('button', { name: 'Open Root.pfl' })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Root' } });
  expect((await screen.findByRole('alert')).textContent).toContain('Offline');
  await act(async () => finish([file('Stale')]));
  expect(screen.queryByRole('button', { name: 'Open Stale.pfl' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const preview = await screen.findByRole('img', { name: 'Preview of Root' });
  fireEvent.error(preview);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open Root.pfl' })).toBeTruthy();
});

it('pages files, searches the project, and retains its location across hiding', async () => {
  const { api, props, view } = setup(); await project();
  vi.mocked(api.listFiles).mockResolvedValueOnce(Array.from({ length: CLOUD_PAGE_SIZE }, (_, i) => file(`Many ${i}`)));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Many' } });
  await screen.findByRole('button', { name: 'Open Many 49.pfl' });
  expect(screen.queryByRole('button', { name: 'Open folder Plans' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Many', 50, null));
  view.rerender(<WorkspaceFiles {...props} open={false} />);
  view.rerender(<WorkspaceFiles {...props} />);
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Many');
  expect(screen.getByText('Page 2')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Detail' } });
  await screen.findByRole('button', { name: 'Open Detail.pfl' });
  expect(api.listFiles).toHaveBeenLastCalledWith('project', 'Detail', 0, null);
});

it('creates folders at the current depth, renames files, moves files and trashes them', async () => {
  const { api, props } = setup(); await project();
  fireEvent.click(screen.getByRole('button', { name: 'Open folder Plans' }));
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Elevations' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith('project', 'plans', 'Elevations'));
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Plan.pfl' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => expect(props.onRenamed).toHaveBeenCalledWith('Plan', 'Renamed.pfl'));
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Plan.pfl' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
  await waitFor(() => expect((screen.getByLabelText('Folder') as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  await waitFor(() => expect(props.onMoved).toHaveBeenCalledWith('Plan', 'project', null));
  expect(api.moveFile).toHaveBeenCalledWith('Plan', 'project', null);
  await screen.findByRole('button', { name: 'Open Plan.pfl' });
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Plan.pfl' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
  await waitFor(() => expect(props.onForgetRecents).toHaveBeenCalledWith(['Plan']));
});

it('blocks duplicate opening, reports failures, and keeps file-panel keys out of workspace tools', async () => {
  const { props } = setup(); await project();
  let fail!: (reason: Error) => void;
  props.onOpen.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const shortcut = vi.fn(); window.addEventListener('keydown', shortcut);
  try {
    const row = screen.getByRole('button', { name: 'Open Root.pfl' });
    fireEvent.keyDown(row, { key: 'Delete' }); expect(shortcut).not.toHaveBeenCalled();
    fireEvent.click(row); fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Escape' }); expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onOpen).toHaveBeenCalledOnce();
    await act(async () => fail(new Error('Could not open file')));
    expect(screen.getByRole('alert').textContent).toContain('Could not open file');
    fireEvent.keyDown(row, { key: 'Escape' }); expect(props.onClose).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('keydown', shortcut); }
});

it('creates projects from the first screen and retains failed creation input for retry', async () => {
  const { api } = setup();
  await screen.findByRole('button', { name: 'Open project Architecture' });
  vi.mocked(api.createProject).mockRejectedValueOnce(new Error('No connection'));
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect((await screen.findByRole('alert')).textContent).toContain('No connection');
  expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('New project');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByRole('heading', { name: 'New project' });
  expect(api.createProject).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(api.listFiles).toHaveBeenLastCalledWith('new', '', 0, null));
  expect(screen.getByRole('button', { name: 'Back to Projects' })).toBeTruthy();
});

it('does not offer moving a folder inside itself or its descendants', async () => {
  setup(); await project();
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open folder Plans' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
  await waitFor(() => expect((screen.getByLabelText('Folder') as HTMLSelectElement).disabled).toBe(false));
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Project root']);
});

it('offers management only through the context menu, with keyboard navigation and Escape', async () => {
  const { props } = setup(); await project();
  const row = screen.getByRole('button', { name: 'Open Root.pfl' });
  expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  row.focus(); fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
  expect(screen.getByRole('menu', { name: 'Actions for Root' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move…' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(row);
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onOpen).not.toHaveBeenCalled();
});
