// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Uploads a Vite build's source maps to Sentry. `sentry-cli sourcemaps inject` writes a
// Debug ID into every bundle and its map, then `upload` sends the maps, so stack traces from exactly this build are
// readable whatever its release name or URL. Run it after the build and before the maps are stripped and the bundle
// is deployed or packaged. Without SENTRY_AUTH_TOKEN it warns and changes nothing, so a deploy never depends on Sentry.
//   node scripts/sentry-sourcemaps.mjs apps/web/dist
// SENTRY_ORG and SENTRY_PROJECT default to the product's project; VITE_RELEASE, when set, names the release.
import { spawnSync } from 'node:child_process';

const CLI = '@sentry/cli@3.8.2';
const dist = process.argv[2];
if (!dist) {
  console.error('usage: node scripts/sentry-sourcemaps.mjs <dist directory>');
  process.exit(2);
}
if (!process.env.SENTRY_AUTH_TOKEN) {
  console.warn(`::warning::SENTRY_AUTH_TOKEN is not set: source maps for ${dist} were not uploaded to Sentry.`);
  process.exit(0);
}

const env = { ...process.env, SENTRY_ORG: process.env.SENTRY_ORG || 'jobcraft-inc', SENTRY_PROJECT: process.env.SENTRY_PROJECT || 'pushform' };
const sentryCli = (args) => {
  const result = spawnSync('npx', ['--yes', CLI, ...args], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`sentry-sourcemaps: sentry-cli ${args.join(' ')} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
};

sentryCli(['sourcemaps', 'inject', dist]);
sentryCli(['sourcemaps', 'upload', ...(process.env.VITE_RELEASE ? ['--release', process.env.VITE_RELEASE] : []), dist]);
