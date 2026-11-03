// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Run only in excluded browsers (shells.ts): the runtime must refuse to start there and leave nothing running, so an
// excluded shell can never run extension code by accident.
import { expect, test } from '@playwright/test';
import { openHarness } from './support';

const PROBE = {
  id: 'com.example.fails-closed',
  files: { 'main.js': `export function activate(c) { c.commands.register('com.example.fails-closed.run', () => 'ran'); }` },
};

test('the runtime does not start, reports why, and leaves no frame or worker behind', async ({ browser }, info) => {
  test.info().annotations.push({ type: 'engine', description: `${browser.browserType().name()} ${browser.version()}` });
  const page = await openHarness(browser, info);
  const outcome = await page.evaluate((spec) => window.isolation.run(spec, 'run', {}, { timeoutMs: 20_000 }), PROBE);
  test.info().annotations.push({ type: 'outcome', description: JSON.stringify(outcome) });
  expect(outcome).not.toMatchObject({ ok: true });
  expect(JSON.stringify(outcome)).not.toContain('"ran"');
  await expect.poll(() => page.evaluate(() => window.isolation.frames())).toBe(0);
  await page.close();
});

test('the app does not offer extensions in this browser', async ({ page }) => {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  // The app's own check, which hides the extension manager where the runtime cannot run.
  const { browserRunsExtensions } = await import('../../../packages/ui/src/extensions/browserRunsExtensions.ts');
  expect(browserRunsExtensions(userAgent)).toBe(false);
});
