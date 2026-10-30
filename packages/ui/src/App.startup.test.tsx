// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type * as ImagesModule from './refreshImages';
import type * as RefreshModule from './nativeRefresh';
import type * as LoadingModule from './documentLoading';
import type * as BootstrapModule from './bootstrap';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { App } from './App';
import { createApp } from './bootstrap';
import { paintLoading } from './documentLoading';
import { loadNativeRefresh } from './nativeRefresh';

vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));
vi.mock('./bootstrap', async original => {
  const actual = await original<typeof BootstrapModule>();
  return { ...actual, createApp: vi.fn(actual.createApp) };
});
vi.mock('./documentLoading', async original => ({ ...await original<typeof LoadingModule>(), paintLoading: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./nativeRefresh', async original => ({ ...await original<typeof RefreshModule>(), loadNativeRefresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./refreshImages', async original => ({ ...await original<typeof ImagesModule>(), loadRefreshImages: vi.fn().mockResolvedValue(undefined) }));

let cloud: CloudSession;
afterEach(() => { cleanup(); cloud?.dispose(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.documentElement.classList.remove('pf-document-loading'); });

it('paints recovery feedback before storage reads or engine creation and clears it when ready', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('indexedDB', new IDBFactory());
  cloud = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'artist@example.com' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  let paint!: () => void, finishRead!: () => void;
  vi.mocked(paintLoading).mockImplementationOnce(() => new Promise<void>(resolve => { paint = resolve; }));
  vi.mocked(loadNativeRefresh).mockImplementationOnce(async (_storage, _factory, report) => {
    await report?.({ name: 'Garage.pf', completed: 0, total: 2 });
    await new Promise<void>(resolve => { finishRead = resolve; });
    await report?.({ name: 'Garage V3.pf', completed: 1, total: 2 });
    return undefined;
  });
  render(<App cloud={cloud} />);
  expect(screen.getByRole('main', { name: 'Loading workspace' })).toBeTruthy();
  expect(document.documentElement.classList.contains('pf-document-loading')).toBe(true);
  expect(createApp).not.toHaveBeenCalled(); expect(loadNativeRefresh).not.toHaveBeenCalled();
  await act(async () => { paint(); });
  expect(screen.getByRole('status').textContent).toContain('Reading Garage.pf');
  expect(screen.getByRole('progressbar').getAttribute('max')).toBe('2');
  expect(createApp).not.toHaveBeenCalled();
  await act(async () => { finishRead(); });
  await waitFor(() => expect(screen.queryByRole('main', { name: 'Loading workspace' })).toBeNull());
  expect(createApp).toHaveBeenCalledOnce();
  expect(document.documentElement.classList.contains('pf-document-loading')).toBe(false);
});
