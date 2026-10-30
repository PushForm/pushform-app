// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Smoke test: build the web app and assert the output exists and references the entry bundle.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('pnpm', ['exec', 'vite', 'build'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`smoke: vite build failed with status ${result.status}`);
  process.exit(result.status ?? 1);
}
const dist = join(root, 'dist');
const index = join(dist, 'index.html');
if (!existsSync(index)) {
  console.error('smoke: dist/index.html missing');
  process.exit(1);
}
const html = readFileSync(index, 'utf8');
const assets = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')) : [];
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));
if (!js.length || !/<script[^>]+type="module"/.test(html)) {
  console.error('smoke: no module script bundle in dist');
  process.exit(1);
}
if (!css.length) {
  console.error('smoke: no stylesheet emitted');
  process.exit(1);
}
console.log(`smoke: ok (${js.length} js, ${css.length} css)`);
