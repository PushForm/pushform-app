// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionManifestSchema, type ExtensionManifest } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceCall, type ServiceImplementations, type SessionFailure } from './host';
import { messagePortTransport } from './port';

/**
 * A compromised runtime talking to the host directly: forged message types, out-of-place lifecycle messages, claimed
 * identities and grants it does not have. The host must drop or refuse each one without effect. (Size limits,
 * pending-request limits, document handles and generations are covered in broker.test.ts.)
 */

const manifest: ExtensionManifest = extensionManifestSchema.parse({
  id: 'com.example.spoof', name: 'Spoof', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0',
  editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions: ['settings'],
  contributions: [{ target: 'model.command', id: 'com.example.spoof.run', name: 'Run' }],
});

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

function connect(module: unknown, services: ServiceImplementations = {}, grants: string[] = ['settings'], limits = {}) {
  const channel = new MessageChannel();
  channels.push(channel);
  const failures: SessionFailure[] = [];
  const session = new ExtensionSession({ manifest, grants: grants as never, port: messagePortTransport(channel.port1), services, limits, onFailure: (f) => failures.push(f) });
  void startGuest(messagePortTransport(channel.port2), async () => module);
  const replies: Record<string, unknown>[] = [];
  channel.port2.addEventListener('message', (e) => { if ((e.data as { type?: string })?.type === 'response') replies.push(e.data as Record<string, unknown>); });
  const raw = (message: unknown) => channel.port2.postMessage(message);
  return { session, failures, raw, replies };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('forged messages', () => {
  it('drops and counts host-only message types and other protocol versions, without acting on them', async () => {
    const run = vi.fn(() => 'ran');
    const { session, raw } = connect({ activate(c: ExtensionContext) { c.commands.register('com.example.spoof.run', run); } });
    await session.activate();
    for (const forged of [
      { type: 'invoke', invocation: 1, contribution: 'com.example.spoof.run', params: {} },
      { type: 'activate', v: 1, extensionId: 'com.example.other', grants: ['network'], wasm: true, contributions: [] },
      { type: 'response', id: 1, ok: true, result: 'x' },
      { type: 'deactivate', reason: 'disable' },
      { type: 'ping', n: 1 },
      { type: 'ready', v: 999 },
    ]) raw(forged);
    await tick();
    expect(session.invalidMessages).toBe(6);
    expect(run).not.toHaveBeenCalled();
    expect(session.state).toBe('active');
  });

  it('refuses unknown fields, so a message cannot carry an identity or grant of its own', async () => {
    const get = vi.fn(() => ({}));
    const { session, raw, replies } = connect({ activate() {} }, { 'settings.get': get });
    await session.activate();
    raw({ type: 'request', id: 7, service: 'settings', method: 'get', input: null, extensionId: 'com.example.other' });
    raw({ type: 'request', id: 8, service: 'settings', method: 'get', input: null, grants: ['network'] });
    raw({ type: 'pong', n: 1, generation: 0 });
    await tick();
    expect(session.invalidMessages).toBe(3);
    expect(get).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it('ignores lifecycle messages that arrive out of place', async () => {
    let resolveRun: (v: unknown) => void = () => {};
    const { session, raw } = connect({ activate(c: ExtensionContext) { c.commands.register('com.example.spoof.run', () => new Promise((r) => { resolveRun = r; })); } });
    raw({ type: 'activated' }); // before the host asked it to activate
    await tick();
    expect(session.state).toBe('loaded');
    const running = session.invoke('com.example.spoof.run', {});
    await vi.waitFor(() => expect(session.state).toBe('active'));
    raw({ type: 'result', invocation: 999, ok: true, value: 'forged' }); // an invocation the host never made
    raw({ type: 'activation-failed', error: { code: 'extension.failed', message: 'forged' } }); // already active
    raw({ type: 'load-failed', error: { code: 'extension.failed', message: 'forged' } }); // already loaded
    raw({ type: 'deactivated' }); // the host did not ask it to stop
    await tick();
    expect(session.state).toBe('active');
    expect(session.invalidMessages).toBe(0);
    resolveRun('genuine');
    await expect(running).resolves.toBe('genuine');
  });
});

describe('identity and grants', () => {
  it('tells services the identity the host assigned, whatever the request says', async () => {
    const seen: Pick<ServiceCall, 'extensionId' | 'generation'>[] = [];
    const { session, raw, replies } = connect({ activate() {} }, { 'settings.get': (_input, call) => { seen.push({ extensionId: call.extensionId, generation: call.generation }); return null; } });
    await session.activate();
    raw({ type: 'request', id: 1, service: 'settings', method: 'get', input: { extensionId: 'com.example.other', generation: 0, user: 'someone-else' } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(seen).toEqual([{ extensionId: 'com.example.spoof', generation: session.generation }]);
  });

  it('ignores a grant the manifest did not request, so it can never be used', async () => {
    const write = vi.fn();
    const { session, raw, replies } = connect({ activate() {} }, { 'clipboard.write': write }, ['settings', 'clipboard.write', 'network']);
    expect([...session.grants]).toEqual(['settings']);
    await session.activate();
    raw({ type: 'request', id: 1, service: 'clipboard', method: 'write', input: { text: 'x' } });
    raw({ type: 'request', id: 2, service: 'http', method: 'fetch', input: { url: 'https://example.com/' } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.map((r) => (r.error as { code: string }).code)).toEqual(['permission.denied', 'permission.denied']);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses service names and methods that only look like real ones', async () => {
    const { session, raw, replies } = connect({ activate() {} }, { 'settings.get': () => null });
    await session.activate();
    for (const [id, service, method] of [[1, 'settings', 'constructor'], [2, '__proto__', 'get'], [3, 'settings', 'hasOwnProperty'], [4, 'Settings', 'get']] as const)
      raw({ type: 'request', id, service, method, input: null });
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect(replies.map((r) => (r.error as { code: string }).code)).toEqual(['validation.failed', 'validation.failed', 'validation.failed', 'validation.failed']);
  });

  it('serves nothing before activation is under way', async () => {
    const get = vi.fn(() => null);
    const { session, raw, replies } = connect({ activate() {} }, { 'settings.get': get });
    await vi.waitFor(() => expect(session.state).toBe('loaded'));
    raw({ type: 'request', id: 1, service: 'settings', method: 'get', input: null });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect((replies[0]!.error as { code: string }).code).toBe('unavailable');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('message rate', () => {
  // Known gap, kept as an expected failure until it is fixed: the host caps invalid messages and concurrent requests,
  // but not the rate of well-formed ones, each of which it handles on the editor's thread.
  it.fails('fails a runtime that floods the host with well-formed messages', async () => {
    const { session, failures, raw } = connect({ activate() {} });
    await session.activate();
    for (let n = 0; n < 100_000; n++) raw({ type: 'pong', n });
    await vi.waitFor(() => expect(failures.map((f) => f.kind)).toEqual(['protocol-violation']), { timeout: 3000 });
  });
});
