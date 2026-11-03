// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { defineConfig, devices } from '@playwright/test';
import { SHELLS, projectName } from './shells';

/** Set to run the whole suite in the excluded browsers too, to measure them (they are expected to fail somewhere). */
const MEASURE_EXCLUDED = process.env.ISOLATION_MEASURE_EXCLUDED === '1';
const DEVICES = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] } as const;

/**
 * One project per shell of the matrix that a browser can stand for (shells.ts). Included shells run every spec;
 * excluded browsers run only the fail-closed check. Timing checks (editor responsiveness, heartbeat) share the machine,
 * so tests run one at a time.
 */
export default defineConfig({
  testDir: 'tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]] : 'list',
  projects: SHELLS.filter((shell) => shell.project).map((shell) => ({
    name: projectName(shell),
    metadata: { editor: shell.project!.editor, status: shell.status },
    use: { ...DEVICES[shell.project!.browser] },
    ...(shell.project!.suite === 'fails-closed' && !MEASURE_EXCLUDED ? { testMatch: 'fails-closed.spec.ts' } : { testIgnore: 'fails-closed.spec.ts' }),
  })),
});
