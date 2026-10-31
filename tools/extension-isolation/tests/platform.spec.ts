// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Two side-loaded extensions on the real platform, wired as the browser app wires it (device-local store and
// settings, developer mode in localStorage), each in its own real runtime: neither can see the other's settings,
// interface, memory or messages; the side-load rules hold in the browser; and nothing is sent anywhere.
import { expect, test, type Page } from '@playwright/test';
import { allHits, openHarness } from './support';

const SECRET = 'alpha-private-3f9a';

const ALPHA = {
  id: 'com.example.alpha', permissions: ['settings'] as const, commands: ['plant'], panels: ['panel'],
  files: {
    'main.js': `export function activate(context) {
  context.commands.register('com.example.alpha.plant', async (params) => {
    await context.settings.set({ value: { secret: params.secret } });
    self.__secret = params.secret;
    const channel = new BroadcastChannel('extensions');
    setInterval(() => channel.postMessage({ secret: params.secret }), 20);
    await context.ui.mount({ target: 'com.example.alpha.panel', seq: 1, tree: { type: 'stack', id: 'root', children: [{ type: 'button', id: 'go', label: params.secret }] } });
    return { module: import.meta.url, settings: await context.settings.get() };
  });
}`,
  },
};

const BETA = {
  id: 'com.example.beta', permissions: ['settings'] as const, commands: ['snoop'], panels: ['panel'],
  files: {
    'main.js': `const attempt = async (f) => { try { return { outcome: 'allowed', detail: JSON.stringify(await f()) ?? 'undefined' }; } catch (e) { return { outcome: 'blocked', detail: String(e && e.name) + ': ' + String(e && (e.code || e.message)) }; } };
export function activate(context) {
  context.commands.register('com.example.beta.snoop', async (params) => ({
    settings: await context.settings.get(),
    global: typeof self.__secret,
    channel: await attempt(() => new Promise((resolve, reject) => { const c = new BroadcastChannel('extensions'); c.onmessage = (e) => resolve(e.data); setTimeout(() => { c.close(); reject(new Error('no message')); }, 500); })),
    mountAlphaPanel: await attempt(() => context.ui.mount({ target: 'com.example.alpha.panel', seq: 2, tree: { type: 'stack', id: 'root', children: [] } })),
    importAlphaModule: await attempt(() => import(params.alphaModule)),
    fetchAlphaModule: await attempt(() => fetch(params.alphaModule).then((r) => r.text())),
  }));
}`,
  },
};

test.describe('Cross-extension state', () => {
  let page: Page;
  let alpha: { ok: boolean; value?: { module: string; settings: Record<string, unknown> } };
  let beta: { ok: boolean; value?: Record<string, { outcome?: string; detail?: string } | unknown> };
  let hitsBefore: number;
  test.beforeAll(async ({ browser }, info) => {
    page = await openHarness(browser, info);
    hitsBefore = (await allHits()).length;
    await page.evaluate(() => { window.isolation.createPlatform('owner-1'); return window.isolation.setDeveloperMode(true); });
    await page.evaluate(({ a, b }) => Promise.all([window.isolation.install(a), window.isolation.install(b)]), { a: ALPHA, b: BETA });
    alpha = await page.evaluate((secret) => window.isolation.platformInvoke('com.example.alpha', 'plant', { secret }), SECRET) as typeof alpha;
    expect(alpha, JSON.stringify(alpha)).toMatchObject({ ok: true });
    beta = await page.evaluate((alphaModule) => window.isolation.platformInvoke('com.example.beta', 'snoop', { alphaModule }), alpha.value!.module) as typeof beta;
    expect(beta, JSON.stringify(beta)).toMatchObject({ ok: true });
  });
  test.afterAll(async () => {
    await page?.evaluate(() => window.isolation.platformStopAll());
    await page?.close();
  });

  test('the two run in separate runtimes', async () => {
    expect(await page.evaluate(() => window.isolation.frames())).toBe(2);
  });
  test('one cannot read the other\'s settings', () => {
    expect(alpha.value!.settings).toEqual({ secret: SECRET });
    expect(beta.value!.settings).toEqual({});
    expect(JSON.stringify(beta)).not.toContain(SECRET);
  });
  test('one cannot see the other\'s memory', () => {
    expect(beta.value!.global).toBe('undefined');
  });
  test('one cannot hear the other\'s BroadcastChannel', () => {
    expect(beta.value!.channel).toMatchObject({ outcome: 'blocked' });
  });
  test('one cannot mount its interface in the other\'s panel, and the other\'s panel is kept', async () => {
    expect(beta.value!.mountAlphaPanel).toMatchObject({ outcome: 'blocked', detail: 'ExtensionError: validation.failed' });
    expect(await page.evaluate(() => window.isolation.platformMounted('com.example.alpha', 'com.example.alpha.panel'))).toBe(true);
    expect(await page.evaluate(() => window.isolation.platformMounted('com.example.beta', 'com.example.alpha.panel'))).toBe(false);
  });
  test('one cannot load or read the other\'s modules', () => {
    expect(beta.value!.importAlphaModule).toMatchObject({ outcome: 'blocked' });
    expect(beta.value!.fetchAlphaModule).toMatchObject({ outcome: 'blocked' });
  });
  test('settings are kept per extension on this device', async () => {
    const keys = await page.evaluate(() => window.isolation.localStorageKeys());
    expect(keys).toContain('pushform:extension-settings:owner-1:com.example.alpha');
    expect(keys).not.toContain('pushform:extension-settings:owner-1:com.example.beta');
  });
  test('installing and running side-loaded extensions sent nothing anywhere', async () => {
    expect((await allHits()).length).toBe(hitsBefore);
  });
});

test.describe('Side-loading in the browser', () => {
  let page: Page;
  test.beforeAll(async ({ browser }, info) => {
    page = await openHarness(browser, info);
    await page.evaluate(() => window.isolation.createPlatform('owner-2'));
  });
  test.afterAll(async () => { await page?.close(); });

  test('needs developer mode', async () => {
    await page.evaluate(() => window.isolation.setDeveloperMode(false));
    expect(await page.evaluate((spec) => window.isolation.sideload(spec), ALPHA)).toMatchObject({ ok: false, error: { code: 'permission.denied' } });
    await page.evaluate(() => window.isolation.setDeveloperMode(true));
  });
  test('refuses the PushForm namespace', async () => {
    const spec = { ...ALPHA, id: 'io.pushform.cut-list', files: { 'main.js': 'export function activate() {}' } };
    expect(await page.evaluate((s) => window.isolation.sideload(s), spec)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });
  test('refuses a package claiming to be official with a signature that cannot be verified, rather than loading it unsigned', async () => {
    const signature = [...new TextEncoder().encode('{"keyId":"pushform-2026","signature":"AAAA"}')];
    expect(await page.evaluate(({ s, signature }) => window.isolation.sideload(s, { 'signature.json': signature }), { s: ALPHA, signature }))
      .toMatchObject({ ok: false, error: { details: { problem: 'signature.invalid' } } });
  });
  test('installs an unsigned package as unsigned, from developer mode', async () => {
    expect(await page.evaluate((spec) => window.isolation.install(spec), ALPHA)).toEqual({ id: 'com.example.alpha', integrity: 'unsigned', source: 'developer' });
  });
  test('turning developer mode off stops side-loaded extensions from running', async () => {
    await page.evaluate(() => window.isolation.setDeveloperMode(false));
    expect(await page.evaluate(() => window.isolation.platformInvoke('com.example.alpha', 'plant', { secret: 'x' }))).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await page.evaluate(() => window.isolation.frames())).toBe(0);
  });
});
