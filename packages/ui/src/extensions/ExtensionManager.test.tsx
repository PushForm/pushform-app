// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { zipSync } from 'fflate';
import { buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import {
  ExtensionPlatform, memoryActivityStore, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore, type ActivityEntry, type ExtensionActivityStore,
  type InstalledExtension, type SettingsStore,
} from '@pushform/extensions';
import { ExtensionManager } from './ExtensionManager';
import { browserRunsExtensions } from './browserExtensionPlatform';
import { indexedDbActivityStore, indexedDbExtensionStore } from './indexedDbExtensionStore';

afterEach(cleanup);
const encode = (s: string) => new TextEncoder().encode(s);
const manifest = {
  id: 'com.example.prices', name: 'Lumber Prices', publisher: 'Example Co', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', sourceUrl: 'https://github.com/example/prices', permissions: ['model.read', 'settings', 'network'],
  destinations: [{ url: 'https://api.example.com/v1', purpose: 'Look up lumber prices', sendsModelData: false }],
  contributions: [{ target: 'model.panel', id: 'com.example.prices.panel', name: 'Prices' }],
} satisfies Omit<ExtensionManifestInput, 'files'>;

async function zipBytes(overrides: Partial<Omit<ExtensionManifestInput, 'files'>> = {}): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest({ ...manifest, ...overrides }, files));
  return zipSync(Object.fromEntries(files));
}
const zip = async (overrides: Partial<Omit<ExtensionManifestInput, 'files'>> = {}): Promise<File> =>
  new File([(await zipBytes(overrides)) as Uint8Array<ArrayBuffer>], 'prices.zip', { type: 'application/zip' });

function setup(activity: ExtensionActivityStore = memoryActivityStore()) {
  const settings = new Map<string, SettingsStore>();
  const settingsFor = (r: InstalledExtension) => settings.get(r.id) ?? (settings.set(r.id, memorySettingsStore()), settings.get(r.id)!);
  const platform = new ExtensionPlatform({
    store: memoryExtensionStore(), developerMode: memoryDeveloperMode(false),
    startRuntime: async () => { throw new Error('no runtime in this test'); }, settingsStore: settingsFor, activity,
  });
  render(<ExtensionManager platform={platform} developerModeAllowed developerModeOn={false} onClose={() => {}} />);
  return { platform, settingsFor };
}

async function loadFile(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('ExtensionManager', () => {
  it('turns developer mode on only after its warning, then side-loads through the install dialog', async () => {
    const { platform } = setup();
    expect(screen.getByText('No extensions are installed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load extension from file…' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow unsigned extensions on this device' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/not been reviewed by PushForm/);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on developer mode' }));
    await screen.findByRole('button', { name: 'Load extension from file…' });

    await loadFile(await zip());
    const dialog = await screen.findByRole('dialog', { name: 'Install Lumber Prices?' });
    const text = dialog.textContent ?? '';
    for (const expected of ['Example Co', 'version 1.0.0', 'Unsigned (developer)', 'PushForm has not reviewed this extension',
      'Can read the model', 'Can keep its own settings', 'Can connect to the internet addresses listed below',
      'api.example.com/v1: Look up lumber prices', 'Modeling', 'MIT', 'com.example.prices'])
      expect(text, expected).toContain(expected);
    expect(within(dialog).getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('https://github.com/example/prices');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));

    const row = await screen.findByText('Lumber Prices');
    expect(row.closest('li')!.textContent).toMatch(/Unsigned \(developer\)/);
    expect(platform.state('com.example.prices')?.record.grants).toEqual(['model.read', 'settings', 'network']);
  });

  it('marks what a reload newly asks for', async () => {
    const { platform } = setup();
    await platform.setDeveloperMode(true);
    await platform.install(await platform.sideload(await zipBytes()), manifest.permissions);
    cleanup();
    render(<ExtensionManager platform={platform} developerModeAllowed developerModeOn onClose={() => {}} />);
    await loadFile(await zip({ version: '1.1.0', permissions: [...manifest.permissions, 'file.export'] }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Lumber Prices?' });
    expect(dialog.textContent).toContain('(installed: 1.0.0)');
    const marked = within(dialog).getAllByText('New').map((n) => n.parentElement!.textContent);
    expect(marked).toEqual(['Can save files where you choose New']);
  });

  it('turns an extension off, shows unmeasurable use as unavailable, and uninstalls deleting settings when asked', async () => {
    const { platform, settingsFor } = setup();
    await platform.setDeveloperMode(true);
    const record = await platform.install(await platform.sideload(await zipBytes()), manifest.permissions);
    await settingsFor(record).save(record.id, 1, { a: 1 }, null);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Lumber Prices turned on' }));
    await waitFor(() => expect(platform.state(record.id)?.record.enabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getAllByText('unavailable')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall…' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete its settings' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }));
    await screen.findByText('No extensions are installed.');
    expect(await settingsFor(record).load(record.id)).toBeNull();
  });
});

describe('the activity record in the manager', () => {
  it('lists what happened in plain language with network use per address, and clears it on request', async () => {
    const activity = memoryActivityStore();
    const { platform } = setup(activity);
    await platform.setDeveloperMode(true);
    const record = await platform.install(await platform.sideload(await zipBytes()), manifest.permissions);
    await activity.addEgress(record.id, 'https://api.example.com', { requests: 3, bytesSent: 1536, bytesReceived: 4 * 1024 * 1024 }, new Date().toISOString());
    await activity.put({ key: 'e1', extensionId: record.id, at: new Date(Date.now() + 1000).toISOString(), seq: 99,
      event: { type: 'egress', origin: 'https://api.example.com', requests: 3, bytesSent: 1536, bytesReceived: 4 * 1024 * 1024 } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Lumber Prices turned on' }));
    await waitFor(() => expect(platform.state(record.id)?.record.enabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    const list = await screen.findByRole('list', { name: 'Activity' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('span')!.textContent)).toEqual([
      'Sent 1.5 KB to api.example.com and received 4.0 MB (3 requests)',
      'Turned off',
      'Allowed to read the model; keep its own settings; connect to its internet addresses',
      'Installed version 1.0.0 (unsigned)',
    ]));
    expect(within(list).getAllByRole('listitem')[0]!.querySelector('time')!.getAttribute('dateTime')).toMatch(/^\d{4}-/);
    const network = screen.getByRole('table', { name: 'Network use of Lumber Prices' });
    expect(within(network).getByRole('row', { name: /api\.example\.com/ }).textContent).toBe('api.example.com0 bytes1.5 KB4.0 MB');

    fireEvent.click(screen.getByRole('button', { name: 'Clear activity…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear activity' }));
    await screen.findByText('Nothing recorded yet.');
    expect(within(network).getByRole('row', { name: /api\.example\.com/ }).textContent).toBe('api.example.com0 bytes0 bytes0 bytes');
  });

  it('keeps the activity of an uninstalled extension until it is cleared', async () => {
    const { platform } = setup();
    await platform.setDeveloperMode(true);
    await platform.install(await platform.sideload(await zipBytes({ destinations: [], permissions: ['settings'] })), ['settings']);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('No internet access')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }));
    const section = await screen.findByRole('region', { name: 'Uninstalled extensions' });
    fireEvent.click(within(section).getByRole('button', { name: 'Activity' }));
    expect(await within(section).findByText('Uninstalled version 1.0.0, keeping its settings')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Clear activity…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear activity' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Uninstalled extensions' })).toBeNull());
  });
});

describe('indexedDbActivityStore', () => {
  const entry = (extensionId: string, i: number): ActivityEntry =>
    ({ key: `${extensionId}:${i}`, extensionId, at: new Date(i * 1000).toISOString(), seq: i, event: { type: 'activated' } });

  it('keeps the newest entries per extension and overall, totals per address, and clears one extension', async () => {
    const store = indexedDbActivityStore('carol', indexedDB, { perExtension: 3, total: 5 });
    for (let i = 0; i < 5; i++) await store.put(entry('a', i));
    for (let i = 10; i < 13; i++) await store.put(entry('b', i));
    expect((await store.list('a')).map((e) => e.key)).toEqual(['a:3', 'a:4']);
    expect((await store.list('b')).map((e) => e.key)).toEqual(['b:10', 'b:11', 'b:12']);
    await store.addEgress('a', 'https://x.example', { requests: 1, bytesSent: 2, bytesReceived: 3 }, '2026-01-01T00:00:00.000Z');
    await store.addEgress('a', 'https://x.example', { requests: 2, bytesSent: 2, bytesReceived: 3 }, '2026-01-02T00:00:00.000Z');
    expect(await store.egress('a')).toMatchObject([{ origin: 'https://x.example', requests: 3, bytesSent: 4, bytesReceived: 6, first: '2026-01-01T00:00:00.000Z' }]);
    expect((await store.extensions()).sort()).toEqual(['a', 'b']);
    await store.clear('a');
    expect([await store.list('a'), await store.egress('a'), await store.extensions()]).toEqual([[], [], ['b']]);
    expect(await indexedDbActivityStore('dave').list('b')).toEqual([]);
  });

  it('adds the record to a database made before it existed, keeping the installed extensions', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pushform-extensions:erin', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('extensions', { keyPath: 'id' }).put({ id: 'com.example.old' }); };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    expect((await indexedDbExtensionStore('erin').list()).map((r) => r.id)).toEqual(['com.example.old']);
    await indexedDbActivityStore('erin').put(entry('com.example.old', 1));
    expect(await indexedDbActivityStore('erin').list('com.example.old')).toHaveLength(1);
  });
});

describe('indexedDbExtensionStore', () => {
  it('keeps each account separate', async () => {
    const alice = indexedDbExtensionStore('alice');
    const bob = indexedDbExtensionStore('bob');
    await alice.put({ id: 'com.example.a', version: '1.0.0', files: { 'main.js': encode('x') } } as unknown as InstalledExtension);
    expect((await alice.list()).map((r) => r.id)).toEqual(['com.example.a']);
    expect(await bob.list()).toEqual([]);
    await alice.delete('com.example.a');
    expect(await alice.list()).toEqual([]);
  });
});

describe('browserRunsExtensions', () => {
  it('excludes WebKit browsers other than Chromium ones', () => {
    expect(browserRunsExtensions('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15')).toBe(false);
    expect(browserRunsExtensions('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36')).toBe(true);
    expect(browserRunsExtensions('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36 Edg/156.0')).toBe(true);
  });
});
