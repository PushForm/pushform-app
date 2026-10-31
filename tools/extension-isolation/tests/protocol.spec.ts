// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Message spoofing in the real runtime: an extension that takes hold of its own protocol port and posts forged,
// malformed, oversized and out-of-place messages; other windows forging the handshake; and an old runtime
// generation that keeps talking after its session stopped.
import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './support';

/**
 * The extension captures the protocol port from its own realm (by wrapping MessagePort.prototype.postMessage before
 * the runtime first posts on it), then talks to the host directly, bypassing its `context`.
 */
const CAPTURE = `
let port = null;
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (...args) { port = this; return post.apply(this, args); };
const send = (message) => post.call(port, message);
const ask = (message, ms = 1000) => new Promise((resolve) => {
  const timer = setTimeout(() => { port.removeEventListener('message', on); resolve('no answer'); }, ms);
  const on = (event) => {
    if (event.data && event.data.type === 'response' && event.data.id === message.id) {
      clearTimeout(timer);
      port.removeEventListener('message', on);
      resolve(event.data.ok ? { ok: true, result: event.data.result } : { ok: false, code: event.data.error.code });
    }
  };
  port.addEventListener('message', on);
  send(message);
});
let deep = 'bottom';
for (let i = 0; i < 100; i++) deep = { deeper: deep };
`;

const SPOOFER = {
  id: 'com.example.spoofer',
  permissions: ['settings', 'model.read'] as const,
  commands: ['spoof', 'flood', 'haunt', 'flood-valid', 'flood-sustained'],
  files: {
    'main.js': `${CAPTURE}
export function activate(context) {
  context.commands.register('com.example.spoofer.spoof', async (params, { document }) => {
    const r = {};
    r.ungranted = await ask({ type: 'request', id: 9001, service: 'clipboard', method: 'write', input: { text: 'x' } });
    r.unknownService = await ask({ type: 'request', id: 9002, service: 'shell', method: 'exec', input: {} });
    r.claimedIdentity = await ask({ type: 'request', id: 9003, service: 'settings', method: 'get', input: { extensionId: 'com.example.victim', user: 'someone-else' } });
    r.documentById = await ask({ type: 'request', id: 9004, service: 'model', method: 'read', input: { document: params.documentId } });
    r.ownHandle = await ask({ type: 'request', id: 9005, service: 'model', method: 'read', input: { document } });
    r.guessedHandle = await ask({ type: 'request', id: 9006, service: 'model', method: 'read', input: { document: 'doc_' + '0'.repeat(32) } });
    r.oversized = await ask({ type: 'request', id: 9007, service: 'log', method: 'write', input: 'x'.repeat(5 * 1024 * 1024) }, 5000);
    r.tooDeep = await ask({ type: 'request', id: 9008, service: 'log', method: 'write', input: deep });
    // Each of these is malformed or a host message type, so it is dropped and counted.
    for (const forged of [
      { type: 'response', id: 1, ok: true, result: 1 },
      { type: 'invoke', invocation: 1, contribution: 'com.example.spoofer.spoof', params: {} },
      { type: 'activate', v: 1, extensionId: 'com.example.victim', grants: ['network'], wasm: true, contributions: [] },
      { type: 'ready', v: 999 },
      { type: 'pong', n: 1, extensionId: 'com.example.victim' },
      { type: 'request', id: -1, service: 'log', method: 'write', input: 1 },
      'garbage', null, 42,
    ]) send(forged);
    // Well-formed but out of place: dropped without effect.
    send({ type: 'activated' });
    send({ type: 'result', invocation: 424242, ok: true, value: 'forged' });
    send({ type: 'deactivated' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return r;
  });
  context.commands.register('com.example.spoofer.flood', async () => { for (let i = 0; i < 80; i++) send({ type: 'garbage', i }); return 'sent'; });
  context.commands.register('com.example.spoofer.haunt', () => {
    let n = 50000;
    setInterval(() => send({ type: 'request', id: n++, service: 'log', method: 'write', input: 'still here' }), 5);
    return 'haunting';
  });
  context.commands.register('com.example.spoofer.flood-sustained', async (params) => {
    const until = Date.now() + params.ms;
    let bursts = 0;
    while (Date.now() < until) {
      for (let n = 0; n < params.burst; n++) send({ type: 'pong', n });
      bursts++;
      await new Promise((resolve) => setTimeout(resolve, params.pause));
    }
    return bursts;
  });
  context.commands.register('com.example.spoofer.flood-valid', async (params) => {
    const started = Date.now();
    for (let n = 0; n < params.count; n++) send({ type: 'pong', n });
    return Date.now() - started;
  });
}`,
  },
};

const GENUINE = { id: 'com.example.genuine', files: { 'main.js': `export function activate(c) { c.commands.register('com.example.genuine.run', () => 'genuine'); }` } };

test.describe('Message spoofing', () => {
  let page: Page;
  let handle: number;
  let result: Record<string, unknown>;
  let seen: { state: string; invalidMessages: number; calls: { service: string; extensionId: string; input: string }[] };
  test.beforeAll(async ({ browser }, info) => {
    page = await openHarness(browser, info);
    handle = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
    const outcome = await page.evaluate((h) => window.isolation.invoke(h, 'spoof', { documentId: 'doc-a' }, { document: 'doc-a' }), handle);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    result = (outcome as { value: Record<string, unknown> }).value;
    seen = await page.evaluate((h) => window.isolation.info(h), handle);
  });
  test.afterAll(async () => { await page?.close(); });

  test('a request for a service the extension was not granted is refused, and the service never runs', () => {
    expect(result.ungranted).toEqual({ ok: false, code: 'permission.denied' });
    expect(seen.calls.map((c) => c.service)).not.toContain('clipboard.write');
  });
  test('a request for a service that does not exist is refused', () => {
    expect(result.unknownService).toEqual({ ok: false, code: 'validation.failed' });
  });
  test('the host gives services the extension identity it assigned, whatever the request claims', () => {
    expect(result.claimedIdentity).toEqual({ ok: true, result: { owner: 'com.example.spoofer' } });
    expect(seen.calls.filter((c) => c.service === 'settings.get').map((c) => c.extensionId)).toEqual(['com.example.spoofer']);
  });
  test('a document can be reached only by the handle the host issued, never by its id or a guessed handle', () => {
    expect(result.ownHandle).toEqual({ ok: true, result: { document: 'doc-a' } });
    expect(result.documentById).toEqual({ ok: false, code: 'permission.denied' });
    expect(result.guessedHandle).toEqual({ ok: false, code: 'permission.denied' });
  });
  test('oversized and too deeply nested messages are answered limit.exceeded before any service sees them', () => {
    expect(result.oversized).toEqual({ ok: false, code: 'limit.exceeded' });
    expect(result.tooDeep).toEqual({ ok: false, code: 'limit.exceeded' });
    expect(seen.calls.map((c) => c.service)).not.toContain('log.write');
  });
  test('malformed and host-only messages are dropped and counted; out-of-place ones change nothing', () => {
    // 9 forged messages plus the oversized and the too deep request.
    expect(seen.invalidMessages).toBe(11);
    expect(seen.state).toBe('active');
  });
  test('a runtime that keeps sending invalid messages is failed and ended', async () => {
    await page.evaluate((h) => window.isolation.invoke(h, 'flood'), handle);
    await expect.poll(() => page.evaluate((h) => window.isolation.info(h), handle)).toMatchObject({ state: 'failed', failures: ['protocol-violation'], frames: 0 });
  });
});

test.describe('Old runtime generations', () => {
  test('a runtime that keeps talking after its session stopped reaches nothing, and its successor is a new generation', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const first = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
    await page.evaluate((h) => window.isolation.invoke(h, 'haunt'), first);
    // While the session is live, the haunting requests are served.
    await expect.poll(async () => (await page.evaluate((h) => window.isolation.info(h), first)).calls.length).toBeGreaterThan(3);
    const generation = (await page.evaluate((h) => window.isolation.info(h), first)).generation;
    await page.evaluate((h) => window.isolation.deactivateOnly(h), first);
    const atStop = (await page.evaluate((h) => window.isolation.info(h), first)).calls.length;
    await page.waitForTimeout(400);
    const later = await page.evaluate((h) => window.isolation.info(h), first);
    expect(later.calls.length).toBe(atStop);
    expect(later.invalidMessages).toBe(0);
    await page.evaluate((h) => window.isolation.terminate(h), first);
    const second = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
    expect((await page.evaluate((h) => window.isolation.info(h), second)).generation).toBeGreaterThan(generation);
    await page.close();
  });
});

test.describe('Forged handshakes from other windows', () => {
  test('the runtime frame ignores a load from any window but its parent', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const outcome = await page.evaluate(() => window.isolation.bootstrapIgnoresOtherWindows());
    expect(outcome.sent.loads).toBeGreaterThan(0);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ answeredWithParentNonce: true });
    await page.close();
  });
  test('the editor accepts only its own frame\'s answer with its nonce, while another window floods it with forged ones', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const outcome = await page.evaluate((spec) => window.isolation.handshakeUnderAttack(spec), GENUINE);
    expect(outcome.sent.readies).toBeGreaterThan(0);
    expect(outcome.outcome).toMatchObject({ started: true, ok: true, value: 'genuine' });
    await page.close();
  });
});

/**
 * Known gap in Chromium, kept as an expected failure until it is fixed (remove the marker then): the host has no cap
 * on the rate of well-formed messages. Each one is deserialized, measured and validated on the editor's thread, and
 * Chromium delivers a runtime's backlog without yielding to the editor's other work, so a runtime posting hundreds of
 * thousands of them (for example `pong`) stalls the editor until the backlog is handled; only the heartbeat ends a
 * sustained flood, after many seconds. Firefox handles the same flood slowly but stays responsive.
 */
const KNOWN_FLOOD_GAP = 'Known gap: no cap on the rate of well-formed runtime messages (see README.md).';

test.describe('Flooding the host with valid messages', () => {
  test('keeps the editor thread responsive during a sustained flood', async ({ browser, browserName }, info) => {
    test.fail(browserName === 'chromium', KNOWN_FLOOD_GAP);
    // Firefox stays responsive but works through the backlog slowly.
    test.setTimeout(180_000);
    const page = await openHarness(browser, info);
    const handle = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
    await page.evaluate((h) => window.isolation.invoke(h, 'spoof', {}, { document: 'doc-a' }), handle);
    const measured = await page.evaluate((h) => window.isolation.ticksDuring(0, () => window.isolation.invoke(h, 'flood-sustained', { ms: 4000, burst: 100_000, pause: 100 }, { timeoutMs: 150_000 })), handle);
    const after = await page.evaluate((h) => window.isolation.info(h), handle);
    test.info().annotations.push({ type: 'flood', description: `bursts of 100000 for 4 s: invocation ${JSON.stringify(measured.value)}, ${measured.elapsedMs} ms; ${measured.ticks} editor ticks of 10 ms, longest gap ${measured.longestGapMs} ms; session ${after.state} ${after.failures.join(',')}` });
    expect(measured.longestGapMs).toBeLessThan(250);
    await page.close();
  });
  for (const count of [20_000, 200_000]) {
    test(`keeps the editor thread responsive while ${count} well-formed messages arrive`, async ({ browser, browserName }, info) => {
      test.fail(browserName === 'chromium' && count > 100_000, KNOWN_FLOOD_GAP);
      const page = await openHarness(browser, info);
      const handle = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
      await page.evaluate((h) => window.isolation.invoke(h, 'spoof', {}, { document: 'doc-a' }), handle);
      const measured = await page.evaluate(({ h, count }) => window.isolation.ticksDuring(0, () => window.isolation.invoke(h, 'flood-valid', { count }, { timeoutMs: 40_000 })), { h: handle, count });
      const after = await page.evaluate((h) => window.isolation.info(h), handle);
      test.info().annotations.push({ type: 'flood', description: `${count} messages: invocation ${JSON.stringify(measured.value)}, handled in ${measured.elapsedMs} ms; longest gap between 10 ms editor ticks ${measured.longestGapMs} ms; session ${after.state} ${after.failures.join(',')}` });
      // An editor that froze while handling the flood shows a long gap between its ticks.
      expect(measured.longestGapMs).toBeLessThan(250);
      await page.close();
    });
  }
});
