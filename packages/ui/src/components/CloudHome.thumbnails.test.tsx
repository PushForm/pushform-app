// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CloudFile, CloudFilesApi } from '@pushform/cloud';
import { ThumbnailService } from '../thumbnailService';
import { ThumbnailContext } from '../useThumbnails';
import { CloudHome } from './CloudHome';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const file = (id: string, name: string): CloudFile => ({ id, project_id: 'project', folder_id: null, name, kind: 'model', current_revision_id: `rev-${id}`,
  revision_number: 1, size_bytes: 500, updated_at: '2026-10-22T12:00:00Z' });

function setup(thumbnailUrls?: CloudFilesApi['thumbnailUrls']) {
  const files = [file('a', 'Kitchen.pf'), file('b', 'Shed.pf')];
  const api: CloudFilesApi = {
    listProjects: vi.fn().mockResolvedValue([{ id: 'project', name: 'Architecture' }]), listFiles: vi.fn().mockResolvedValue(files),
    createProject: vi.fn(), open: vi.fn(), save: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(), ...(thumbnailUrls ? { thumbnailUrls } : {}),
  };
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() });
  const service = new ThumbnailService({ ownerId: 'alice', api, render: async () => null, fetch: vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array([255, 216, 255, 217]).buffer }) });
  render(<ThumbnailContext.Provider value={service}><CloudHome api={api} cloud={undefined} recents={[]} openTabs={[]} onResume={() => {}} onOpen={vi.fn()} onCreate={vi.fn()} ownerId="alice" /></ThumbnailContext.Provider>);
  return api;
}

it('shows thumbnails in grid tiles and icons for documents without one, fetching URLs only for the grid', async () => {
  const thumbnailUrls = vi.fn<NonNullable<CloudFilesApi['thumbnailUrls']>>().mockResolvedValue(new Map([['a', 'https://example.test/a.jpg?token=1']]));
  setup(thumbnailUrls);
  await screen.findByRole('button', { name: 'Open Kitchen.pf' });
  expect(thumbnailUrls).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open Kitchen.pf' }).querySelector('img')?.getAttribute('src')).toBe('blob:preview'));
  // The app is cross-origin isolated (require-corp), so Storage's images load only through CORS.
  expect(screen.getByRole('button', { name: 'Open Kitchen.pf' }).querySelector('img')?.getAttribute('crossorigin')).toBe('anonymous');
  expect(thumbnailUrls).toHaveBeenCalledWith(['a']);
  await waitFor(() => expect(thumbnailUrls).toHaveBeenCalledWith(['b']));
  expect(screen.getByRole('button', { name: 'Open Shed.pf' }).querySelector('img')).toBeNull();
});

it('keeps icons when thumbnails are unavailable', async () => {
  setup(vi.fn().mockRejectedValue(new Error('no bucket')));
  fireEvent.click(await screen.findByRole('button', { name: 'Grid view' }));
  await screen.findByRole('button', { name: 'Open Kitchen.pf' });
  expect(screen.getByRole('button', { name: 'Open Kitchen.pf' }).querySelector('img')).toBeNull();
  cleanup();
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Grid view' }));
  expect((await screen.findByRole('button', { name: 'Open Shed.pf' })).querySelector('img')).toBeNull();
});
