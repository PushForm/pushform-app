#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global process */
// pushform-extension. Workspace packages export TypeScript sources, which Node cannot run, so this launcher bundles
// src/cli.ts with esbuild into a temporary module and runs it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [join(here, '../src/cli.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'error',
});
const dir = mkdtempSync(join(tmpdir(), 'pushform-extension-'));
const file = join(dir, 'cli.mjs');
writeFileSync(file, result.outputFiles[0].text);
try {
  await import(pathToFileURL(file).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
  void process;
}
