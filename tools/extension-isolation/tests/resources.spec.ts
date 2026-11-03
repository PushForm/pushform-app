// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Resource abuse in the real runtime: a hung extension, one exhausting its heap, and binary allocations beyond the
// per-extension budget by every route an extension has.
import { expect, test, type Page } from '@playwright/test';
import { BINARY_BUDGET } from './attacks';
import { expectBlocked, hostilePackage, openHarness, type Attempts } from './support';

const HOG = {
  id: 'com.example.hog',
  commands: ['hang', 'exhaust'],
  files: {
    'main.js': `export function activate(c) {
  c.commands.register('com.example.hog.hang', () => { for (;;) {} });
  c.commands.register('com.example.hog.exhaust', () => { const keep = []; for (;;) keep.push({ a: keep.length, b: [keep.length] }); });
}`,
  },
};

test('a hung extension leaves the editor responsive and is ended from outside', async ({ browser }, info) => {
  const page = await openHarness(browser, info);
  const handle = await page.evaluate((spec) => window.isolation.start(spec), HOG);
  const outcome = await page.evaluate((h) => window.isolation.responsiveDuring(h, 'hang', 500), handle);
  test.info().annotations.push({ type: 'hang', description: JSON.stringify(outcome) });
  expect(outcome.ticks).toBeGreaterThan(30);
  expect(outcome.invocation).toBe('cancelled');
  expect(outcome.confirmed).toBe(false);
  expect(outcome.frames).toBe(0);
  await page.close();
});

test('an extension that exhausts its heap is noticed by the heartbeat and ended', async ({ browser }, info) => {
  const page = await openHarness(browser, info);
  const handle = await page.evaluate((spec) => window.isolation.start(spec, { limits: { heartbeatMs: 500, unresponsiveMs: 3000 } }), HOG);
  const outcome = await page.evaluate((h) => window.isolation.failureOf(h, 'exhaust', 40_000), handle);
  test.info().annotations.push({ type: 'heap', description: JSON.stringify({ outcome: outcome.outcome, ms: outcome.ms, ticks: outcome.ticks, failures: outcome.failures }) });
  expect(outcome.outcome).toBe('cancelled');
  expect(outcome.failures).toEqual(['unresponsive']);
  expect(outcome.frames).toBe(0);
  await page.close();
});

test.describe('Binary memory budget (256 MiB per extension)', () => {
  // Each attack runs in its own runtime: counted buffers are returned to the budget only once collected.
  let page: Page;
  test.beforeAll(async ({ browser }, info) => { page = await openHarness(browser, info); });
  test.afterAll(async () => { await page?.close(); });
  for (const [key, attack] of Object.entries(BINARY_BUDGET)) {
    test(`refuses: ${attack.title}`, async () => {
      const outcome = await page.evaluate((spec) => window.isolation.run(spec, 'run', { timeoutMs: 15_000 }, { timeoutMs: 60_000 }),
        hostilePackage('com.example.hostile-memory', { [key]: attack }));
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ started: true, ok: true });
      expectBlocked((outcome as unknown as { value: Attempts }).value, key);
    });
  }
  test('offers none of the interfaces that keep copies the budget cannot see', async () => {
    const names = ['MessageChannel', 'BroadcastChannel', 'Response', 'Request', 'OffscreenCanvas', 'ImageData', 'createImageBitmap',
      'VideoFrame', 'AudioData', 'VideoDecoder', 'ImageDecoder', 'MediaSource', 'FontFace', 'Notification', 'PerformanceMark', 'postMessage'];
    const outcome = await page.evaluate((spec) => window.isolation.run(spec), hostilePackage('com.example.removed', {
      globals: { title: 'the removed globals', code: `() => ${JSON.stringify(names)}.filter((n) => self[n] !== undefined).join(',') || 'none'` },
      members: { title: 'removed members', code: `() => [typeof performance.mark, typeof performance.measure, typeof navigator.gpu].join(',')` },
    }));
    const value = (outcome as unknown as { value: Attempts }).value;
    expect(value.globals).toMatchObject({ outcome: 'allowed', detail: 'none' });
    expect(value.members).toMatchObject({ outcome: 'allowed', detail: 'undefined,undefined,undefined' });
  });
  test('allows ordinary allocations within the budget', async () => {
    const outcome = await page.evaluate((spec) => window.isolation.run(spec), hostilePackage('com.example.modest', {
      sixtyFour: { title: 'a 64 MiB buffer', code: `() => new Uint8Array(64 * 1024 * 1024).length` },
      everyday: { title: 'everyday binary work', code: `async () => {
        const bytes = new TextEncoder().encode('{"parts":[1,2,3]}');
        const blob = new Blob([bytes, ' tail'], { type: 'application/json' });
        const gz = new Blob([blob]).stream().pipeThrough(new CompressionStream('gzip')).pipeThrough(new DecompressionStream('gzip'));
        const chunks = []; for await (const chunk of gz) chunks.push(chunk);
        const copy = structuredClone({ data: new Float64Array([1.5, 2.5]) });
        const moved = new ArrayBuffer(8).transfer(16);
        class Points extends Float32Array {}
        return [new TextDecoder().decode(await blob.arrayBuffer()), chunks.reduce((n, c) => n + c.byteLength, 0), copy.data[1], moved.byteLength,
          new Points([1, 2]).map((v) => v * 2) instanceof Points, Uint8Array.from([1, 2]).toReversed().join('-'), new File(['x'], 'a.txt').name].join(' ');
      }` },
    }));
    expect((outcome as unknown as { value: Attempts }).value.sixtyFour).toMatchObject({ outcome: 'allowed', detail: String(64 * 1024 * 1024) });
    expect((outcome as unknown as { value: Attempts }).value.everyday).toMatchObject({ outcome: 'allowed', detail: '{"parts":[1,2,3]} tail 22 2.5 16 true 2-1 a.txt' });
  });
});
