// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSession, type AuthApi, type CloudProfileStore, type CloudBillingState, type CloudBillingStore } from '@pushform/cloud';
import { AccountControl, MailingPreference } from './AccountControl';
import { BillingContext } from '../billingContext';
let cloud: CloudSession | undefined;
afterEach(() => { cleanup(); cloud?.dispose(); });
it('does not offer a header sign-in bypass when signed out or unconfigured', () => {
  render(<AccountControl />); expect(screen.queryByRole('button')).toBeNull();
});
it('opens account details, traps focus, shields shortcuts, and restores focus on Escape', async () => {
  cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1', email: 'artist@example.com' } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  render(<div className="pf-app"><AccountControl cloud={cloud} /></div>);
  const account = screen.getByRole('button', { name: 'Account: artist@example.com' }); account.focus(); fireEvent.click(account);
  expect(screen.getByRole('dialog', { name: 'Your account' })).toBeTruthy();
  const shortcut = vi.fn(); window.addEventListener('keydown', shortcut);
  try {
    fireEvent.keyDown(window, { key: 'l' }); expect(shortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByText('Danger Zone'));
    expect(screen.getByRole('button', { name: 'Sign out' }).closest('details')).toBeNull();
    fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close account dialog' }));
    fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(account); expect(document.querySelector<HTMLElement>('.pf-app')?.inert).toBe(false);
  } finally { window.removeEventListener('keydown', shortcut); }
});

it('loads the mailing choice and preserves it on a failed save, then allows retry', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false);
  const profiles = { readMailingPreference: async () => true, saveMailingPreference: save } as unknown as CloudProfileStore;
  render(<MailingPreference profiles={profiles} />);
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
  await vi.waitFor(() => expect(checkbox.checked).toBe(true));
  fireEvent.click(checkbox);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);
  await vi.waitFor(() => expect(checkbox.checked).toBe(false));
  expect(save).toHaveBeenLastCalledWith(false);
});

async function signedIn(): Promise<CloudSession> {
  cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'artist@example.com' } } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start(); return cloud;
}
function billingStore(status: string | null, patch: Partial<CloudBillingState> = {}) {
  let state: CloudBillingState = { status: 'ready', ownerId: 'user-1', summary: { available: false, offers: [], canManageBilling: Boolean(status),
    subscription: status ? { status, interval: 'year', currentPeriodEnd: null, cancelAtPeriodEnd: false } : null }, busy: null, returned: null, error: null, ...patch };
  const listeners = new Set<() => void>();
  const store: CloudBillingStore & { set(patch: Partial<CloudBillingState>): void } = {
    getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: vi.fn(async () => {}), checkout: vi.fn(async () => null), portal: vi.fn(async () => null), clearReturn: vi.fn(),
    set(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
  };
  return store;
}
it.each(['active', 'trialing'])('shows the Pro pill only beside an owner-confirmed %s account heading', async status => {
  const billing = billingStore(status);
  render(<BillingContext.Provider value={billing}><AccountControl cloud={await signedIn()} /></BillingContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  const heading = screen.getByRole('heading', { name: 'Your account', level: 2 });
  expect(screen.getByRole('dialog', { name: 'Your account' })).toBeTruthy();
  const badge = screen.getByText('Pro');
  expect(badge.className).toBe('pf-account-pro');
  expect(heading.contains(badge)).toBe(false);
  expect(heading.parentElement?.contains(badge)).toBe(true);
  act(() => billing.set({ ownerId: 'another-account' }));
  expect(screen.queryByText('Pro')).toBeNull();
});
it.each([
  { subscription: 'past_due' }, { subscription: 'canceled' }, { subscription: 'unpaid' }, { subscription: 'incomplete' },
  { subscription: null, returned: 'success' as const }, { subscription: 'active', status: 'loading' as const }, { subscription: 'active', status: 'error' as const },
])('does not infer a Pro pill from unconfirmed or inactive billing %j', async ({ subscription, ...patch }) => {
  const billing = billingStore(subscription, patch);
  render(<BillingContext.Provider value={billing}><AccountControl cloud={await signedIn()} /></BillingContext.Provider>);
  if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  expect(screen.queryByText('Pro')).toBeNull();
});
it('keeps Danger Zone collapsed after Extensions and includes only revealed actions in keyboard focus', async () => {
  render(<AccountControl cloud={await signedIn()} onExtensions={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
  const close = screen.getByRole('button', { name: 'Close account dialog' });
  const extensions = screen.getByRole('button', { name: 'Manage extensions…' });
  const summary = screen.getByText('Danger Zone');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(extensions.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const signOut = screen.getByRole('button', { name: 'Sign out' });
  expect(signOut.closest('details')).toBeNull();
  expect(signOut.parentElement?.textContent).toContain('Signed in as artist@example.com');
  close.focus();
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(summary);
  fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(close);
  extensions.focus();
  fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  summary.focus();
  fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(close);
  fireEvent.click(summary); summary.focus();
  expect(details.open).toBe(false);
  fireEvent.keyDown(window, { key: 'Tab' }); expect(document.activeElement).toBe(close);
});
