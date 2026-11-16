// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionManifestSchema, type ExtensionManifest } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceCall, type ServiceImplementations, type SessionFailure } from './host';
import { messagePortTransport, type RuntimePort } from './port';

/**
 * A compromised runtime talking to the host directly: forged message types, out-of-place lifecycle messages, claimed
 * identities and grants it does not have. The host must drop or refuse each one without effect, and a runtime that
 * floods the host is failed and disconnected. (Size limits, pending-request limits, document handles and generations
 * are covered in broker.test.ts.)
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
  it('fails and disconnects a runtime that floods the host with well-formed messages', async () => {
    const { session, failures, raw } = connect({ activate() {} });
    await session.activate();
    for (let n = 0; n < 100_000; n++) raw({ type: 'pong', n });
    await vi.waitFor(() => expect(failures.map((f) => f.kind)).toEqual(['protocol-violation']), { timeout: 3000 });
    expect(failures[0]!.error).toMatchObject({ code: 'extension.failed', details: { limit: 'message-rate.messages' } });
    expect(session.state).toBe('failed');
  });

  it('counts the measured bytes too', async () => {
    const { session, failures, raw } = connect({ activate() {} }, {}, ['settings'], { messageBytesBurst: 1024 * 1024, messageBytesPerSecond: 1024 });
    await session.activate();
    // Results for invocations the host never made: well-formed, dropped, but each one is still paid for.
    for (let n = 0; n < 5; n++) raw({ type: 'result', invocation: 1000 + n, ok: true, value: 'x'.repeat(128 * 1024) });
    await vi.waitFor(() => expect(failures).toMatchObject([{ kind: 'protocol-violation', error: { details: { limit: 'message-rate.bytes' } } }]));
  });

  it('counts invalid messages against the rate as well as the invalid-message limit', async () => {
    const { session, failures, raw } = connect({ activate() {} }, {}, ['settings'], { messageBurst: 20, messagesPerSecond: 1, maxInvalidMessages: 1000 });
    await session.activate();
    for (let n = 0; n < 30; n++) raw({ type: 'garbage', n });
    await vi.waitFor(() => expect(failures).toMatchObject([{ kind: 'protocol-violation', error: { details: { limit: 'message-rate.messages' } } }]));
  });

  it('lets a runtime that stays within the rate keep running', async () => {
    const { session, failures, raw } = connect({ activate() {} }, {}, ['settings'], { messageBurst: 100, messagesPerSecond: 1000 });
    await session.activate();
    for (let round = 0; round < 5; round++) {
      for (let n = 0; n < 60; n++) raw({ type: 'pong', n });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failures).toEqual([]);
    expect(session.state).toBe('active');
  });

  it('paces an extension calling the host in a tight loop, so it slows down instead of failing', async () => {
    let calls = 0;
    const write = vi.fn(() => { calls++; return null; });
    const { session, failures } = connect({
      activate(c: ExtensionContext) {
        c.commands.register('com.example.spoof.run', async () => {
          const log = c.log as { write(entry: unknown): Promise<unknown> };
          const until = performance.now() + 1500;
          const loop = async () => { while (performance.now() < until) await log.write('busy'); };
          await Promise.all(Array.from({ length: 16 }, loop));
          return 'done';
        });
      },
    }, { 'log.write': write });
    await expect(session.invoke('com.example.spoof.run', {})).resolves.toBe('done');
    expect(failures).toEqual([]);
    expect(session.state).toBe('active');
    // The burst plus the paced rate for the run, with room for timer slack.
    expect(calls).toBeGreaterThan(5000);
    expect(calls).toBeLessThan(1000 + 5000 * 2);
  });

  it('never sends a paced call that was cancelled while it waited', async () => {
    const write = vi.fn((_entry: unknown) => null);
    const { session, failures } = connect({
      activate(c: ExtensionContext) {
        c.commands.register('com.example.spoof.run', async () => {
          const log = c.log as { write(entry: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
          // More calls than the pacing burst, so the next one has to wait its turn.
          const burst = Array.from({ length: 3000 }, () => log.write('burst'));
          const controller = new AbortController();
          const late = log.write('late', { signal: controller.signal });
          controller.abort();
          const outcome = await late.then(() => 'sent', (e: { code?: string }) => e.code);
          await Promise.all(burst);
          await log.write('after');
          return outcome;
        });
      },
    }, { 'log.write': write });
    await expect(session.invoke('com.example.spoof.run', {})).resolves.toBe('cancelled');
    expect(write.mock.calls.map(([entry]) => entry)).not.toContain('late');
    expect(write).toHaveBeenCalledTimes(3001);
    expect(failures).toEqual([]);
  });
});

describe('message backlog', () => {
  /** A port the test drives by hand: what the host posts is recorded, and messages are delivered when the test says. */
  function manual(limits = {}) {
    const posted: Record<string, unknown>[] = [];
    let handler: (message: unknown) => void = () => {};
    let closed = false;
    const port: RuntimePort = { post: (m) => posted.push(m as Record<string, unknown>), listen: (h) => { handler = h; return () => { handler = () => {}; }; }, close: () => { closed = true; } };
    const failures: SessionFailure[] = [];
    const session = new ExtensionSession({ manifest, grants: [], port, limits: { backlogProbeMessages: 10, backlogMs: 50, ...limits }, onFailure: (f) => failures.push(f) });
    const pings = () => posted.filter((m) => m.type === 'ping');
    return { session, failures, pings, deliver: (m: unknown) => handler(m), closed: () => closed };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('asks for a heartbeat after a run of messages, with a number that cannot be guessed', () => {
    const { pings, deliver } = manual();
    for (let n = 0; n < 10; n++) deliver({ type: 'pong', n });
    expect(pings()).toHaveLength(1);
    expect(pings()[0]!.n).not.toBeLessThan(10);
  });

  it('fails a runtime whose answer stays queued behind its own messages, and closes its port', async () => {
    const { failures, pings, deliver, closed } = manual();
    for (let n = 0; n < 10; n++) deliver({ type: 'pong', n });
    expect(pings()).toHaveLength(1);
    await wait(60);
    for (let n = 0; n < 10; n++) deliver({ type: 'pong', n });
    expect(failures).toMatchObject([{ kind: 'protocol-violation', error: { details: { limit: 'message-rate.backlog' } } }]);
    expect(closed()).toBe(true);
  });

  it('keeps a runtime that answers in time, and asks again after the next run', async () => {
    const { failures, pings, deliver } = manual();
    for (let n = 0; n < 10; n++) deliver({ type: 'pong', n });
    deliver({ type: 'pong', n: pings()[0]!.n });
    await wait(60);
    for (let n = 0; n < 9; n++) deliver({ type: 'pong', n });
    expect(pings()).toHaveLength(1);
    deliver({ type: 'pong', n: 9 });
    expect(pings()).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('tolerates a slow answer while few messages arrive, as from a runtime busy with its own work', async () => {
    const { failures, deliver } = manual();
    for (let n = 0; n < 10; n++) deliver({ type: 'pong', n });
    await wait(60);
    for (let n = 0; n < 5; n++) deliver({ type: 'pong', n });
    expect(failures).toEqual([]);
  });
});
