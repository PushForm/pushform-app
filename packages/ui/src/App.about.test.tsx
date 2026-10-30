// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopUpdates, setDesktopUpdates } from './desktopUpdates';
import { App } from './App';
import { createApp, type AppInstance } from './bootstrap';
import { CloudSession, type AuthApi } from '@pushform/cloud';

vi.mock('./components/ViewportView', () => ({
  ViewportView: () => <div aria-label="3D viewport" />,
}));

const build = { version: '1.2.3', commit: 'abc1234', date: '2026-10-22T14:03:00Z' };
let app: AppInstance;
let signedInCloud: CloudSession;
beforeEach(async () => {
  signedInCloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'artist@example.com' },
      expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await signedInCloud.start();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  app = createApp({ demo: false, expose: false });
});
afterEach(() => {
  cleanup();
  setDesktopUpdates(undefined);
  signedInCloud.dispose();
  app.dispose();
  vi.restoreAllMocks();
});

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'Main menu' });
const openMenu = (): HTMLElement[] => {
  fireEvent.click(menuButton());
  return screen.getAllByRole('menuitem');
};
const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search tools and commands' });
const runFromSearch = (query: string): void => {
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: query } });
  fireEvent.keyDown(search(), { key: 'Enter' });
};
const createLayout = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
};

it('omits About PushForm from the Main menu and shows build identity through command search', () => {
  render(<App initialScreen="workspace" app={app} cloud={signedInCloud} buildInfo={build} />);
  const before = app.document.doc.state;
  openMenu();
  expect(screen.queryByRole('menuitem', { name: 'About PushForm' })).toBeNull();
  fireEvent.click(menuButton());
  runFromSearch('about');
  expect(screen.queryByRole('menu')).toBeNull();
  const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
  expect(dialog.textContent).toContain('1.2.3');
  expect(dialog.textContent).toContain('abc1234');
  expect(dialog.textContent).toContain('2026-10-22 14:03 UTC');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(app.document.doc.state).toBe(before);
  expect(app.commands.ctx.tx.canUndo()).toBe(false);
});

it('offers help.about in command search for Modeling and Layout documents', () => {
  render(<App initialScreen="workspace" app={app} cloud={signedInCloud} buildInfo={build} />);
  expect(app.commands.has('help.about')).toBe(true);
  runFromSearch('about');
  expect(screen.getByRole('dialog', { name: 'About PushForm' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close about dialog' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  createLayout();
  openMenu();
  expect(screen.queryByRole('menuitem', { name: 'About PushForm' })).toBeNull();
  fireEvent.click(menuButton());
  expect(screen.queryByRole('menu')).toBeNull();
  runFromSearch('about');
  const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
  expect(dialog.textContent).toContain('abc1234');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('shows unknown values when the host passes no build identity', () => {
  render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
  act(() => { app.commands.tryExecute('help.about'); });
  const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
  expect(dialog.textContent).toContain('Versionunknown');
  expect(dialog.textContent).toContain('Buildunknown');
  expect(dialog.textContent).toContain('Builtunknown');
});

for (const mode of ['model', 'layout']) it(`opens About and checks for updates from the ${mode} command search`, async () => {
  const backend = { enabled: vi.fn().mockResolvedValue(true), fetch: vi.fn().mockResolvedValue(null), install: vi.fn() };
  setDesktopUpdates(new DesktopUpdates(backend, null));
  await act(async () => { render(<App initialScreen="workspace" app={app} cloud={signedInCloud} buildInfo={build} />); });
  if (mode === 'layout') createLayout();
  backend.fetch.mockClear();
  await act(async () => { runFromSearch('Check for updates'); });
  expect(screen.getByRole('dialog', { name: 'About PushForm' })).toBeTruthy();
  expect(backend.fetch).toHaveBeenCalledExactlyOnceWith('stable');
  expect(screen.getByRole('dialog', { name: 'About PushForm' }).textContent).toContain('PushForm is up to date.');
  expect(app.commands.ctx.tx.canUndo()).toBe(false);
});

it('does not register the update command in the browser', () => {
  setDesktopUpdates(null);
  render(<App initialScreen="workspace" app={app} cloud={signedInCloud} buildInfo={build} />);
  expect(app.commands.has('help.checkUpdates')).toBe(false);
});
