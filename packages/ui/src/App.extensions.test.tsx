// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { createApp, type AppInstance } from './bootstrap';
import { CloudSession, type AuthApi } from '@pushform/cloud';

vi.mock('./components/ViewportView', () => ({
  ViewportView: () => <div aria-label="3D viewport" />,
}));

let app: AppInstance;
let cloud: CloudSession;
beforeEach(async () => {
  cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'maker@example.com' },
      expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  app = createApp({ demo: false, expose: false });
});
afterEach(() => {
  cleanup();
  cloud.dispose();
  app.dispose();
  vi.restoreAllMocks();
});

const runtime = { workerSource: '', computeSource: '' };
const search = (): HTMLElement => screen.getByRole('combobox', { name: 'Search tools and commands' });

it('offers the extension manager when the host supplies a runtime and the account may use extensions', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} extensionRuntime={runtime} staff={{ isStaff: async () => true }} />);
  await act(async () => { await Promise.resolve(); });
  expect(app.commands.has('extensions.manage')).toBe(true);
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: 'extensions' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  expect(await screen.findByRole('dialog', { name: 'Extensions' })).toBeTruthy();
});

it('does not offer the extension manager without a runtime', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} staff={{ isStaff: async () => true }} />);
  await act(async () => { await Promise.resolve(); });
  expect(app.commands.has('extensions.manage')).toBe(false);
});
