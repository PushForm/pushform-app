// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { ExtensionError, buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import { startGuest } from '../runtime/guest';
import { messagePortTransport } from '../runtime/port';
import { memorySettingsStore, type SettingsStore } from '../runtime/settings';
import { memoryDeveloperMode } from './developerMode';
import { ExtensionPlatform, type ExtensionPlatformOptions } from './platform';
import { memoryExtensionStore, type InstalledExtension } from './store';

const encode = (s: string) => new TextEncoder().encode(s);
const base = {
  id: 'com.example.stairs', name: 'Stairs', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings'],
  contributions: [
    { target: 'model.command', id: 'com.example.stairs.make', name: 'Make stairs' },
    { target: 'model.panel', id: 'com.example.stairs.panel', name: 'Stairs' },
  ],
} satisfies Omit<ExtensionManifestInput, 'files'>;

async function archive(overrides: Partial<Omit<ExtensionManifestInput, 'files'>> = {}, extra: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')], ...Object.entries(extra)]);
  files.set('manifest.json', await buildManifest({ ...base, ...overrides }, files));
  return zipSync(Object.fromEntries(files));
}

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A platform whose runtimes run `modules[id]` in this process. */
function setup(modules: Record<string, unknown>, overrides: Partial<ExtensionPlatformOptions> = {}) {
  const started: string[] = [];
  const terminated: string[] = [];
  const settings = new Map<string, SettingsStore>();
  const settingsFor = (record: InstalledExtension): SettingsStore => {
    if (!settings.has(record.id)) settings.set(record.id, memorySettingsStore());
    return settings.get(record.id)!;
  };
  const failures: string[] = [];
  const store = memoryExtensionStore();
  const developerMode = memoryDeveloperMode(true);
  const platform = new ExtensionPlatform({
    store, developerMode,
    startRuntime: async (record: InstalledExtension) => {
      started.push(record.id);
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => modules[record.id]);
      return { port: messagePortTransport(channel.port1), terminate: () => terminated.push(record.id) };
    },
    settingsStore: settingsFor,
    onFailure: (record, failure) => failures.push(`${record.id}:${failure.kind}`),
    ...overrides,
  });
  return { platform, store, developerMode, started, terminated, settings, settingsFor, failures };
}

const failure = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('side-loading', () => {
  it('needs developer mode, and refuses reserved ids, signed packages and anything the validator refuses', async () => {
    const { platform, developerMode } = setup({});
    developerMode.set(false);
    expect((await failure(platform.sideload(await archive()))).message).toMatch(/developer mode/);
    developerMode.set(true);
    expect((await failure(platform.sideload(await archive({ id: 'io.pushform.cut-list', contributions: [{ target: 'model.command', id: 'io.pushform.cut-list.x', name: 'X' }] })))).message).toMatch(/belongs to PushForm/);
    await expect(platform.sideload(await archive({}, { 'signature.json': encode('{}') }))).rejects.toMatchObject({ details: { problem: 'signature.invalid' } });
    await expect(platform.sideload(await archive({}, { 'panel.html': encode('<b>') }))).rejects.toMatchObject({ details: { problem: 'file.type' } });
  });

  it('installs what the user approved, unsigned and from developer mode, with only granted permissions', async () => {
    const { platform, store } = setup({});
    const request = await platform.sideload(await archive({ permissions: ['settings', 'clipboard.write'] }));
    expect(request).toMatchObject({ integrity: 'unsigned', source: 'developer', replaces: null, newPermissions: ['settings', 'clipboard.write'] });
    const record = await platform.install(request, ['settings']);
    expect(record).toMatchObject({ id: 'com.example.stairs', integrity: 'unsigned', source: 'developer', enabled: true, grants: ['settings'] });
    expect((await store.list()).map((r) => r.id)).toEqual(['com.example.stairs']);
  });

  it('shows a reload what it newly asks for', async () => {
    const { platform } = setup({});
    await platform.install(await platform.sideload(await archive()), ['settings']);
    const reload = await platform.sideload(await archive({ version: '1.0.1', permissions: ['settings', 'file.export'] }));
    expect(reload.replaces?.version).toBe('1.0.0');
    expect(reload.newPermissions).toEqual(['file.export']);
  });
});

describe('running', () => {
  it('lists contributions without starting anything, then starts the runtime once on first use', async () => {
    const activate = vi.fn((context: { commands: { register(id: string, h: () => unknown): void } }) => {
      context.commands.register('com.example.stairs.make', () => 'made');
    });
    const { platform, started } = setup({ 'com.example.stairs': { activate } });
    await platform.install(await platform.sideload(await archive()), ['settings']);
    expect(platform.contributions('modeling').map((c) => c.name)).toEqual(['Make stairs', 'Stairs']);
    expect(platform.contributions('layout')).toEqual([]);
    expect(started).toEqual([]);
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make')).toBe('made');
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make')).toBe('made');
    expect(started).toEqual(['com.example.stairs']);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(platform.state('com.example.stairs')?.run).toBe('running');
  });

  it('stops a disabled extension and refuses to run it', async () => {
    const { platform, terminated } = setup({ 'com.example.stairs': { activate(c: { commands: { register(i: string, h: () => unknown): void } }) { c.commands.register('com.example.stairs.make', () => 1); } } });
    await platform.install(await platform.sideload(await archive()), []);
    await platform.invoke('com.example.stairs', 'com.example.stairs.make');
    await platform.setEnabled('com.example.stairs', false);
    expect(terminated).toEqual(['com.example.stairs']);
    expect(platform.contributions()).toEqual([]);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toMatch(/turned off/);
  });

  it('uninstalls keeping or deleting settings, never anything else', async () => {
    const { platform, settings, settingsFor } = setup({});
    await platform.install(await platform.sideload(await archive()), ['settings']);
    const record = platform.state('com.example.stairs')!.record;
    await settingsFor(record).save(record.id, 1, { kerf: 1 }, null);
    await platform.uninstall('com.example.stairs', { deleteSettings: false });
    expect(await settings.get('com.example.stairs')!.load('com.example.stairs')).not.toBeNull();
    await platform.install(await platform.sideload(await archive()), []);
    await platform.uninstall('com.example.stairs', { deleteSettings: true });
    expect(await settings.get('com.example.stairs')!.load('com.example.stairs')).toBeNull();
    expect(platform.list()).toEqual([]);
  });

  it('turns side-loaded extensions off with developer mode, and drops them where policy forbids it', async () => {
    const { platform, store } = setup({});
    await platform.install(await platform.sideload(await archive()), []);
    await platform.setDeveloperMode(false);
    expect(platform.state('com.example.stairs')?.record.enabled).toBe(false);
    expect(platform.contributions()).toEqual([]);
    const forbidden = new ExtensionPlatform({ ...platform['options'], developerMode: memoryDeveloperMode(true, false), store });
    await forbidden.load();
    expect(forbidden.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('ends a failed runtime, reports it, and starts again on the next use', async () => {
    const { platform, terminated, failures, started } = setup({ 'com.example.stairs': { activate() { throw new Error('broken start'); } } });
    await platform.install(await platform.sideload(await archive()), []);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toBe('broken start');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', failure: { kind: 'activation-failed' } });
    expect(terminated).toEqual(['com.example.stairs']);
    expect(failures).toEqual(['com.example.stairs:activation-failed']);
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(started).toEqual(['com.example.stairs', 'com.example.stairs']);
  });

  it('names the action that was running, turns off an extension that keeps failing, and restarts it on request', async () => {
    let clock = 0;
    const { platform, store } = setup({ 'com.example.stairs': { activate() { throw new Error('broken start'); } } }, { now: () => new Date(clock) });
    await platform.install(await platform.sideload(await archive()), []);
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', failedAction: 'Make stairs', crashDisabled: false });
    platform.dismissFailure('com.example.stairs');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'stopped', failure: null, failedAction: null });
    // Failures far apart do not count together.
    clock += 11 * 60_000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    clock += 1000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')!.record.enabled).toBe(true);
    clock += 1000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', crashDisabled: true, record: { enabled: false } });
    expect((await store.list())[0]!.enabled).toBe(false);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toMatch(/turned off/);

    await platform.restart('com.example.stairs');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'stopped', failure: null, crashDisabled: false, generation: 1, record: { enabled: true } });
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toBe('broken start');
  });

  it('keeps the latest log lines of each extension', async () => {
    const { platform } = setup({ 'com.example.stairs': { activate(c: { log: { write(e: unknown): Promise<unknown> }; commands: { register(i: string, h: () => unknown): void } }) {
      c.commands.register('com.example.stairs.make', async () => { await c.log.write({ step: 'made' }); });
    } } });
    await platform.install(await platform.sideload(await archive()), []);
    await platform.invoke('com.example.stairs', 'com.example.stairs.make');
    expect(platform.state('com.example.stairs')?.logs.map((l) => l.entry)).toEqual([{ step: 'made' }]);
  });
});
