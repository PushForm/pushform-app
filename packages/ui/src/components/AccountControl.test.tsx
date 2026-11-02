// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSession, type AuthApi, type CloudProfileStore } from '@pushform/cloud';
import { AccountControl, MailingPreference } from './AccountControl';
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
