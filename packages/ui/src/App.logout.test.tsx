// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { App } from './App';
import { createApp } from './bootstrap';

vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['model', 'layout'])('signs out from %s command search, prevents duplicates, and allows retry after failure', async mode => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  let finish!: (result: { error: null | { message: string } }) => void;
  const signOut = vi.fn(() => new Promise<{ error: null | { message: string } }>(resolve => { finish = resolve; }));
  const cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'artist@example.com' },
      expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut,
  } as unknown as AuthApi);
  await cloud.start();
  const app = createApp({ demo: false, expose: false });
  try {
    render(<App initialScreen="workspace" app={app} cloud={cloud} />);
    if (mode === 'layout') {
      fireEvent.click(screen.getByRole('button', { name: 'New document' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
      fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
    }
    const before = app.document.doc.state;
    const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search tools and commands' });
    const run = (query: string): void => {
      fireEvent.focus(search());
      fireEvent.change(search(), { target: { value: query } });
      fireEvent.keyDown(search(), { key: 'Enter' });
    };
    run('logout');
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    run('Sign out');
    expect(signOut).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ error: { message: 'offline' } }); });
    expect(screen.getByRole('dialog', { name: 'Your account' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Could not sign out');
    expect(app.document.doc.state).toBe(before);
    expect(app.commands.ctx.tx.canUndo()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close account dialog' }));
    run('Sign out');
    expect(signOut).toHaveBeenCalledTimes(2);
    await act(async () => { finish({ error: null }); });
    expect(screen.getByRole('heading', { name: 'Sign in to PushForm' })).toBeTruthy();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(app.document.doc.state).toBe(before);
    expect(app.commands.ctx.tx.canUndo()).toBe(false);
  } finally { cleanup(); app.dispose(); cloud.dispose(); }
});
