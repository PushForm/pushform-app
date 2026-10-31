// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Hostile extensions in the real web runtime: every attempt to reach the network, the editor's storage, dynamic code,
// code outside the package, nested workers or navigation must fail, and nothing may reach any server.
import { expect, test, type Page } from '@playwright/test';
import { DYNAMIC_CODE, NAVIGATION, NESTED_WORKERS, NETWORK, OUTSIDE_MODULES, STORAGE } from './attacks';
import {
  allHits, editorOrigin, expectBlocked, hitsFor, hostilePackage, openHarness, remoteOrigin, stunAddress, tagFor,
  type Attack, type Attempts,
} from './support';

const SECRET = 'pf-editor-secret-7d1c';

test('the app offers extensions in this browser, which this suite covers', async ({ page, browser }) => {
  test.info().annotations.push({ type: 'engine', description: `${browser.browserType().name()} ${browser.version()}` });
  const { browserRunsExtensions } = await import('../../../packages/ui/src/extensions/browserRunsExtensions.ts');
  expect(browserRunsExtensions(await page.evaluate(() => navigator.userAgent))).toBe(true);
});

interface Category {
  readonly name: string;
  readonly attacks: Readonly<Record<string, Attack>>;
  readonly wasm?: boolean;
  readonly files?: Record<string, string>;
}

/** Runs a category's hostile package once, then asserts each attack on its own. */
function category({ name, attacks, wasm, files }: Category, extra: (page: Page) => Promise<Record<string, unknown>> = async () => ({})): void {
  test.describe(name, () => {
    let page: Page;
    let attempts: Attempts;
    let tag: string;
    let run: { started: boolean; ok?: boolean; framesAfterStop?: number; invalidMessages?: number; error?: unknown };
    let datagrams = 0;

    test.beforeAll(async ({ browser }, info) => {
      tag = tagFor(info, name);
      page = await openHarness(browser, info);
      await page.evaluate((secret) => window.isolation.seedEditorSecrets(secret), SECRET);
      const params = { editor: editorOrigin(info), remote: remoteOrigin(), stun: stunAddress(), tag, ...(await extra(page)) };
      const spec = hostilePackage(`com.example.hostile-${name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`, attacks, { ...(wasm ? { wasm } : {}), ...(files ? { files } : {}) });
      const before = (await hitsFor('udp')).length;
      const outcome = await page.evaluate(({ spec, params }) => window.isolation.run(spec, 'run', params), { spec, params });
      datagrams = (await hitsFor('udp')).length - before;
      run = outcome;
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ started: true, ok: true });
      attempts = (outcome as unknown as { value: Attempts }).value;
    });
    test.afterAll(async () => { await page?.close(); });

    for (const [key, attack] of Object.entries(attacks)) test(`refuses: ${attack.title}`, () => expectBlocked(attempts, key));

    test('nothing reached any server, and the runtime is gone after stopping', async () => {
      await new Promise((r) => setTimeout(r, 300));
      expect(await hitsFor(tag)).toEqual([]);
      expect(datagrams).toBe(0);
      expect(run.framesAfterStop).toBe(0);
    });
  });
}

category({ name: 'Network', attacks: NETWORK });


category({ name: 'Editor storage and cookies', attacks: STORAGE });

test('Editor storage and cookies: no attempt saw an editor secret', async ({ browser }, info) => {
  const page = await openHarness(browser, info);
  await page.evaluate((secret) => window.isolation.seedEditorSecrets(secret), SECRET);
  const outcome = await page.evaluate((spec) => window.isolation.run(spec), hostilePackage('com.example.hostile-storage-scan', STORAGE));
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  await page.close();
});

const withEditorBlob = async (page: Page) => ({ editorBlob: await page.evaluate(() => window.isolation.editorBlobUrl()) });
category({ name: 'Dynamic code', attacks: DYNAMIC_CODE }, withEditorBlob);
category({ name: 'Dynamic code in a package that declares WebAssembly', attacks: DYNAMIC_CODE, wasm: true }, withEditorBlob);

category({ name: 'Modules outside the package', attacks: OUTSIDE_MODULES, files: { 'extra.js': 'self.__extra = true; export default 1;' } });

test.describe('Modules outside the package, at load', () => {
  const entries: Record<string, (remote: string, tag: string) => Record<string, string>> = {
    'a static import from another origin': (remote, tag) => ({ 'main.js': `import x from '${remote}/x/${tag}/static.js'; export function activate() {}` }),
    'a bare specifier': () => ({ 'main.js': `import React from 'react'; export function activate() {}` }),
    'a path leaving the package': () => ({ 'main.js': `import x from '../outside.js'; export function activate() {}` }),
    'an absolute path on the editor origin': () => ({ 'main.js': `import x from '/harness.js'; export function activate() {}` }),
    'a JSON module': () => ({ 'main.js': `import data from './data.json' with { type: 'json' }; export function activate() {}`, 'data.json': '{}' }),
  };
  for (const [title, files] of Object.entries(entries)) {
    test(`refuses to load: ${title}`, async ({ browser }, info) => {
      const tag = tagFor(info, `load-${title}`);
      const page = await openHarness(browser, info);
      const outcome = await page.evaluate((spec) => window.isolation.run(spec), { id: 'com.example.hostile-load', files: files(remoteOrigin(), tag) });
      expect(outcome).toMatchObject({ started: true, ok: false, failures: ['load-failed'], framesAfterStop: 0 });
      test.info().annotations.push({ type: 'refusal', description: JSON.stringify((outcome as { error?: unknown }).error) });
      expect(await hitsFor(tag)).toEqual([]);
      await page.close();
    });
  }
});

category({ name: 'Nested workers', attacks: NESTED_WORKERS });

test.describe('Navigation', () => {
  let page: Page;
  let attempts: Attempts;
  let tag: string;
  test.beforeAll(async ({ browser }, info) => {
    tag = tagFor(info, 'navigation');
    page = await openHarness(browser, info);
    const outcome = await page.evaluate((args) => window.isolation.run(args.spec, 'run', args.params),
      { spec: hostilePackage('com.example.hostile-navigation', NAVIGATION), params: { editor: editorOrigin(info), remote: remoteOrigin(), tag } });
    attempts = (outcome as unknown as { value: Attempts }).value;
  });
  test.afterAll(async () => { await page?.close(); });
  for (const [key, attack] of Object.entries(NAVIGATION)) test(`refuses: ${attack.title}`, () => expectBlocked(attempts, key));
  test('the editor stayed where it was, no window opened and nothing reached a server', async () => {
    const info = test.info();
    expect(page.url()).toBe(`${editorOrigin(info)}/`);
    expect(page.context().pages()).toHaveLength(1);
    expect(await hitsFor(tag)).toEqual([]);
  });
});

test.describe('The runtime frame itself (defense in depth)', () => {
  // No extension code runs in the frame's document; this checks the second wall, the frame's sandbox and policy.
  let page: Page;
  let probe: { sandbox: string; policy: string; results: Attempts };
  let tag: string;
  const dialogs: string[] = [];
  test.beforeAll(async ({ browser }, info) => {
    tag = tagFor(info, 'frame-layer');
    page = await openHarness(browser, info);
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.evaluate((secret) => window.isolation.seedEditorSecrets(secret), SECRET);
    probe = await page.evaluate((params) => window.isolation.frameProbe(params), { remote: remoteOrigin(), tag, stun: stunAddress() }) as typeof probe;
  });
  test.afterAll(async () => { await page?.close(); });

  test('has only allow-scripts and a policy without network, images, forms or base URLs', () => {
    expect(probe.sandbox).toBe('allow-scripts');
    expect(probe.policy).toMatch(/default-src 'none'/);
    expect(probe.policy).toMatch(/connect-src 'none'/);
    expect(probe.policy).toMatch(/form-action 'none'/);
  });
  const refused = ['fetch', 'image', 'script', 'stylesheet', 'prefetch', 'windowOpen', 'topNavigation', 'fullscreen', 'localStorage', 'sessionStorage', 'cookie', 'indexedDB', 'caches', 'parentDocument', 'parentStorage'];
  for (const key of refused) test(`refuses: ${key}`, () => expectBlocked(probe.results, key));
  test('cannot show a modal dialog over the editor', () => {
    test.info().annotations.push({ type: 'result', description: probe.results.modalDialog?.detail ?? '' });
    expect(dialogs).toEqual([]);
  });
  test('the editor stayed where it was, no window opened, and no secret was read', async () => {
    const info = test.info();
    expect(page.url()).toBe(`${editorOrigin(info)}/`);
    expect(page.context().pages()).toHaveLength(1);
    expect(JSON.stringify(probe.results)).not.toContain(SECRET);
  });
  test('a nested frame, a form and a link aimed at the top window went nowhere', async () => {
    const info = test.info();
    // These calls return normally; what matters is that nothing was loaded or navigated.
    const hits = (await hitsFor(tag)).map((h) => h.url.split('/').pop());
    for (const name of ['frame-iframe', 'frame-form-top', 'frame-anchor-top']) expect(hits).not.toContain(name);
    expect(page.url()).toBe(`${editorOrigin(info)}/`);
  });
  test('nothing else reached a server; what the frame document can still send is recorded', async () => {
    const info = test.info();
    // Two routes are outside the frame's own policy: navigating the frame itself, which only the editor's policy
    // (frame-src) governs, and WebRTC, which no content security policy governs. Neither is reachable from extension
    // code, which runs in the frame's worker; they are recorded here, see README.md.
    const hits = await hitsFor(tag);
    const selfNavigation = hits.filter((h) => h.url.endsWith('/frame-self-navigation'));
    const datagrams = await hitsFor('udp');
    test.info().annotations.push({ type: 'frame self-navigation', description: `${selfNavigation.length} request(s)` },
      { type: 'frame WebRTC', description: `${probe.results.webrtc?.outcome}: ${probe.results.webrtc?.detail}; ${datagrams.length} datagram(s) reached the STUN socket` });
    expect(hits.filter((h) => !h.url.endsWith('/frame-self-navigation'))).toEqual([]);
    if (info.project.metadata.editor === 'enforced') expect(selfNavigation).toEqual([]);
  });
});

test('No request reached the editor server from any attack in this file', async () => {
  // Every request the runtime attacks made, with or without a tag, is in this list; the harness itself is excluded.
  const hits = (await allHits()).filter((h) => h.server === 'editor');
  expect(hits.filter((h) => !h.url.endsWith('/frame-self-navigation'))).toEqual([]);
});
