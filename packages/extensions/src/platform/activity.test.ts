// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildManifest, type ExtensionManifestInput } from '@pushform/extension-protocol';
import { startGuest } from '../runtime/guest';
import type { FetchTransport } from '../runtime/io';
import { messagePortTransport } from '../runtime/port';
import { memorySettingsStore } from '../runtime/settings';
import { activityOverflow, memoryActivityStore, type ActivityEntry, type ActivityEvent } from './activity';
import { memoryDeveloperMode } from './developerMode';
import { ExtensionPlatform, type ExtensionPlatformOptions } from './platform';
import { memoryExtensionStore } from './store';

const encode = (s: string) => new TextEncoder().encode(s);
const base = {
  id: 'com.example.prices', name: 'Lumber Prices', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings', 'network', 'model.egress'],
  destinations: [
    { url: 'https://api.example.com/v1', purpose: 'Price lookup', sendsModelData: false },
    { url: 'https://upload.example.com/', purpose: 'Share a cut list', sendsModelData: true },
  ],
  contributions: [{ target: 'model.command', id: 'com.example.prices.send', name: 'Send' }],
} satisfies Omit<ExtensionManifestInput, 'files'>;

async function archive(overrides: Partial<Omit<ExtensionManifestInput, 'files'>> = {}): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest({ ...base, ...overrides }, files));
  return zipSync(Object.fromEntries(files));
}

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

interface Context {
  commands: { register(id: string, handler: (params: { url: string; body?: string }) => unknown): void };
  http: { fetch(input: unknown): Promise<unknown> };
}

/** An extension whose command fetches the URL it is given, with the body it is given. */
const fetching = { activate(c: Context) { c.commands.register('com.example.prices.send', ({ url, body }) => c.http.fetch({ url, method: body ? 'POST' : 'GET', body })); } };

function setup(module: unknown, overrides: Partial<ExtensionPlatformOptions> = {}) {
  const activity = memoryActivityStore();
  const developerMode = memoryDeveloperMode(true);
  const platform = new ExtensionPlatform({
    store: memoryExtensionStore(), developerMode, activity,
    startRuntime: async () => {
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => module);
      return { port: messagePortTransport(channel.port1), terminate: () => {} };
    },
    settingsStore: () => memorySettingsStore(),
    ...overrides,
  });
  return { platform, activity, developerMode };
}

const ID = 'com.example.prices';
/** The record's events, oldest first. */
const events = async (platform: ExtensionPlatform): Promise<ActivityEvent[]> => (await platform.activity(ID)).entries.map((e) => e.event).reverse();

describe('the activity record', () => {
  it('records installs, reloads, updates, grants and permissions removed', async () => {
    const { platform } = setup({});
    await platform.install(await platform.sideload(await archive()), ['settings', 'network']);
    await platform.install(await platform.sideload(await archive()), ['settings', 'network']);
    await platform.install(await platform.sideload(await archive({ version: '1.1.0' })), ['network', 'model.egress']);
    expect(await events(platform)).toEqual([
      { type: 'installed', name: 'Lumber Prices', version: '1.0.0', integrity: 'unsigned' },
      { type: 'granted', permissions: ['settings', 'network'] },
      { type: 'reloaded', name: 'Lumber Prices', version: '1.0.0' },
      { type: 'updated', name: 'Lumber Prices', from: '1.0.0', to: '1.1.0' },
      { type: 'granted', permissions: ['model.egress'] },
      { type: 'revoked', permissions: ['settings'] },
    ]);
  });

  it('records activation, stops with their reason, who turned it off, and uninstalling', async () => {
    const { platform } = setup(fetching);
    await platform.install(await platform.sideload(await archive()), []);
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://example.org/' }).catch(() => {});
    await platform.setEnabled(ID, false);
    await platform.setEnabled(ID, true);
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://example.org/' }).catch(() => {});
    await platform.restart(ID);
    await platform.setDeveloperMode(false);
    await platform.setDeveloperMode(true);
    await platform.setEnabled(ID, true);
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://example.org/' }).catch(() => {});
    await platform.stopAll();
    await platform.uninstall(ID, { deleteSettings: true });
    expect((await events(platform)).slice(1)).toEqual([
      { type: 'activated' },
      { type: 'stopped', reason: 'turned-off' },
      { type: 'disabled', by: 'user' },
      { type: 'enabled' },
      { type: 'activated' },
      { type: 'stopped', reason: 'restarted' },
      { type: 'disabled', by: 'developer-mode' },
      { type: 'enabled' },
      { type: 'activated' },
      { type: 'stopped', reason: 'closed' },
      { type: 'uninstalled', name: 'Lumber Prices', version: '1.0.0', settingsDeleted: true, by: 'user' },
    ]);
  });

  it('records failures by kind and turning off after repeated failures', async () => {
    const { platform } = setup({ activate() { throw new Error('broken start with model data'); } });
    await platform.install(await platform.sideload(await archive()), []);
    for (let i = 0; i < 3; i++) await platform.invoke(ID, 'com.example.prices.send', {}).catch(() => {});
    const recorded = await events(platform);
    expect(recorded.slice(1)).toEqual([
      { type: 'failed', kind: 'activation-failed' },
      { type: 'failed', kind: 'activation-failed' },
      { type: 'failed', kind: 'activation-failed' },
      { type: 'disabled', by: 'crash-loop' },
    ]);
    expect(JSON.stringify(recorded)).not.toContain('broken start');
  });

  it('records side-loaded extensions removed because developer mode is not allowed', async () => {
    const { platform } = setup({});
    await platform.install(await platform.sideload(await archive()), []);
    const forbidden = new ExtensionPlatform({ ...platform['options'], developerMode: memoryDeveloperMode(true, false) });
    await forbidden.load();
    expect((await events(forbidden)).at(-1)).toMatchObject({ type: 'uninstalled', by: 'policy', settingsDeleted: false });
  });

  it('counts requests and bytes per destination origin, never URLs, bodies or responses', async () => {
    const transport: FetchTransport = async (r) => r.url.endsWith('/start')
      ? { status: 302, headers: { location: 'https://api.example.com/v1/end' }, body: new Uint8Array() }
      : { status: 200, headers: {}, body: encode('secret-response') };
    const { platform, activity } = setup(fetching, { fetchTransport: transport });
    await platform.install(await platform.sideload(await archive()), ['network', 'model.egress']);
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://api.example.com/v1/quote?wood=oak' });
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://upload.example.com/parts?token=x', body: 'board-1 600x300' });
    // A POST redirected with 302 continues as GET without its body.
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://api.example.com/v1/start', body: 'abc' });

    const state = platform.state(ID)!;
    expect(Object.fromEntries(state.egress)).toEqual({
      'https://api.example.com': { requests: 3, bytesSent: 3, bytesReceived: 30 },
      'https://upload.example.com': { requests: 1, bytesSent: 15, bytesReceived: 15 },
    });
    expect(Object.fromEntries(state.bytesSent)).toEqual({ 'https://api.example.com': 3, 'https://upload.example.com': 15 });
    const record = await platform.activity(ID);
    expect(record.egress.map(({ origin, requests, bytesSent, bytesReceived }) => ({ origin, requests, bytesSent, bytesReceived }))).toEqual([
      { origin: 'https://api.example.com', requests: 3, bytesSent: 3, bytesReceived: 30 },
      { origin: 'https://upload.example.com', requests: 1, bytesSent: 15, bytesReceived: 15 },
    ]);
    // One entry per destination for the run, updated in place.
    expect(record.entries.filter((e) => e.event.type === 'egress').map((e) => e.event)).toEqual([
      { type: 'egress', origin: 'https://api.example.com', requests: 3, bytesSent: 3, bytesReceived: 30 },
      { type: 'egress', origin: 'https://upload.example.com', requests: 1, bytesSent: 15, bytesReceived: 15 },
    ]);
    const stored = JSON.stringify([record, await activity.list(ID)]);
    for (const content of ['quote', 'wood', 'token', 'parts', 'board-1', 'secret-response', '/v1']) expect(stored, content).not.toContain(content);

    // A new run adds to the totals and gets its own entries; this session's counts carry across restarts.
    await platform.restart(ID);
    await platform.invoke(ID, 'com.example.prices.send', { url: 'https://api.example.com/v1/prices' });
    const after = await platform.activity(ID);
    expect(after.egress[0]).toMatchObject({ origin: 'https://api.example.com', requests: 4, bytesReceived: 45 });
    expect(after.entries.filter((e) => e.event.type === 'egress')).toHaveLength(3);
    expect(platform.state(ID)!.egress.get('https://api.example.com')?.requests).toBe(4);
  });

  it('keeps the record after uninstalling, lists it by name, and clears it on request', async () => {
    const { platform } = setup({});
    await platform.install(await platform.sideload(await archive()), []);
    await platform.uninstall(ID, { deleteSettings: false });
    expect(await platform.uninstalledActivity()).toEqual([{ id: ID, name: 'Lumber Prices' }]);
    expect((await platform.activity(ID)).entries.length).toBeGreaterThan(0);
    await platform.clearActivity(ID);
    expect(await platform.activity(ID)).toEqual({ entries: [], egress: [] });
    expect(await platform.uninstalledActivity()).toEqual([]);
  });
});

describe('activity store bounds', () => {
  const entry = (extensionId: string, i: number): ActivityEntry =>
    ({ key: `${extensionId}:${i}`, extensionId, at: new Date(i * 1000).toISOString(), seq: i, event: { type: 'activated' } });

  it('keeps the newest entries per extension and overall', async () => {
    const store = memoryActivityStore({ perExtension: 3, total: 5 });
    for (let i = 0; i < 5; i++) await store.put(entry('a', i));
    expect((await store.list('a')).map((e) => e.key)).toEqual(['a:2', 'a:3', 'a:4']);
    for (let i = 10; i < 13; i++) await store.put(entry('b', i));
    expect((await store.list('a')).map((e) => e.key)).toEqual(['a:3', 'a:4']);
    expect((await store.list('b')).map((e) => e.key)).toEqual(['b:10', 'b:11', 'b:12']);
    // Replacing an entry by key does not count twice.
    await store.put({ ...entry('b', 12), at: new Date(20_000).toISOString() });
    expect((await store.list('b'))).toHaveLength(3);
  });

  it('orders entries of the same moment by sequence', () => {
    const at = new Date(0).toISOString();
    const entries = [3, 1, 2].map((seq) => ({ key: `k${seq}`, extensionId: 'a', at, seq, event: { type: 'activated' } as const }));
    expect(activityOverflow(entries, { perExtension: 2, total: 10 })).toEqual(['k1']);
  });

  it('adds network totals and clears them with the entries', async () => {
    const store = memoryActivityStore();
    await store.addEgress('a', 'https://x.example', { requests: 1, bytesSent: 2, bytesReceived: 3 }, '2026-01-01T00:00:00.000Z');
    await store.addEgress('a', 'https://x.example', { requests: 1, bytesSent: 2, bytesReceived: 3 }, '2026-01-02T00:00:00.000Z');
    expect(await store.egress('a')).toEqual([{ extensionId: 'a', origin: 'https://x.example', requests: 2, bytesSent: 4, bytesReceived: 6,
      first: '2026-01-01T00:00:00.000Z', last: '2026-01-02T00:00:00.000Z' }]);
    expect(await store.extensions()).toEqual(['a']);
    await store.clear('a');
    expect(await store.egress('a')).toEqual([]);
    expect(await store.extensions()).toEqual([]);
  });
});
