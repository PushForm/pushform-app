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

/**
 * Known gaps, kept as expected failures until they are fixed (remove the marker then). The budget replaces the
 * global constructors, but the originals stay reachable, and some platform methods make large buffers on request.
 */
const BUDGET_GAPS: Record<string, string> = {
  nativeArrayBufferFromPrototype: 'the replacement ArrayBuffer extends the original, so Object.getPrototypeOf(ArrayBuffer) is the uncounted original',
  nativeArrayBufferFromInstance: 'buffers keep the original ArrayBuffer as their constructor',
  nativeTypedArrayFromPrototype: 'each replacement typed array extends the original, which is reachable the same way',
  transfer: 'ArrayBuffer.prototype.transfer allocates the new length without counting it',
  structuredCloneCopies: 'structuredClone copies are not counted (documented: platform copies of data the extension holds)',
  blobAmplification: 'a Blob repeating one buffer reads back as a much larger uncounted buffer',
  decompression: 'DecompressionStream output is not counted, so a small input becomes a large buffer',
};

test.describe('Binary memory budget (256 MiB per extension)', () => {
  // Each attack runs in its own runtime: counted buffers are returned to the budget only once collected.
  let page: Page;
  test.beforeAll(async ({ browser }, info) => { page = await openHarness(browser, info); });
  test.afterAll(async () => { await page?.close(); });
  for (const [key, attack] of Object.entries(BINARY_BUDGET)) {
    test(`refuses: ${attack.title}`, async () => {
      test.fail(key in BUDGET_GAPS, `Known gap: ${BUDGET_GAPS[key]}`);
      const outcome = await page.evaluate((spec) => window.isolation.run(spec, 'run', { timeoutMs: 15_000 }, { timeoutMs: 60_000 }),
        hostilePackage('com.example.hostile-memory', { [key]: attack }));
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ started: true, ok: true });
      expectBlocked((outcome as unknown as { value: Attempts }).value, key);
    });
  }
  test('allows ordinary allocations within the budget', async () => {
    const outcome = await page.evaluate((spec) => window.isolation.run(spec), hostilePackage('com.example.modest', {
      sixtyFour: { title: 'a 64 MiB buffer', code: `() => new Uint8Array(64 * 1024 * 1024).length` },
    }));
    expect((outcome as unknown as { value: Attempts }).value.sixtyFour).toMatchObject({ outcome: 'allowed', detail: String(64 * 1024 * 1024) });
  });
});
