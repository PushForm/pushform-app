// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { zipSync } from 'fflate';
import { buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import { ExtensionPlatform, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore, type InstalledExtension, type SettingsStore } from '@pushform/extensions';
import { ExtensionManager } from './ExtensionManager';
import { browserRunsExtensions } from './browserExtensionPlatform';
import { indexedDbExtensionStore } from './indexedDbExtensionStore';

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

function setup() {
  const settings = new Map<string, SettingsStore>();
  const settingsFor = (r: InstalledExtension) => settings.get(r.id) ?? (settings.set(r.id, memorySettingsStore()), settings.get(r.id)!);
  const platform = new ExtensionPlatform({
    store: memoryExtensionStore(), developerMode: memoryDeveloperMode(false),
    startRuntime: async () => { throw new Error('no runtime in this test'); }, settingsStore: settingsFor,
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
