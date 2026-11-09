#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Download the prebuilt WebAssembly kernel for the current sources and verify it against the checksums in
// packages/kernel/kernel-wasm.lock.json. Usage: node scripts/fetch-kernel-wasm.mjs [--if-needed]
/* global process, console, fetch */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { assetUrl, MODULE_FILES, moduleProblem, moduleStatus, readLock, sourceHash, TEST_MODULE_FILES, wasmDir, writeStamp } from './kernel-wasm-artifact.mjs';

const hash = sourceHash();
const lock = readLock();
if (process.argv.includes('--if-needed') && moduleStatus().state === 'fresh') process.exit(0);
if (lock.sourceHash !== hash && lock.sourceHash !== '') {
  console.error('The kernel sources have changed since the published module was pinned in packages/kernel/kernel-wasm.lock.json.\nRun `pnpm build:kernel-wasm` to compile this version (needs Rust and Emscripten).');
  process.exit(1);
}
if (lock.sourceHash === '' || Object.keys(lock.files ?? {}).length === 0) {
  console.error('No published module is pinned for these sources yet: CI publishes it when the sources reach main, then `pnpm kernel-wasm:pin` records its checksums.\nRun `pnpm build:kernel-wasm` to compile it now (needs Rust and Emscripten).');
  process.exit(1);
}

mkdirSync(wasmDir, { recursive: true });
const fetched = [];
for (const name of [...MODULE_FILES, ...TEST_MODULE_FILES]) {
  const expected = lock.files[name];
  if (expected === undefined) continue;
  const url = assetUrl(hash, name);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Could not download ${url} (HTTP ${response.status}). Run \`pnpm build:kernel-wasm\` to compile the module (needs Rust and Emscripten).`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    console.error(`${name} failed verification: expected ${expected}, got ${actual}. Refusing to install it.`);
    process.exit(1);
  }
  const target = `${wasmDir}/${name}`;
  writeFileSync(`${target}.partial`, bytes);
  renameSync(`${target}.partial`, target);
  fetched.push(name);
}
writeStamp('download', hash, fetched);
const problem = moduleProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
console.log(`kernel: verified ${fetched.length} files for sources ${hash.slice(0, 12)}`);
