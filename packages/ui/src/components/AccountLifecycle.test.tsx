// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSession, type AuthApi, type CloudAccountState, type CloudAccountStore } from '@pushform/cloud';
import { AccountContext } from '../accountContext';
import { AccountControl } from './AccountControl';
import { DeletionBanner } from './AccountLifecycle';

let cloud: CloudSession | undefined;
afterEach(() => { cleanup(); cloud?.dispose(); });

/** A store whose actions apply the given results, so the UI can be driven through each state. */
function fakeStore(initial: Partial<CloudAccountState> = {}) {
  let state: CloudAccountState = { status: 'ready', ownerId: 'user-1', deletion: null, latestExport: null, busy: null, error: null, ...initial };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<CloudAccountState>): void => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  const store: CloudAccountStore & { set: typeof set } = {
    set,
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: vi.fn(async () => {}),
    requestDeletion: vi.fn(async () => { set({ deletion: { requestedAt: '2026-10-27T10:00:00Z', deleteAfter: '2026-10-29T10:00:00Z' } }); return true; }),
    cancelDeletion: vi.fn(async () => { set({ deletion: null }); return true; }),
    requestExport: vi.fn(async () => {
      set({ latestExport: { id: 'e1', status: 'queued', requestedAt: '2026-10-27T10:00:00Z', finishedAt: null, documentCount: null, sizeBytes: null, expiresAt: null, error: null } });
      return true;
    }),
    clearError: vi.fn(() => set({ error: null })),
  };
  return store;
}
async function signedIn(): Promise<CloudSession> {
  cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'artist@example.com' } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  return cloud;
}
const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

it('marks the account for deletion only after confirming, then offers to cancel it', async () => {
  const store = fakeStore();
  render(<AccountContext.Provider value={store}><div className="pf-app"><AccountControl cloud={await signedIn()} /></div></AccountContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
  expect(screen.getByText(/In 48 hours we permanently delete your documents/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep my account' }));
  expect(store.requestDeletion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete my account' })); });
  expect(store.requestDeletion).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog').textContent).toContain(`Your account will be deleted on ${when('2026-10-29T10:00:00Z')}. You can cancel until then.`);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' })); });
  expect(store.cancelDeletion).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Delete account…' })).toBeTruthy();
});

it('requests an export and reports its progress, link expiry, or failure', async () => {
  const store = fakeStore();
  render(<AccountContext.Provider value={store}><AccountControl cloud={await signedIn()} /></AccountContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Email me my files' })); });
  expect(store.requestExport).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toBe('Preparing your export. We will email artist@example.com a download link when it is ready.');
  expect((screen.getByRole('button', { name: 'Email me my files' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => store.set({ latestExport: { ...store.getSnapshot().latestExport!, status: 'ready', expiresAt: '2026-10-28T10:00:00Z' } }));
  expect(screen.getByRole('status').textContent).toBe(`Sent to artist@example.com. The link works until ${when('2026-10-28T10:00:00Z')}.`);
  act(() => store.set({ latestExport: { ...store.getSnapshot().latestExport!, status: 'failed', error: 'You have no saved documents to export.' } }));
  expect(screen.getByRole('status').textContent).toBe('You have no saved documents to export.');
  expect((screen.getByRole('button', { name: 'Email me my files' }) as HTMLButtonElement).disabled).toBe(false);
});

it('offers neither action until the account state has loaded, or where it is unavailable', async () => {
  const store = fakeStore({ status: 'unavailable' });
  render(<AccountContext.Provider value={store}><AccountControl cloud={await signedIn()} /></AccountContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  expect(screen.queryByRole('heading', { name: 'Delete account' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Export your files' })).toBeNull();
});

it('shows the red banner with the deletion time while the account is marked, and moves the app down', async () => {
  const store = fakeStore({ deletion: { requestedAt: '2026-10-27T10:00:00Z', deleteAfter: '2026-10-29T10:00:00Z' } });
  const view = render(<DeletionBanner account={store} state={store.getSnapshot()} />);
  expect(screen.getByRole('alert').textContent).toContain(`Your account is marked for deletion on ${when('2026-10-29T10:00:00Z')}.`);
  expect(document.documentElement.classList.contains('pf-has-deletion-banner')).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' })); });
  expect(store.cancelDeletion).toHaveBeenCalledOnce();
  view.rerender(<DeletionBanner account={store} state={store.getSnapshot()} />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.documentElement.classList.contains('pf-has-deletion-banner')).toBe(false);
});
