// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { createApp, type AppInstance } from './bootstrap';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { buildManifest, validatePackage } from '@pushform/extension-protocol';
import { memoryExtensionStore, type ExtensionContext, type ExtensionDocuments, type ExtensionPlatform, type ExtensionStore, type UiOpenRequest } from '@pushform/extensions';

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
  shared.store = memoryExtensionStore();
  shared.module = { activate() {} };
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

// The activity bar, side panel, toolbar button and tabs of an installed extension, with the platform's runtime
// replaced by one that runs the extension's module in this process.
const shared = vi.hoisted(() => ({ store: null as unknown, platform: null as unknown, module: null as unknown, channels: [] as MessageChannel[] }));
vi.mock('./extensions/browserExtensionPlatform', async () => {
  const ext = await import('@pushform/extensions');
  return {
    browserRunsExtensions: () => true,
    createBrowserExtensionPlatform: (options: Record<string, unknown>) => {
      const platform = new ext.ExtensionPlatform({
        store: shared.store as ExtensionStore, developerMode: ext.memoryDeveloperMode(true), settingsStore: () => ext.memorySettingsStore(),
        startRuntime: async () => {
          const channel = new MessageChannel();
          shared.channels.push(channel);
          void ext.startGuest(ext.messagePortTransport(channel.port2), async () => shared.module);
          return { port: ext.messagePortTransport(channel.port1), terminate: () => {} };
        },
        ...(options.documents ? { documents: options.documents as ExtensionDocuments } : {}),
        ...(options.openUi ? { openUi: options.openUi as (r: UiOpenRequest) => void } : {}),
        ...(options.onSelectionShown ? { onSelectionShown: options.onSelectionShown as (e: string, d: string) => void } : {}),
      });
      shared.platform = platform;
      return platform;
    },
  };
});

const parts = {
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling' as const],
  defaultLocale: 'en', license: 'MIT', permissions: [], icon: 'saw-blade',
  contributions: [
    { target: 'model.sidebar' as const, id: 'com.example.parts.side', name: 'Parts' },
    { target: 'model.panel' as const, id: 'com.example.parts.panel', name: 'Parts list' },
    { target: 'model.toolbar' as const, id: 'com.example.parts.cut', name: 'Cut parts', category: 'modify' as const, icon: 'saw-blade' },
  ],
};
type Ui = { mount(i: unknown): Promise<unknown>; open(i: unknown): Promise<unknown>; onEvent(h: (e: Record<string, unknown>) => void): void };
const partsModule = {
  activate(context: ExtensionContext) {
    const ui = context.ui as unknown as Ui;
    context.commands.register('com.example.parts.side', () => ui.mount({ target: 'com.example.parts.side', seq: 1, tree: { type: 'button', id: 'open', label: 'Open the full list' } }));
    context.commands.register('com.example.parts.panel', () => ui.mount({ target: 'com.example.parts.panel', seq: 1, tree: { type: 'text', id: 't', text: 'All 12 parts' } }));
    context.commands.register('com.example.parts.cut', () => (context.log as { write(entry: unknown): Promise<unknown> }).write('cut'));
    ui.onEvent((e) => { if (e.component === 'open') void ui.open({ target: 'com.example.parts.panel' }); });
  },
};

async function installParts(): Promise<ExtensionStore> {
  const store = memoryExtensionStore();
  const files = new Map<string, Uint8Array>([['main.js', new TextEncoder().encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest(parts, files));
  const validated = await validatePackage(files);
  await store.put({ id: parts.id, version: parts.version, manifest: validated.manifest, files: Object.fromEntries(files), contentHash: validated.contentHash,
    integrity: 'unsigned', source: 'developer', enabled: true, grants: [], installedAt: new Date().toISOString() });
  return store;
}

afterEach(() => { for (const c of shared.channels.splice(0)) { c.port1.close(); c.port2.close(); } });

it('lists an installed extension in the activity bar and toolbar, opens its side panel and its tab, and keeps the tab while editing', async () => {
  shared.store = await installParts();
  shared.module = partsModule;
  localStorage.clear();
  render(<App initialScreen="workspace" app={app} cloud={cloud} extensionRuntime={runtime} staff={{ isStaff: async () => true }} />);
  const rail = screen.getByRole('navigation', { name: 'Left menu bar' });
  // The activity bar: the built-in items, then one icon per extension, named after it.
  const icon = await within(rail).findByRole('button', { name: 'Parts' });
  expect(within(rail).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Files', 'AI Chat', 'Object browser', 'Parts']);
  expect(icon.getAttribute('aria-pressed')).toBe('false');
  // The toolbar button joins the end of its group, after a separator, named after the contribution and the extension.
  const modify = screen.getByRole('group', { name: 'Modify' });
  const cut = within(modify).getByRole('button', { name: 'Cut parts — Parts extension' });
  expect(cut.previousElementSibling?.className).toContain('pf-toolbar-sep');
  expect(modify.lastElementChild?.previousElementSibling?.lastElementChild).toBe(cut);
  // The icon toggles the side panel, which shows the sidebar contribution in PushForm's frame.
  fireEvent.click(icon);
  const panel = await screen.findByRole('region', { name: 'Parts side panel' });
  expect(icon.getAttribute('aria-pressed')).toBe('true');
  const open = await within(panel).findByRole('button', { name: 'Open the full list' });
  // Pressing the toolbar button runs the contribution as a user action.
  fireEvent.click(cut);
  const platform = shared.platform as ExtensionPlatform;
  await waitFor(() => expect(platform.state(parts.id)!.logs.map((l) => l.entry)).toContain('cut'));
  // The sidebar's button opens the extension's tab, bound to the open document, filling the editor area.
  fireEvent.click(open);
  const tabs = screen.getByRole('navigation', { name: 'Open documents' });
  const tab = await within(tabs).findByRole('button', { name: 'Parts list, from Parts' });
  expect(tab.getAttribute('aria-current')).toBe('page');
  const documentTab = within(tabs).getByRole('button', { name: /^3D model:/ });
  expect(documentTab.getAttribute('aria-current')).toBeNull();
  const view = await screen.findByRole('region', { name: 'Parts list, from Parts' });
  expect(await within(view).findByText('All 12 parts')).toBeTruthy();
  expect(view.closest('.pf-main')?.className).toContain('has-xtab');
  // The side panel stays open beside it.
  expect(screen.getByRole('region', { name: 'Parts side panel' })).toBeTruthy();
  // Switching back to the document keeps the tab open, behind it.
  fireEvent.click(documentTab);
  expect(screen.queryByRole('region', { name: 'Parts list, from Parts' })).toBeNull();
  expect(within(tabs).getByRole('button', { name: 'Parts list, from Parts' }).getAttribute('aria-current')).toBeNull();
  expect(documentTab.getAttribute('aria-current')).toBe('page');
  // Command search brings it back (the same tab, not a second one).
  fireEvent.focus(search());
  fireEvent.change(search(), { target: { value: 'Parts list' } });
  fireEvent.keyDown(search(), { key: 'Enter' });
  expect(await screen.findByRole('region', { name: 'Parts list, from Parts' })).toBeTruthy();
  expect(within(tabs).getAllByRole('button', { name: 'Parts list, from Parts' })).toHaveLength(1);
  // Closing the tab unmounts the panel.
  fireEvent.click(within(tabs).getByRole('button', { name: 'Close Parts list' }));
  expect(within(tabs).queryByRole('button', { name: 'Parts list, from Parts' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Parts list, from Parts' })).toBeNull();
  await waitFor(() => expect(platform.ui(parts.id)!.get('com.example.parts.panel')).toBeUndefined());
  expect(platform.ui(parts.id)!.get('com.example.parts.side')).toBeTruthy();
  // The icon closes the side panel again.
  fireEvent.click(icon);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Parts side panel' })).toBeNull());
  expect(platform.ui(parts.id)!.get('com.example.parts.side')).toBeUndefined();
});
