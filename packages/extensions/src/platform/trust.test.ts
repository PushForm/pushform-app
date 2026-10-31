// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { ExtensionError, buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from '../runtime/guest';
import { messagePortTransport } from '../runtime/port';
import { localSettingsStore, type SettingsStore } from '../runtime/settings';
import { memoryDeveloperMode } from './developerMode';
import { ExtensionPlatform, type ExtensionPlatformOptions } from './platform';
import { memoryExtensionStore, type ExtensionStore, type InstalledExtension } from './store';

/**
 * Trust rules of side-loading and of extensions sharing one device: the PushForm namespace and official ids, packages
 * claiming to be official, where side-loaded installs and settings are kept, and what one extension can see of
 * another. Basic side-loading is covered in platform.test.ts.
 */

const encode = (s: string) => new TextEncoder().encode(s);
type Base = Omit<ExtensionManifestInput, 'files'>;
const base = (id: string, overrides: Partial<Base> = {}): Base => ({
  id, name: id.split('.').pop()!, publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings'],
  contributions: [{ target: 'model.command', id: `${id}.run`, name: 'Run' }], ...overrides,
});

async function archive(manifest: Base, extra: Record<string, Uint8Array> = {}, main = 'export function activate() {}'): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([['main.js', encode(main)], ...Object.entries(extra)]);
  files.set('manifest.json', await buildManifest(manifest, files));
  return zipSync(Object.fromEntries(files));
}

/** A Storage in memory, standing for the browser's localStorage. */
function memoryStorage(): Storage & { keys(): string[] } {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, String(v)); }, removeItem: (k) => { items.delete(k); },
    clear: () => items.clear(), key: (i) => [...items.keys()][i] ?? null, get length() { return items.size; }, keys: () => [...items.keys()],
  };
}

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A platform whose runtimes run `modules[id]` in this process, keeping settings in one shared device storage. */
function setup(modules: Record<string, unknown> = {}, overrides: Partial<ExtensionPlatformOptions> = {}, store: ExtensionStore = memoryExtensionStore()) {
  const storage = memoryStorage();
  const settingsRequests: InstalledExtension[] = [];
  const started: { id: string; files: Record<string, Uint8Array> }[] = [];
  const platform = new ExtensionPlatform({
    store, developerMode: memoryDeveloperMode(true),
    startRuntime: async (record) => {
      started.push({ id: record.id, files: record.files });
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => modules[record.id] ?? { activate() {} });
      return { port: messagePortTransport(channel.port1), terminate: () => {} };
    },
    settingsStore: (record): SettingsStore => { settingsRequests.push(record); return localSettingsStore(storage, 'owner'); },
    ...overrides,
  });
  return { platform, store, storage, settingsRequests, started };
}

const refusal = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('the PushForm namespace and official ids', () => {
  it('refuses io.pushform itself and every id under it, but not ids that merely start alike', async () => {
    const { platform } = setup();
    for (const id of ['io.pushform', 'io.pushform.cut-list', 'io.pushform.tools.stairs'])
      expect((await refusal(platform.sideload(await archive(base(id))))).message).toMatch(/belongs to PushForm/);
    await expect(platform.sideload(await archive(base('io.pushforms.stairs')))).resolves.toMatchObject({ integrity: 'unsigned' });
    await expect(platform.sideload(await archive(base('io.pushform-fan.stairs')))).resolves.toMatchObject({ integrity: 'unsigned' });
  });

  it('refuses ids in another case, which the validator does not accept as ids at all', async () => {
    const { platform } = setup();
    await expect(platform.sideload(await archive(base('IO.PUSHFORM.cut-list')))).rejects.toMatchObject({ details: { problem: 'manifest.schema' } });
  });

  it('refuses the ids the host reserves for built-in and official extensions', async () => {
    const { platform } = setup({}, { reservedIds: (id) => id === 'com.example.official' });
    expect((await refusal(platform.sideload(await archive(base('com.example.official'))))).message).toMatch(/belongs to PushForm or an official extension/);
  });

  it('cannot replace an installed official extension, and leaves it untouched', async () => {
    const official: InstalledExtension = {
      id: 'com.example.official', version: '2.0.0', manifest: {} as never, files: {}, contentHash: 'a'.repeat(64), integrity: 'official',
      source: 'registry', enabled: true, grants: ['settings'], installedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = memoryExtensionStore([official]);
    const { platform } = setup({}, {}, store);
    await platform.load();
    expect((await refusal(platform.sideload(await archive(base('com.example.official'))))).message).toMatch(/installed as an official extension/);
    expect(await store.list()).toEqual([official]);
  });
});

describe('packages claiming to be official', () => {
  it('refuses a package whose signature cannot be verified, instead of loading it as unsigned', async () => {
    const { platform, store } = setup();
    for (const signature of ['', '{}', '{"keyId":"pushform-2026","signature":"AAAA"}', 'not json'])
      await expect(platform.sideload(await archive(base('com.example.forged'), { 'signature.json': encode(signature) })))
        .rejects.toMatchObject({ details: { problem: 'signature.invalid' } });
    expect(await store.list()).toEqual([]);
  });

  it('cannot claim official status with a manifest field', async () => {
    const { platform } = setup();
    const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
    const manifest = JSON.parse(new TextDecoder().decode(await buildManifest(base('com.example.claims'), files))) as Record<string, unknown>;
    for (const claim of [{ integrity: 'official' }, { official: true }, { signature: 'AAAA' }]) {
      const forged = new Map(files).set('manifest.json', encode(JSON.stringify({ ...manifest, ...claim })));
      await expect(platform.sideload(zipSync(Object.fromEntries(forged)))).rejects.toMatchObject({ details: { problem: 'manifest.schema' } });
    }
    // Naming PushForm as the publisher is only text: the package is still unsigned.
    await expect(platform.sideload(await archive(base('com.example.claims', { publisher: 'PushForm' })))).resolves.toMatchObject({ integrity: 'unsigned' });
  });
});

describe('side-loaded installs stay on the device', () => {
  it('records side-loaded installs as unsigned developer installs in the device store only', async () => {
    const { platform, store } = setup();
    await platform.install(await platform.sideload(await archive(base('com.example.local'))), ['settings']);
    expect(await store.list()).toMatchObject([{ id: 'com.example.local', integrity: 'unsigned', source: 'developer' }]);
  });

  it('keeps their settings in the device settings store, asked for by the side-loaded record', async () => {
    const { platform, storage, settingsRequests } = setup({
      'com.example.local': { activate(c: ExtensionContext) { c.commands.register('com.example.local.run', () => (c.settings as { set(i: unknown): Promise<unknown> }).set({ value: { units: 'mm' } })); } },
    });
    await platform.install(await platform.sideload(await archive(base('com.example.local'))), ['settings']);
    await platform.invoke('com.example.local', 'com.example.local.run');
    expect(settingsRequests.map((r) => r.source)).toEqual(['developer']);
    expect(storage.keys()).toEqual(['pushform:extension-settings:owner:com.example.local']);
  });
});

describe('one extension and another', () => {
  const settingsOf = (c: ExtensionContext) => c.settings as { get(): Promise<unknown>; set(i: unknown): Promise<unknown> };
  const modules = {
    'com.example.alpha': { activate(c: ExtensionContext) { c.commands.register('com.example.alpha.run', async (p) => { await settingsOf(c).set({ value: p }); (c.log as { write(i: unknown): Promise<unknown> }).write('alpha line'); return settingsOf(c).get(); }); } },
    'com.example.beta': { activate(c: ExtensionContext) { c.commands.register('com.example.beta.run', () => settingsOf(c).get()); } },
  };

  async function both() {
    const s = setup(modules);
    for (const id of ['com.example.alpha', 'com.example.beta']) await s.platform.install(await s.platform.sideload(await archive(base(id))), ['settings']);
    return s;
  }

  it('cannot read the other\'s settings, though both are kept in the same device storage', async () => {
    const { platform, storage } = await both();
    expect(await platform.invoke('com.example.alpha', 'com.example.alpha.run', { secret: 'alpha only' })).toEqual({ secret: 'alpha only' });
    expect(await platform.invoke('com.example.beta', 'com.example.beta.run')).toEqual({});
    expect(storage.keys()).toEqual(['pushform:extension-settings:owner:com.example.alpha']);
  });

  it('cannot run the other\'s contributions through its own id', async () => {
    const { platform } = await both();
    await expect(platform.invoke('com.example.beta', 'com.example.alpha.run')).rejects.toMatchObject({ code: 'validation.failed' });
  });

  it('keeps its log lines and its grants to itself, and disabling one leaves the other as it was', async () => {
    const { platform } = await both();
    await platform.invoke('com.example.alpha', 'com.example.alpha.run', {});
    await platform.invoke('com.example.beta', 'com.example.beta.run');
    expect(platform.state('com.example.beta')!.logs).toEqual([]);
    expect(platform.state('com.example.alpha')!.logs.map((l) => l.entry)).toEqual(['alpha line']);
    await platform.setEnabled('com.example.alpha', false);
    expect(platform.state('com.example.beta')).toMatchObject({ run: 'running', record: { enabled: true, grants: ['settings'] } });
  });

  it('removes only its own settings when uninstalled', async () => {
    const { platform, storage } = await both();
    await platform.invoke('com.example.alpha', 'com.example.alpha.run', { a: 1 });
    await platform.uninstall('com.example.beta', { deleteSettings: true });
    expect(storage.keys()).toEqual(['pushform:extension-settings:owner:com.example.alpha']);
  });
});

describe('stored releases', () => {
  // Known gap, kept as an expected failure until it is fixed: files are verified when a package is side-loaded, but
  // the platform starts a stored release from its stored files without checking them against its content hash again.
  it.fails('refuses to start a stored release whose files no longer match its content hash', async () => {
    const store = memoryExtensionStore();
    const first = setup({}, {}, store);
    await first.platform.install(await first.platform.sideload(await archive(base('com.example.stored'))), ['settings']);
    const [record] = await store.list();
    await store.put({ ...record!, files: { ...record!.files, 'main.js': encode('export function activate() { /* changed */ }') } });
    const second = setup({}, {}, store);
    await second.platform.load();
    await expect(second.platform.invoke('com.example.stored', 'com.example.stored.run')).rejects.toBeInstanceOf(ExtensionError);
    expect(second.started).toEqual([]);
  });
});

describe('revocation', () => {
  // There is no revocation list yet: official releases cannot be installed, and side-loaded ones are governed by
  // developer mode instead. These describe what has to pass before an official install path ships.
  it.todo('deactivates a revoked official release on the next revocation check, ends its runtime and tells the user why');
  it.todo('keeps the last good revocation list for offline use and treats an unsigned or wrongly signed list as unavailable');
  it.todo('never deletes document content when it revokes a release');
});
