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
  commands: ['spoof', 'flood', 'haunt', 'flood-valid', 'flood-sustained', 'flood-bytes'],
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
  context.commands.register('com.example.spoofer.flood-bytes', async (params) => {
    // Results for invocations the host never made: well-formed and dropped, but each is received and measured.
    const value = 'x'.repeat(params.chars);
    const started = Date.now();
    for (let n = 0; n < params.count; n++) send({ type: 'result', invocation: 900000 + n, ok: true, value });
    return Date.now() - started;
  });
  context.commands.register('com.example.spoofer.flood-valid', async (params) => {
    const started = Date.now();
    for (let n = 0; n < params.count; n++) send({ type: 'pong', n });
    return Date.now() - started;
  });
}`,
  },
};

/**
 * A well-behaved extension that calls the host in a tight loop, one call after another or many at once. The runtime
 * paces its calls below the host's budget, so it slows down and keeps running.
 */
const BUSY = {
  id: 'com.example.busy',
  commands: ['calls'],
  files: {
    'main.js': `
export function activate(context) {
  context.commands.register('com.example.busy.calls', async (params) => {
    const until = performance.now() + params.ms;
    let calls = 0;
    const loop = async () => { while (performance.now() < until) { await context.log.write('busy'); calls++; } };
    await Promise.all(Array.from({ length: params.width }, loop));
    return calls;
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
 * A runtime may send at most 5,000 messages at once and 10,000 a second, and 64 MiB at once and 32 MiB a second.
 * Past either, the session fails as a protocol violation and the runtime is ended, which drops its backlog, so the
 * editor stalls for at most the time it takes to handle the burst. Without the budget, Chromium handled a backlog of
 * 200,000 messages without yielding (a stall of about half a second) and a sustained flood froze the editor for
 * seconds at a time until the heartbeat ended it; Firefox stayed responsive but took about a minute to drain it.
 */
async function flood(page: Page, command: string, params: Record<string, number>) {
  const handle = await page.evaluate((spec) => window.isolation.start(spec), SPOOFER);
  await page.evaluate((h) => window.isolation.invoke(h, 'spoof', {}, { document: 'doc-a' }), handle);
  // The ticks keep running for a second after the invocation ends, to show the editor stays responsive afterwards too.
  const measured = await page.evaluate(({ h, command, params }) => window.isolation.ticksDuring(1000, () => window.isolation.invoke(h, command, params, { timeoutMs: 150_000 })), { h: handle, command, params });
  const after = await page.evaluate((h) => window.isolation.info(h), handle);
  const endedMs = measured.elapsedMs - 1000;
  test.info().annotations.push({ type: 'flood', description: `${command} ${JSON.stringify(params)}: invocation ${JSON.stringify(measured.value)} after ${endedMs} ms; ${measured.ticks} editor ticks of 10 ms, longest gap ${measured.longestGapMs} ms; session ${after.state} ${after.failures.join(',')} ${after.failureDetails.join(',')}, ${after.frames} frames` });
  return { measured, after, endedMs };
}

test.describe('Flooding the host with valid messages', () => {
  test('a sustained flood is ended within seconds, and the editor stays responsive throughout', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const { measured, after, endedMs } = await flood(page, 'flood-sustained', { ms: 4000, burst: 100_000, pause: 100 });
    expect(after).toMatchObject({ state: 'failed', failures: ['protocol-violation'], frames: 0 });
    expect(measured.value).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(endedMs).toBeLessThan(3000);
    // An editor that froze while handling the flood shows a long gap between its ticks.
    expect(measured.longestGapMs).toBeLessThan(250);
    await page.close();
  });
  test('200000 well-formed messages at once end the runtime, and the editor stays responsive', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const { measured, after, endedMs } = await flood(page, 'flood-valid', { count: 200_000 });
    expect(after).toMatchObject({ state: 'failed', failures: ['protocol-violation'], frames: 0 });
    expect(endedMs).toBeLessThan(3000);
    expect(measured.longestGapMs).toBeLessThan(250);
    await page.close();
  });
  test('400 MiB of well-formed messages at once end the runtime, and the editor stays responsive', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const { measured, after, endedMs } = await flood(page, 'flood-bytes', { count: 400, chars: 512 * 1024 });
    expect(after).toMatchObject({ state: 'failed', failures: ['protocol-violation'], frames: 0 });
    expect(endedMs).toBeLessThan(3000);
    expect(measured.longestGapMs).toBeLessThan(250);
    await page.close();
  });
  test('2000 well-formed messages at once are within the budget', async ({ browser }, info) => {
    const page = await openHarness(browser, info);
    const { measured, after } = await flood(page, 'flood-valid', { count: 2000 });
    expect(measured.value).toMatchObject({ ok: true });
    expect(after).toMatchObject({ state: 'active', failures: [] });
    expect(measured.longestGapMs).toBeLessThan(250);
    await page.close();
  });
});

test.describe('A busy extension within the message budget', () => {
  for (const width of [1, 32]) {
    test(`keeps running while it makes host calls as fast as it can, ${width} at a time`, async ({ browser }, info) => {
      const page = await openHarness(browser, info);
      const handle = await page.evaluate((spec) => window.isolation.start(spec), BUSY);
      const measured = await page.evaluate(({ h, width }) => window.isolation.ticksDuring(0, () => window.isolation.invoke(h, 'calls', { ms: 3000, width })), { h: handle, width });
      const after = await page.evaluate((h) => window.isolation.info(h), handle);
      const calls = (measured.value as { value?: number }).value ?? 0;
      test.info().annotations.push({ type: 'busy', description: `${calls} calls in 3 s (${Math.round(calls / 3)} per second), ${width} at a time; longest gap between 10 ms editor ticks ${measured.longestGapMs} ms; session ${after.state} ${after.failures.join(',')}` });
      expect(measured.value, JSON.stringify(measured.value)).toMatchObject({ ok: true });
      expect(after.state).toBe('active');
      expect(measured.longestGapMs).toBeLessThan(250);
      await page.close();
    });
  }
});

