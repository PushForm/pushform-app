// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionError, extensionManifestSchema, type ExtensionManifest } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession } from './host';
import { messagePortTransport } from './port';
import { ExtensionSettingsHost, SETTINGS_MAX_BYTES, cloudSettingsStore, localSettingsStore, memorySettingsStore, type SettingsStore } from './settings';

const manifest = (settings: Record<string, unknown> = {}): ExtensionManifest => extensionManifestSchema.parse({
  id: 'io.pushform.cut-list', name: 'Cut List', publisher: 'PushForm', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'GPL-3.0-or-later', files: {}, permissions: ['settings'],
  contributions: [{ target: 'model.command', id: 'io.pushform.cut-list.open', name: 'Open' }],
  settings: { version: 3, schema: {}, defaults: { kerf: 0.003, units: 'metric', mirror: true }, ...settings },
});

const call = (host: ExtensionSettingsHost, method: 'settings.get' | 'settings.set', input?: unknown) =>
  Promise.resolve(host.services()[method]!(input, {} as never));
const failure = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('ExtensionSettingsHost', () => {
  it('starts from the manifest defaults and stores what the extension sets', async () => {
    const store = memorySettingsStore();
    const host = new ExtensionSettingsHost(manifest(), store);
    expect(await call(host, 'settings.get')).toEqual({ kerf: 0.003, units: 'metric', mirror: true });
    expect(await call(host, 'settings.set', { value: { kerf: 0.004 } })).toEqual({ kerf: 0.004, units: 'metric', mirror: true });
    expect(await store.load('io.pushform.cut-list')).toEqual({ version: 3, value: { kerf: 0.004 }, revision: 1 });
    const again = new ExtensionSettingsHost(manifest(), store);
    expect(await call(again, 'settings.get')).toMatchObject({ kerf: 0.004 });
  });

  it('accepts only a plain JSON object within the size bound', async () => {
    const host = new ExtensionSettingsHost(manifest(), memorySettingsStore());
    expect((await failure(call(host, 'settings.set', { value: [1, 2] }))).code).toBe('validation.failed');
    expect((await failure(call(host, 'settings.set', { value: new Map() }))).code).toBe('validation.failed');
    expect((await failure(call(host, 'settings.set', { value: { big: 'x'.repeat(SETTINGS_MAX_BYTES) } }))).code).toBe('limit.exceeded');
    expect(await call(host, 'settings.set', { value: { at: new Date(0) } })).toMatchObject({ at: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses a write based on settings another device changed, and reads the new ones', async () => {
    const store = memorySettingsStore();
    const here = new ExtensionSettingsHost(manifest(), store);
    const there = new ExtensionSettingsHost(manifest(), store);
    await call(here, 'settings.get');
    await call(there, 'settings.set', { value: { kerf: 0.005 } });
    expect((await failure(call(here, 'settings.set', { value: { kerf: 0.001 } }))).code).toBe('revision.stale');
    expect(await call(here, 'settings.get')).toMatchObject({ kerf: 0.005 });
    expect(await call(here, 'settings.set', { value: { kerf: 0.001 } })).toMatchObject({ kerf: 0.001 });
  });

  it('migrates stored settings with the declared steps, carrying over versions without one', async () => {
    const store = memorySettingsStore();
    await store.save('io.pushform.cut-list', 1, { saw_kerf: 0.002, legacy: true, units: 'imperial' }, null);
    const host = new ExtensionSettingsHost(manifest({
      migrations: [{ from: 1, rename: { saw_kerf: 'kerf' }, remove: ['legacy'], set: { trim: 0.01 } }],
    }), store);
    await host.prepare();
    expect(await store.load('io.pushform.cut-list')).toEqual({ version: 3, value: { kerf: 0.002, units: 'imperial', trim: 0.01 }, revision: 2 });
    expect(host.current()).toEqual({ kerf: 0.002, units: 'imperial', mirror: true, trim: 0.01 });
  });

  it('reads settings saved by a newer release but never overwrites them', async () => {
    const store = memorySettingsStore();
    await store.save('io.pushform.cut-list', 5, { kerf: 0.006, future: 'x' }, null);
    const host = new ExtensionSettingsHost(manifest(), store);
    await host.prepare();
    expect(await call(host, 'settings.get')).toEqual({ kerf: 0.006, units: 'metric', mirror: true, future: 'x' });
    expect((await failure(call(host, 'settings.set', { value: {} }))).code).toBe('extension.unsupported');
    expect(await store.load('io.pushform.cut-list')).toMatchObject({ version: 5, revision: 1 });
  });

  it('keeps device-local settings per account', async () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v), removeItem: (k: string) => void backing.delete(k) };
    const alice = localSettingsStore(storage, 'alice');
    const bob = localSettingsStore(storage, 'bob');
    await alice.save('com.example.dev', 1, { a: 1 }, null);
    expect(await bob.load('com.example.dev')).toBeNull();
    expect(await alice.load('com.example.dev')).toEqual({ version: 1, value: { a: 1 }, revision: 1 });
    await expect(alice.save('com.example.dev', 1, { a: 2 }, null)).rejects.toThrow('changed since');
    expect(await alice.remove('com.example.dev')).toBe(true);
    storage.setItem('pushform:extension-settings:alice:com.example.bad', '{not json');
    expect(await alice.load('com.example.bad')).toBeNull();
  });

  it('maps the cloud client conflict to a settings conflict', async () => {
    const conflict = Object.assign(new Error('changed'), { name: 'CloudSettingsConflictError' });
    const store = cloudSettingsStore({ load: async () => null, save: async () => { throw conflict; }, remove: async () => false });
    await expect(store.save('a.b', 1, {}, null)).rejects.toThrow('changed since');
  });
});

describe('settings before activation', () => {
  const channels: MessageChannel[] = [];
  afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

  function start(m: ExtensionManifest, store: SettingsStore) {
    const channel = new MessageChannel();
    channels.push(channel);
    const settings = new ExtensionSettingsHost(m, store);
    const session = new ExtensionSession({ manifest: m, grants: ['settings'], port: messagePortTransport(channel.port1), services: settings.services(),
      beforeActivate: () => settings.prepare() });
    let seen: unknown;
    void startGuest(messagePortTransport(channel.port2), async () => ({
      async activate(context: ExtensionContext) { seen = await (context.settings as { get(): Promise<unknown> }).get(); },
    }));
    return { session, seen: () => seen };
  }

  it('migrates before the extension sees its settings', async () => {
    const store = memorySettingsStore();
    await store.save('io.pushform.cut-list', 2, { saw: 0.002 }, null);
    const { session, seen } = start(manifest({ migrations: [{ from: 2, rename: { saw: 'kerf' } }] }), store);
    await session.activate();
    expect(seen()).toEqual({ kerf: 0.002, units: 'metric', mirror: true });
  });

  it('does not activate when settings cannot be prepared', async () => {
    const broken: SettingsStore = { load: async () => { throw new Error('offline'); }, save: async () => 1, remove: async () => false };
    const { session, seen } = start(manifest(), broken);
    expect((await failure(session.activate())).code).toBe('extension.failed');
    expect(session.state).toBe('failed');
    expect(seen()).toBeUndefined();
  });
});

describe('manifest settings migrations', () => {
  it('must step from versions below the settings version, once each', () => {
    expect(() => manifest({ migrations: [{ from: 3 }] })).toThrow(/below the settings version/);
    expect(() => manifest({ migrations: [{ from: 1 }, { from: 1 }] })).toThrow(/declared twice/);
  });
});
