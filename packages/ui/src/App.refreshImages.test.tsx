// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { CloudSession, type AuthApi, type CloudFilesApi } from '@pushform/cloud';
import { App } from './App';
vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));

const clouds: CloudSession[] = [];
afterEach(() => { cleanup(); clouds.splice(0).forEach(cloud => cloud.dispose()); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reads the refresh images from IndexedDB before showing the workspace', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const cloud = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'artist@example.com' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  } as unknown as AuthApi);
  clouds.push(cloud); await cloud.start();
  const api = { listProjects: vi.fn().mockResolvedValue([]), listFiles: vi.fn().mockResolvedValue([]), listFolders: vi.fn().mockResolvedValue([]) } as unknown as CloudFilesApi;
  render(<App cloud={cloud} cloudFiles={api} />);
  // The workspace waits for IndexedDB, then appears.
  expect(screen.queryByRole('main', { name: 'Cloud document library' })).toBeNull();
  expect(await screen.findByRole('main', { name: 'Cloud document library' })).toBeTruthy();
  // This browser tab's namespace for its images is kept with the account's session data.
  expect(sessionStorage.getItem('pushform:account:alice:pushform:document-session:v2:tab')).toMatch(/\S/);
});
