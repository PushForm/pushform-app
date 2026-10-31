// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionError, extensionManifestSchema, type ExtensionManifest, type ExtensionPermission } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceCall } from './host';
import { FETCH_LIMITS, FILE_LIMITS, FetchBroker, clipboardServices, fileServices, type FetchTransport, type FetchTransportRequest, type FilePicker } from './io';
import { messagePortTransport } from './port';
import { ExtensionUiHost } from './ui';

const manifest = (overrides: Record<string, unknown> = {}): ExtensionManifest => extensionManifestSchema.parse({
  id: 'com.example.prices', name: 'Lumber Prices', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', files: {}, permissions: ['network', 'model.egress', 'file.read', 'file.export', 'clipboard.write'],
  contributions: [{ target: 'model.panel', id: 'com.example.prices.panel', name: 'Prices' }, { target: 'model.command', id: 'com.example.prices.copy', name: 'Copy' }],
  destinations: [
    { url: 'https://api.example.com/v1', purpose: 'Price lookup', sendsModelData: false },
    { url: 'https://upload.example.com/', purpose: 'Share a cut list', sendsModelData: true },
  ],
  ...overrides,
});

const call = (overrides: Partial<ServiceCall> = {}): ServiceCall => ({
  signal: new AbortController().signal, extensionId: 'com.example.prices', generation: 1,
  document: () => { throw new Error('no documents'); }, progress: () => {}, userActivated: () => true, ...overrides,
});
const failure = async (promise: unknown): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('FetchBroker', () => {
  const grants = (...g: ExtensionPermission[]) => new Set<ExtensionPermission>(g);
  const ok = (body = 'ok', headers: Record<string, string> = {}) => ({ status: 200, headers, body: new TextEncoder().encode(body) });

  it('allows only granted https destinations declared in the manifest, under their path', () => {
    const broker = new FetchBroker(manifest(), grants('network', 'model.egress'), null);
    expect(broker.check('https://api.example.com/v1/prices?sku=2x4').href).toBe('https://api.example.com/v1/prices?sku=2x4');
    expect(broker.check('https://api.example.com/v1').pathname).toBe('/v1');
    for (const url of ['http://api.example.com/v1/x', 'https://api.example.com/v10/x', 'https://api.example.com/admin', 'https://evil.example.com/v1',
      'https://user:pw@api.example.com/v1/x', 'https://api.example.com.evil.net/v1/x'])
      expect(() => broker.check(url), url).toThrow(ExtensionError);
  });

  it('needs the network grant, and the model-egress grant for destinations that receive model data', () => {
    expect(() => new FetchBroker(manifest(), grants(), null).check('https://api.example.com/v1/x')).toThrow(/Network access was not granted/);
    expect(() => new FetchBroker(manifest(), grants('network'), null).check('https://upload.example.com/lists')).toThrow(/model data/);
    expect(new FetchBroker(manifest(), grants('network', 'model.egress'), null).check('https://upload.example.com/lists').host).toBe('upload.example.com');
  });

  it('answers unavailable where no transport exists, after the policy checks', async () => {
    const fetch = new FetchBroker(manifest(), grants('network'), null).services()['http.fetch']!;
    expect((await failure(fetch({ url: 'https://evil.example.com/' }, call()))).code).toBe('permission.denied');
    expect((await failure(fetch({ url: 'https://api.example.com/v1/x' }, call()))).code).toBe('unavailable');
  });

  it('refuses host-only headers and oversized bodies, and strips response headers such as cookies', async () => {
    const seen: FetchTransportRequest[] = [];
    const transport: FetchTransport = async (r) => { seen.push(r); return ok('{"price":4.2}', { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b', 'X-Internal': '1' }); };
    const broker = new FetchBroker(manifest(), grants('network'), transport);
    const fetch = broker.services()['http.fetch']!;
    for (const header of ['Cookie', 'Host', 'Origin', 'Sec-Fetch-Mode', 'Proxy-Authorization'])
      expect((await failure(fetch({ url: 'https://api.example.com/v1/x', headers: { [header]: 'x' } }, call()))).code, header).toBe('permission.denied');
    expect((await failure(fetch({ url: 'https://api.example.com/v1/x', method: 'POST', body: 'x'.repeat(FETCH_LIMITS.requestBytes + 1) }, call()))).code).toBe('limit.exceeded');
    const response = await fetch({ url: 'https://api.example.com/v1/x', method: 'post', headers: { Authorization: 'Bearer own-key' }, body: '{}' }, call()) as Record<string, unknown>;
    expect(response).toMatchObject({ status: 200, headers: { 'content-type': 'application/json' } });
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe('{"price":4.2}');
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer own-key' }, maxResponseBytes: FETCH_LIMITS.responseBytes });
    expect(broker.bytesSent.get('https://api.example.com')).toBe(2);
  });

  it('follows redirects itself, checking every location, and switches to GET after 303', async () => {
    const hops: string[] = [];
    const redirecting = (to: string, status = 302): FetchTransport => async (r) => {
      hops.push(`${r.method} ${r.url}`);
      return r.url.endsWith('/start') ? { status, headers: { location: to }, body: new Uint8Array() } : ok();
    };
    const fetch = (t: FetchTransport) => new FetchBroker(manifest(), grants('network'), t).services()['http.fetch']!;
    expect(await fetch(redirecting('/v1/end', 303))({ url: 'https://api.example.com/v1/start', method: 'POST', body: 'x' }, call())).toMatchObject({ url: 'https://api.example.com/v1/end' });
    expect(hops).toEqual(['POST https://api.example.com/v1/start', 'GET https://api.example.com/v1/end']);
    expect((await failure(fetch(redirecting('https://evil.example.com/steal'))({ url: 'https://api.example.com/v1/start' }, call()))).code).toBe('permission.denied');
    expect((await failure(fetch(redirecting('http://api.example.com/v1/end'))({ url: 'https://api.example.com/v1/start' }, call()))).code).toBe('permission.denied');
    const loop: FetchTransport = async () => ({ status: 302, headers: { location: '/v1/again' }, body: new Uint8Array() });
    expect((await failure(fetch(loop)({ url: 'https://api.example.com/v1/start' }, call()))).message).toMatch(/Too many redirects/);
  });

  it('refuses truncated responses, limits the rate, and cancels with the call', async () => {
    const truncated: FetchTransport = async () => ({ status: 200, headers: {}, body: new Uint8Array(10), truncated: true });
    expect((await failure(new FetchBroker(manifest(), grants('network'), truncated).services()['http.fetch']!({ url: 'https://api.example.com/v1/x' }, call()))).code).toBe('limit.exceeded');
    const fast = new FetchBroker(manifest(), grants('network'), async () => ok()).services()['http.fetch']!;
    for (let i = 0; i < FETCH_LIMITS.perMinute; i++) await fast({ url: 'https://api.example.com/v1/x' }, call());
    expect((await failure(fast({ url: 'https://api.example.com/v1/x' }, call()))).message).toMatch(/requests a minute/);
    const controller = new AbortController();
    const hanging: FetchTransport = (r) => new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const running = new FetchBroker(manifest(), grants('network'), hanging).services()['http.fetch']!({ url: 'https://api.example.com/v1/x' }, call({ signal: controller.signal }));
    controller.abort();
    expect((await failure(running)).code).toBe('cancelled');
  });
});

describe('files', () => {
  const picker = (overrides: Partial<FilePicker> = {}): FilePicker & { requests: unknown[] } => {
    const requests: unknown[] = [];
    return {
      requests,
      open: async (r) => { requests.push(r); return { name: 'parts.csv', type: 'text/csv', data: new TextEncoder().encode('a,b') }; },
      save: async (r, data) => { requests.push({ ...r, bytes: data.byteLength }); return { name: r.suggestedName ?? 'export' }; },
      ...overrides,
    };
  };

  it('opens one file the user chose, after a prompt naming the extension, never giving a path', async () => {
    const p = picker();
    const files = fileServices(manifest(), p);
    const out = await files['files.open']!({ purpose: 'Import a parts list', accept: [{ description: 'CSV', extensions: ['csv'] }] }, call());
    expect(out).toEqual({ name: 'parts.csv', type: 'text/csv', data: new TextEncoder().encode('a,b') });
    expect(p.requests[0]).toEqual({ extensionName: 'Lumber Prices', kind: 'open', purpose: 'Import a parts list', accept: [{ description: 'CSV', extensions: ['csv'] }] });
  });

  it('saves text or bytes where the user chose, and reports declining as cancelled', async () => {
    const p = picker();
    const files = fileServices(manifest(), p);
    expect(await files['files.save']!({ purpose: 'Export the cut list', suggestedName: 'cut-list.csv', accept: [], data: 'a,b\n' }, call())).toEqual({ name: 'cut-list.csv' });
    expect(p.requests[0]).toMatchObject({ kind: 'save', bytes: 4 });
    const declining = fileServices(manifest(), picker({ open: async () => null, save: async () => null }));
    expect((await failure(declining['files.open']!({ purpose: 'Import' }, call()))).code).toBe('cancelled');
    expect((await failure(declining['files.save']!({ purpose: 'Export', data: 'x' }, call()))).code).toBe('cancelled');
  });

  it('needs a purpose, valid file types and names, and bounds file size', async () => {
    const files = fileServices(manifest(), picker({ open: async () => ({ name: 'big', type: '', data: new Uint8Array(FILE_LIMITS.bytes + 1) }) }));
    expect((await failure(files['files.open']!({}, call()))).message).toMatch(/purpose/);
    expect((await failure(files['files.open']!({ purpose: 'x', accept: [{ description: 'CSV', extensions: ['.csv'] }] }, call()))).code).toBe('validation.failed');
    expect((await failure(files['files.save']!({ purpose: 'x', suggestedName: '../etc/passwd', data: 'x' }, call()))).code).toBe('validation.failed');
    expect((await failure(files['files.open']!({ purpose: 'x' }, call()))).code).toBe('limit.exceeded');
  });
});

describe('clipboard', () => {
  const channels: MessageChannel[] = [];
  afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

  it('writes only soon after the user acted on the extension', async () => {
    const written: unknown[] = [];
    const channel = new MessageChannel();
    channels.push(channel);
    const m = manifest();
    const ref: { session?: ExtensionSession } = {};
    const ui = new ExtensionUiHost(m, (e) => ref.session?.postEvent(e));
    const session = ref.session = new ExtensionSession({ manifest: m, grants: m.permissions, port: messagePortTransport(channel.port1),
      services: { ...ui.services(), ...clipboardServices({ write: async (items) => { written.push(items); } }) } });
    const outcomes: string[] = [];
    void startGuest(messagePortTransport(channel.port2), async () => ({
      async activate(context: ExtensionContext) {
        const clipboard = context.clipboard as { write(i: unknown): Promise<unknown> };
        const uiApi = context.ui as { mount(i: unknown): Promise<unknown>; onEvent(h: (e: { component: string }) => void): void };
        const attempt = () => clipboard.write({ text: 'A 720 x 400' }).then(() => 'written', (e: ExtensionError) => e.code);
        outcomes.push(await attempt());
        await uiApi.mount({ target: 'com.example.prices.panel', seq: 1, tree: { type: 'button', id: 'copy', label: 'Copy' } });
        uiApi.onEvent(() => { void attempt().then((o) => outcomes.push(o)); });
        context.commands.register('com.example.prices.copy', attempt);
      },
    }));
    await session.activate();
    expect(outcomes).toEqual(['permission.denied']);
    ui.dispatch('com.example.prices.panel', { component: 'copy', event: 'press' });
    await vi.waitFor(() => expect(outcomes).toEqual(['permission.denied', 'written']));
    expect(await session.invoke('com.example.prices.copy', {}, { userAction: true })).toBe('written');
    expect(written).toEqual([{ text: 'A 720 x 400' }, { text: 'A 720 x 400' }]);
  });

  it('accepts text, html and PNG images only', async () => {
    const write = clipboardServices({ write: async () => {} })['clipboard.write']!;
    expect((await failure(write({}, call()))).code).toBe('validation.failed');
    expect((await failure(write({ png: new Uint8Array([1, 2, 3]) }, call()))).code).toBe('validation.failed');
    await expect(write({ text: 'x', html: '<b>x</b>', png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) }, call())).resolves.toBeNull();
    expect((await failure(write({ text: 'x' }, call({ userActivated: () => false })))).code).toBe('permission.denied');
  });
});
