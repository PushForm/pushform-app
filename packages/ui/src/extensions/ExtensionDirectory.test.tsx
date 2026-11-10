// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { zipSync } from 'fflate';
import { buildManifest, distributionSigningInput, encodeDistributionBase64, sha256Hex, validatePackage,
  type ExtensionPermission, type RegistryIndex, type RevocationFeed, type SignaturePurpose } from '@pushform/extension-protocol';
import { ExtensionPlatform, ExtensionRegistry, memoryDistributionCache, memoryDeveloperMode, memoryExtensionStore, memorySettingsStore } from '@pushform/extensions';
import { ExtensionManagerPanel } from './ExtensionManager';
import { ExtensionRecovery } from './ExtensionRecovery';
import { indexedDbDistributionCache } from './indexedDbExtensionStore';

const platforms: ExtensionPlatform[] = [];
afterEach(async () => { cleanup(); await Promise.all(platforms.splice(0).map(platform => platform.stopAll())); });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function setup() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const now = Date.now(), origin = 'https://plugins.example.test', id = 'io.pushform.cut-list';
  const key = { id: 'test-release', publicKey: encodeDistributionBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    notBefore: new Date(now - 86_400_000).toISOString(), notAfter: new Date(now + 86_400_000).toISOString() };
  const sign = async (purpose: SignaturePurpose, data: Uint8Array) => ({ version: 1, algorithm: 'ES256', keyId: key.id,
    value: encodeDistributionBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, distributionSigningInput(purpose, data)))) });
  const wrap = async (data: RegistryIndex | RevocationFeed) => { const payload = encode(data); return encode({ payload: encodeDistributionBase64(payload), signature: await sign(data.kind, payload) }); };
  const times = { version: 1 as const, sequence: 1, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() };
  const responses = new Map<string, Uint8Array>();
  responses.set(`${origin}/revocations.json`, await wrap({ ...times, kind: 'revocations', keys: [], releases: [], permissions: [] }));
  let sequence = 0;
  const publish = async (version = '1.0.0', permissions: ExtensionPermission[] = ['model.read'], dataVersion = 1) => {
    const files = new Map<string, Uint8Array>([['main.js', new TextEncoder().encode('export function activate() {}')]]);
    files.set('manifest.json', await buildManifest({ id, name: 'Cut List', publisher: 'PushForm', version, apiVersion: '^0.1.0', editors: ['modeling'],
      permissions, defaultLocale: 'en', license: 'MIT', main: 'main.js', description: 'Parts, stock and automatic cutting plans.',
      contributions: [{ target: 'model.command', id: `${id}.open`, name: 'Cut List' }], metadata: { dataVersion, schema: { type: 'object' } } }, files));
    const validated = await validatePackage(files); files.set('signature.json', encode(await sign('package', files.get('manifest.json')!)));
    const archive = zipSync(Object.fromEntries(files)), url = `${origin}/${version}.zip`;
    const release = { manifest: validated.manifest, contentHash: validated.contentHash, archiveHash: await sha256Hex(archive), archiveBytes: archive.length,
      url, minimumAppVersion: '1.0.0', recommended: true, releaseNotes: 'Improved production workflow.' };
    responses.set(url, archive); responses.set(`${origin}/index.json`, await wrap({ ...times, sequence: ++sequence, kind: 'registry', releases: [release] }));
    return release;
  };
  const release = await publish();
  const registry = new ExtensionRegistry({ keys: [key], registryUrl: `${origin}/index.json`, revocationsUrl: `${origin}/revocations.json`, origins: [origin],
    appVersion: '1.0.0', cache: memoryDistributionCache(), transport: async url => { const bytes = responses.get(url); if (!bytes) throw new Error('Offline'); return bytes; } });
  await registry.refresh();
  const startRuntime = vi.fn(async () => { throw new Error('Discovery and installation must not run code'); });
  const platform = new ExtensionPlatform({ registry, store: memoryExtensionStore(), developerMode: memoryDeveloperMode(false), settingsStore: () => memorySettingsStore(), startRuntime });
  platforms.push(platform); await platform.load(); await registry.refresh();
  return { platform, registry, release, publish, startRuntime };
}

it('installs an official package from the styled directory through explicit approval with developer mode off', async () => {
  const s = await setup();
  render(<div className="pf-app"><ExtensionManagerPanel platform={s.platform} developerModeAllowed developerModeOn={false} onClose={() => {}} /></div>);
  const directory = screen.getByRole('list', { name: 'Official extension directory' });
  expect(within(directory).getByText('Parts, stock and automatic cutting plans.')).toBeTruthy();
  fireEvent.click(within(directory).getByRole('button', { name: 'Install Cut List' }));
  let dialog = await screen.findByRole('dialog', { name: 'Install Cut List?' });
  expect(dialog.closest('.pf-dialog-backdrop')?.parentElement).toBe(document.querySelector('.pf-app'));
  expect(within(dialog).getByText('Official, countersigned by PushForm')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(s.platform.list()).toEqual([]);
  fireEvent.click(within(directory).getByRole('button', { name: 'Install Cut List' })); dialog = await screen.findByRole('dialog', { name: 'Install Cut List?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
  await waitFor(() => expect(s.platform.state(s.release.manifest.id)?.record.integrity).toBe('official'));
  expect((screen.getByRole('checkbox', { name: 'Allow unsigned extensions on this device' }) as HTMLInputElement).checked).toBe(false);
  expect(s.startRuntime).not.toHaveBeenCalled();
});

it('marks expanded updates for review and leaves the installed release unchanged until approval', async () => {
  const s = await setup(); await s.platform.install(await s.platform.prepareOfficial(s.release.manifest.id, s.release.contentHash), ['model.read']);
  render(<ExtensionManagerPanel platform={s.platform} developerModeAllowed developerModeOn={false} onClose={() => {}} />);
  await s.publish('2.0.0', ['model.read', 'model.write'], 2); await act(async () => s.registry.refresh());
  expect(screen.getByText('Update needs approval for new permissions or destinations.')).toBeTruthy();
  expect(s.platform.state(s.release.manifest.id)?.record.version).toBe('1.0.0');
  fireEvent.click(screen.getByRole('button', { name: 'Review update for Cut List' }));
  const dialog = await screen.findByRole('dialog', { name: 'Update Cut List?' });
  expect(within(dialog).getAllByText('New')).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(s.platform.state(s.release.manifest.id)?.record.version).toBe('2.0.0'));
  expect(s.platform.state(s.release.manifest.id)?.record.grants).toEqual(['model.read', 'model.write']);
  expect(s.startRuntime).not.toHaveBeenCalled();
});

it('offers a specific contextual install only for a compatible metadata reader and never adds general management', async () => {
  const s = await setup();
  const view = render(<div className="pf-app"><ExtensionRecovery platform={s.platform} id={s.release.manifest.id} requiredDataVersion={2} /></div>);
  expect(screen.queryByRole('button', { name: 'Install Cut List' })).toBeNull();
  await s.publish('2.0.0', ['model.read'], 2); await act(async () => s.registry.refresh());
  fireEvent.click(screen.getByRole('button', { name: 'Install Cut List' }));
  const dialog = await screen.findByRole('dialog', { name: 'Install Cut List?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText(/Manage extensions/i)).toBeNull(); expect(s.platform.list()).toEqual([]);
  view.unmount(); expect(s.startRuntime).not.toHaveBeenCalled();
});

it('keeps signed caches account-bound, endpoint-bound and atomic across two browser handles', async () => {
  const owner = `registry-test-${crypto.randomUUID()}`;
  const first = indexedDbDistributionCache(owner, 'a'), second = indexedDbDistributionCache(owner, 'a');
  const one = new Uint8Array([1]), two = new Uint8Array([2]), three = new Uint8Array([3]);
  expect(await first.write('revocations', one, null)).toBe(true);
  expect(await second.write('revocations', two, one)).toBe(true);
  expect(await first.write('revocations', three, one)).toBe(false);
  expect(Array.from((await first.read('revocations'))!)).toEqual([2]);
  expect(await indexedDbDistributionCache(owner, 'b').read('revocations')).toBeNull();
  expect(await indexedDbDistributionCache(`${owner}-other`, 'a').read('revocations')).toBeNull();
});
