// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import { zipSync } from 'fflate';
import { buildManifest, distributionSigningInput, encodeDistributionBase64, readPackageArchive, sha256Hex, validatePackage,
  type DistributionKey, type RegistryIndex, type RevocationFeed, type SignaturePurpose } from '@pushform/extension-protocol';
import { ExtensionRegistry, fetchDistribution, memoryDistributionCache, type DistributionCache, type DistributionTransport } from './registry';
import { ExtensionPlatform } from './platform';
import { memoryExtensionStore } from './store';
import { memoryDeveloperMode } from './developerMode';
import { memorySettingsStore } from '../runtime/settings';
import { messagePortTransport } from '../runtime/port';
import { startGuest, type ExtensionContext } from '../runtime/guest';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const start = new Date('2026-11-09T00:00:00Z'), origin = 'https://plugins.example.test';
let keys: DistributionKey[], pairs: CryptoKeyPair[], archive: Uint8Array, index: RegistryIndex, revocations: RevocationFeed;
async function sign(purpose: SignaturePurpose, data: Uint8Array, key = 0) {
  const value = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pairs[key]!.privateKey, distributionSigningInput(purpose, data));
  return { version: 1, algorithm: 'ES256', keyId: keys[key]!.id, value: encodeDistributionBase64(new Uint8Array(value)) };
}
async function wrap(data: RegistryIndex | RevocationFeed, key = 0) {
  const payload = encode(data); return encode({ payload: encodeDistributionBase64(payload), signature: await sign(data.kind, payload, key) });
}
beforeAll(async () => {
  pairs = await Promise.all([0, 1].map(() => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])));
  keys = await Promise.all(pairs.map(async (pair, i) => ({ id: `key-${i}`, publicKey: encodeDistributionBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' })));
  const files = new Map<string, Uint8Array>([['main.js', new TextEncoder().encode('export function activate() {}')]]);
  files.set('manifest.json', await buildManifest({ id: 'io.pushform.example', name: 'Example', publisher: 'PushForm', version: '1.0.0', apiVersion: '^0.1.0',
    main: 'main.js', editors: ['modeling'], contributions: [{ id: 'io.pushform.example.open', target: 'model.command', name: 'Open' }],
    permissions: ['settings', 'model.read'], defaultLocale: 'en', license: 'MIT' }, files));
  const validated = await validatePackage(files);
  files.set('signature.json', encode(await sign('package', files.get('manifest.json')!)));
  archive = zipSync(Object.fromEntries(files));
  const times = { version: 1 as const, sequence: 1, issuedAt: '2026-11-08T00:00:00Z', expiresAt: '2026-11-15T00:00:00Z' };
  index = { ...times, kind: 'registry', releases: [{ manifest: validated.manifest, contentHash: validated.contentHash, archiveHash: await sha256Hex(archive),
    archiveBytes: archive.length, url: `${origin}/packages/example.zip`, minimumAppVersion: '1.0.0', releaseNotes: 'Initial release', recommended: true }] };
  revocations = { ...times, kind: 'revocations', keys: [], releases: [], permissions: [] };
});
const platforms: ExtensionPlatform[] = [], channels: MessageChannel[] = [];
afterEach(async () => {
  await Promise.all(platforms.splice(0).map(platform => platform.stopAll()));
  for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); }
  vi.unstubAllGlobals();
});
async function setup(options: { cache?: DistributionCache; appVersion?: string; initialNetwork?: boolean } = {}) {
  let time = start;
  const responses = new Map<string, Uint8Array>();
  const downloads: string[] = [];
  const transport = vi.fn<DistributionTransport>(async (url, limit) => {
    downloads.push(url); const response = responses.get(url); if (!response) throw new Error('Offline');
    if (response.length > limit) throw new Error('Too large'); return response.slice();
  });
  const cache = options.cache ?? memoryDistributionCache();
  const config = { keys, origins: [origin], registryUrl: `${origin}/index.json`, revocationsUrl: `${origin}/revocations.json`, appVersion: options.appVersion ?? '1.0.0',
    transport, cache, now: () => time };
  const registry = new ExtensionRegistry(config);
  const network = async (nextIndex = index, nextFeed = revocations, key = 0) => {
    responses.set(config.registryUrl, await wrap(nextIndex, key)); responses.set(config.revocationsUrl, await wrap(nextFeed, key));
    responses.set(index.releases[0]!.url, archive);
  };
  if (options.initialNetwork !== false) await network();
  return { registry, cache, config, responses, downloads, transport, network, setTime: (value: Date) => { time = value; } };
}

describe('official extension registry', () => {
  it('downloads and verifies the actual signed archive with developer mode absent', async () => {
    const s = await setup(); await s.registry.refresh();
    expect(s.registry.status()).toMatchObject({ available: true, fresh: true, error: null });
    const release = s.registry.releases()[0]!;
    const checked = await s.registry.package(release.manifest.id, release.contentHash);
    expect(checked.validated.integrity).toBe('official'); expect(checked.validated.manifest).toEqual(release.manifest);
    expect(s.downloads).toEqual([s.config.revocationsUrl, s.config.registryUrl, release.url]);
    const external = s.registry.releases()[0]!; (external.manifest as { name: string }).name = 'Edited externally';
    expect(s.registry.releases()[0]!.manifest.name).toBe('Example');
  });
  it('rechecks cached signatures and keeps verified data through offline and bad-signature refreshes', async () => {
    const s = await setup(); await s.registry.refresh(); s.responses.clear();
    const reopened = new ExtensionRegistry(s.config); await reopened.initialize();
    expect(reopened.status()).toMatchObject({ available: true, fresh: true });
    await reopened.refresh(); expect(reopened.status().error).toContain('Offline'); expect(reopened.releases()).toHaveLength(1);
    s.responses.set(s.config.registryUrl, encode({ unsigned: index })); await reopened.refresh();
    expect(reopened.status().available).toBe(true); expect(reopened.releases()).toHaveLength(1);
    await s.cache.write('registry', encode(index), await s.cache.read('registry'));
    const corrupt = new ExtensionRegistry(s.config); await corrupt.initialize(); expect(corrupt.status().available).toBe(false);
    expect(corrupt.releases()).toHaveLength(0);
  });
  it('cannot install with only one verified feed, an expired cache, or an unknown release', async () => {
    const s = await setup(); s.responses.delete(s.config.revocationsUrl); await s.registry.refresh();
    const release = index.releases[0]!;
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'registry.unavailable' });
    await s.network(); await s.registry.refresh();
    await expect(s.registry.package(release.manifest.id, 'b'.repeat(64))).rejects.toMatchObject({ problem: 'release.unavailable' });
    s.setTime(new Date('2026-11-16T00:00:00Z'));
    expect(s.registry.releases()).toHaveLength(1); expect(s.registry.status().fresh).toBe(false);
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'registry.unavailable' });
    const reopened = new ExtensionRegistry(s.config); await reopened.initialize(); expect(reopened.status()).toMatchObject({ available: true, fresh: false });
  });
  it('refuses archive tampering and an authenticated index that disagrees with its signed package', async () => {
    const s = await setup(); await s.registry.refresh(); const release = index.releases[0]!;
    s.responses.set(release.url, new Uint8Array(archive.length));
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'archive.hash' });
    await s.network({ ...index, sequence: 2, releases: [{ ...release, manifest: { ...release.manifest, name: 'Wrong name' } }] }); await s.registry.refresh();
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'release.mismatch' });
  });
  it('refuses an unsupported app version and a signed download URL outside the configured origins', async () => {
    const s = await setup({ appVersion: '0.9.0' }); await s.registry.refresh(); const release = index.releases[0]!;
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'app.unsupported' });
    const newer = await setup(); await newer.network({ ...index, sequence: 2, releases: [{ ...release, url: 'https://elsewhere.example/archive.zip' }] }); await newer.registry.refresh();
    await expect(newer.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ problem: 'url.refused' });
    expect(newer.downloads).not.toContain('https://elsewhere.example/archive.zip');
  });
  it('keeps revocations despite a failed registry download and refuses a lower/conflicting sequence', async () => {
    const s = await setup(); await s.registry.refresh(); const release = index.releases[0]!;
    const revoked = { ...revocations, sequence: 2, releases: [{ id: release.manifest.id, contentHash: release.contentHash, reason: 'Unsafe release' }] };
    s.responses.set(s.config.revocationsUrl, await wrap(revoked)); s.responses.delete(s.config.registryUrl); await s.registry.refresh();
    expect(s.registry.releaseReason(release.manifest.id, release.contentHash)).toBe('Unsafe release'); expect(s.registry.releases()).toHaveLength(0);
    await s.network(); await s.registry.refresh(); expect(s.registry.status().error).toContain('older or conflicting');
    expect(s.registry.releaseReason(release.manifest.id, release.contentHash)).toBe('Unsafe release');
    await s.network(index, { ...revocations, sequence: 3 }); await s.registry.refresh();
    expect(s.registry.status().error).toContain('cannot be removed');
    const reopened = new ExtensionRegistry(s.config); await reopened.initialize();
    expect(reopened.releaseReason(release.manifest.id, release.contentHash)).toBe('Unsafe release');
  });
  it('rotates pinned keys and refuses a future feed signed by an already-revoked key', async () => {
    const s = await setup(); await s.registry.refresh();
    const next = { ...revocations, sequence: 2, keys: [{ keyId: keys[0]!.id, reason: 'Compromised key' }] };
    await s.network({ ...index, sequence: 2 }, next, 1); await s.registry.refresh();
    expect(s.registry.status()).toMatchObject({ fresh: true, error: null });
    const release = index.releases[0]!;
    await expect(s.registry.package(release.manifest.id, release.contentHash)).rejects.toMatchObject({ details: { problem: 'signature.invalid' } });
    await s.network({ ...index, sequence: 3 }, { ...next, sequence: 3 }, 0); await s.registry.refresh();
    expect(s.registry.status().error).toContain('signature could not be verified'); expect(s.registry.revokedKeys().has(keys[0]!.id)).toBe(true);
  });
  it('rechecks a release after an asynchronous download and does not allow revocation or expiry to race installation', async () => {
    const s = await setup(); await s.registry.refresh(); const release = index.releases[0]!;
    let finish!: (bytes: Uint8Array) => void;
    s.transport.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = s.registry.package(release.manifest.id, release.contentHash); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    s.setTime(new Date('2026-11-16T00:00:00Z')); finish(archive);
    await expect(pending).rejects.toMatchObject({ problem: 'registry.unavailable' });
  });
  it('does not roll back a shared cache when another tab has already saved newer revocations', async () => {
    const s = await setup(); await s.registry.refresh();
    const other = new ExtensionRegistry(s.config); await other.initialize();
    const release = index.releases[0]!, id = release.manifest.id;
    await s.network(index, { ...revocations, sequence: 2, releases: [{ id, contentHash: release.contentHash, reason: 'Newer tab revocation' }] });
    await s.registry.refresh();
    await s.network(); await other.refresh();
    expect(other.releaseReason(id, release.contentHash)).toBe('Newer tab revocation');
    const reopened = new ExtensionRegistry(s.config); await reopened.initialize();
    expect(reopened.releaseReason(id, release.contentHash)).toBe('Newer tab revocation');
  });
  it('keeps the actual cached payload on cross-tab same-sequence equivocation', async () => {
    const s = await setup(); await s.registry.refresh();
    const other = new ExtensionRegistry(s.config); await other.initialize();
    const release = index.releases[0]!, id = release.manifest.id;
    const revoked = { ...revocations, sequence: 2, releases: [{ id, contentHash: release.contentHash, reason: 'Keep this reason' }] };
    await s.network(index, revoked); await s.registry.refresh();
    await s.network(index, { ...revocations, sequence: 2 }); await other.refresh();
    expect(other.status().error).toContain('older or conflicting');
    expect(other.releaseReason(id, release.contentHash)).toBe('Keep this reason');
  });
  it('applies global, plugin-wide and individual-release permission revocations to future installs', async () => {
    const s = await setup(), release = index.releases[0]!, id = release.manifest.id;
    await s.network(index, { ...revocations, sequence: 2, permissions: [
      { permission: 'network', reason: 'Global network stop' }, { id, permission: 'model.write', reason: 'Plugin writes stopped' },
      { id, contentHash: release.contentHash, permission: 'model.read', reason: 'Release reads stopped' },
    ] }); await s.registry.refresh();
    expect(s.registry.revokedPermissions(id, release.contentHash).map(entry => entry.permission)).toEqual(['network', 'model.write', 'model.read']);
    expect(s.registry.revokedPermissions(id, 'b'.repeat(64)).map(entry => entry.permission)).toEqual(['network', 'model.write']);
    expect(s.registry.revokedPermissions('org.example.other', 'b'.repeat(64)).map(entry => entry.permission)).toEqual(['network']);
  });
});

describe('bounded host distribution transport', () => {
  it('omits credentials/referrer and refuses redirects, HTTP errors and a declared oversized download', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('data')); vi.stubGlobal('fetch', fetcher);
    expect(await fetchDistribution(`${origin}/index`, 10)).toEqual(new TextEncoder().encode('data'));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    fetcher.mockResolvedValue(new Response('data', { headers: { 'Content-Length': '99' } }));
    await expect(fetchDistribution(`${origin}/index`, 10)).rejects.toMatchObject({ problem: 'limit.exceeded' });
    fetcher.mockResolvedValue(new Response('no', { status: 503 }));
    await expect(fetchDistribution(`${origin}/index`, 10)).rejects.toMatchObject({ problem: 'download.failed' });
  });
  it('bounds streamed bytes even without Content-Length and cancels the reader on overflow', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); }, cancel: cancelled });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    await expect(fetchDistribution(`${origin}/index`, 10)).rejects.toMatchObject({ problem: 'limit.exceeded' });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

async function platformSetup(handler: (context: ExtensionContext, version: string) => unknown | Promise<unknown> = (_context, version) => version) {
  const s = await setup(); await s.registry.refresh();
  const store = memoryExtensionStore(), terminated = vi.fn(), started: string[] = [];
  const settings = memorySettingsStore();
  const platform = new ExtensionPlatform({ store, registry: s.registry, developerMode: memoryDeveloperMode(false), settingsStore: () => settings,
    startRuntime: async record => {
      started.push(record.version); const channel = new MessageChannel(); channels.push(channel);
      await startGuest(messagePortTransport(channel.port2), async () => ({ activate(context: ExtensionContext) { context.commands.register('io.pushform.example.open', () => handler(context, record.version)); } }));
      return { port: messagePortTransport(channel.port1), terminate: () => { terminated(); channel.port1.close(); channel.port2.close(); } };
    } });
  platforms.push(platform); await platform.load(); await s.registry.refresh();
  const release = index.releases[0]!;
  const install = async () => platform.install(await platform.prepareOfficial(release.manifest.id, release.contentHash), release.manifest.permissions);
  return { ...s, platform, store, started, terminated, release, install };
}

describe('official platform install, update and revocation', () => {
  it('requires a new permission review if revocations change while approval is open', async () => {
    const s = await platformSetup(); const request = await s.platform.prepareOfficial(s.release.manifest.id, s.release.contentHash);
    await s.network(index, { ...revocations, sequence: 2, permissions: [{ permission: 'model.read', reason: 'Global reads stopped' }] }); await s.registry.refresh();
    await expect(s.platform.install(request, request.manifest.permissions)).rejects.toMatchObject({ details: { problem: 'permissions.stale' } });
    expect(await s.store.list()).toEqual([]);
    const reviewed = await s.platform.prepareOfficial(s.release.manifest.id, s.release.contentHash);
    expect(reviewed.blockedPermissions).toEqual([{ permission: 'model.read', reason: 'Global reads stopped' }]);
    await s.platform.install(reviewed, reviewed.manifest.permissions); expect(s.platform.state(s.release.manifest.id)?.record.grants).toEqual(['settings']);
  });
  it('installs through signed discovery, starts lazily and refuses a stale or fabricated install request', async () => {
    const s = await platformSetup(); const request = await s.platform.prepareOfficial(s.release.manifest.id, s.release.contentHash);
    expect(s.started).toEqual([]); expect(request.source).toBe('registry'); expect(request.newPermissions).toEqual(['settings', 'model.read']);
    await s.platform.install(request, request.manifest.permissions);
    expect(await s.platform.invoke(s.release.manifest.id, 'io.pushform.example.open')).toBe('1.0.0');
    await expect(s.platform.install(request, request.manifest.permissions)).rejects.toMatchObject({ details: { problem: 'release.stale' } });
    await expect(s.platform.install({ ...request, replaces: s.platform.state(s.release.manifest.id)!.record }, [])).rejects.toMatchObject({ details: { problem: 'registry.unverified' } });
  });
  it('ends a revoked release immediately, cancels its invocation, retains its data and reports the reason', async () => {
    let invoked = false;
    const s = await platformSetup(() => { invoked = true; return new Promise(() => {}); }); await s.install();
    const id = s.release.manifest.id, pending = s.platform.invoke(id, 'io.pushform.example.open');
    const cancelled = pending.catch(error => error);
    await vi.waitFor(() => expect(invoked).toBe(true));
    const saved = (await s.store.list())[0]!;
    await s.network(index, { ...revocations, sequence: 2, releases: [{ id, contentHash: s.release.contentHash, reason: 'Unsafe release' }] });
    await s.registry.refresh(); expect(await cancelled).toMatchObject({ code: 'cancelled' });
    expect(s.terminated).toHaveBeenCalledOnce(); expect(s.platform.contributions()).toEqual([]);
    expect(s.platform.state(id)?.failure).toMatchObject({ error: { details: { problem: 'release.revoked' }, message: expect.stringContaining('Unsafe release') } });
    expect((await s.store.list())[0]).toEqual(saved);
    await expect(s.platform.invoke(id, 'io.pushform.example.open')).rejects.toMatchObject({ details: { problem: 'release.revoked' } });
    expect((await s.platform.activity(id)).entries.some(entry => entry.event.type === 'release-revoked')).toBe(true);
  });
  it('removes a revoked permission, restarts with remaining grants and cannot regrant it on reinstall', async () => {
    const s = await platformSetup(context => { try { return Boolean(context.model); } catch { return false; } }); await s.install();
    const id = s.release.manifest.id;
    expect(await s.platform.invoke(id, 'io.pushform.example.open')).toBe(true);
    await s.network(index, { ...revocations, sequence: 2, permissions: [{ id, contentHash: s.release.contentHash, permission: 'model.read', reason: 'Read revoked' }] });
    await s.registry.refresh();
    expect(s.platform.state(id)?.record.grants).toEqual(['settings']); expect(s.terminated).toHaveBeenCalledOnce();
    expect(await s.platform.invoke(id, 'io.pushform.example.open')).toBe(false);
    await s.install(); expect(s.platform.state(id)?.record.grants).toEqual(['settings']);
  });
  it('keeps active invocations pinned to their release and requires approval for an expanded update', async () => {
    let finish!: () => void, invoked = false;
    const s = await platformSetup(async (_context, version) => {
      if (version === '1.0.0') { invoked = true; await new Promise<void>(resolve => { finish = resolve; }); } return version;
    }); await s.install();
    const id = s.release.manifest.id, oldInvocation = s.platform.invoke(id, 'io.pushform.example.open');
    await vi.waitFor(() => expect(invoked).toBe(true));
    const files = readPackageArchive(archive); files.delete('signature.json'); files.delete('manifest.json');
    const { files: _hashes, ...manifest } = s.release.manifest;
    files.set('manifest.json', await buildManifest({ ...manifest, version: '2.0.0', permissions: [...manifest.permissions, 'clipboard.write'] }, files));
    const validated = await validatePackage(files); files.set('signature.json', encode(await sign('package', files.get('manifest.json')!)));
    const nextArchive = zipSync(Object.fromEntries(files));
    const next = { ...s.release, manifest: validated.manifest, contentHash: validated.contentHash, archiveHash: await sha256Hex(nextArchive), archiveBytes: nextArchive.length, url: `${origin}/packages/v2.zip` };
    await s.network({ ...index, sequence: 2, releases: [{ ...s.release, recommended: false }, next] }); s.responses.set(next.url, nextArchive); await s.registry.refresh();
    expect(s.platform.state(id)?.record.version).toBe('1.0.0');
    const request = await s.platform.prepareOfficial(id, next.contentHash); expect(request.newPermissions).toEqual(['clipboard.write']);
    const generation = s.platform.state(id)!.generation;
    let restartRequested = false, restarted: Promise<unknown> | null = null;
    const unsubscribe = s.platform.subscribe(() => {
      if (!restartRequested && s.platform.state(id)!.generation > generation) {
        restartRequested = true;
        restarted = s.platform.invoke(id, 'io.pushform.example.open').catch(error => error);
      }
    });
    let installed = false;
    const updating = s.platform.install(request, s.release.manifest.permissions).then(record => { installed = true; return record; });
    await Promise.resolve(); expect(installed).toBe(false); expect(s.terminated).not.toHaveBeenCalled();
    await expect(s.platform.invoke(id, 'io.pushform.example.open')).rejects.toMatchObject({ code: 'unavailable' });
    finish(); expect(await oldInvocation).toBe('1.0.0'); await updating;
    expect(restartRequested).toBe(true); expect(await restarted).toBe('2.0.0'); unsubscribe();
    expect(s.platform.state(id)?.record.version).toBe('2.0.0'); expect(s.platform.state(id)?.record.grants).not.toContain('clipboard.write');
    expect(await s.platform.invoke(id, 'io.pushform.example.open')).toBe('2.0.0'); expect(s.started).toEqual(['1.0.0', '2.0.0']);
  });
});
