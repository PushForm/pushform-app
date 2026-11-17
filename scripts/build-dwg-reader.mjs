#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Build the DWG reader (crates/dwg-reader) to WebAssembly and place it where @pushform/io loads it from.
/* global process, console, URL */
// Needs a Rust toolchain with the wasm32-wasip1 target (`rustup target add wasm32-wasip1`), as the STEP reader does.
// Usage: node scripts/build-dwg-reader.mjs [--check]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}crates/dwg-reader`;
const out = `${root}packages/io/wasm/pushform-dwg.wasm`;

if (process.argv.includes('--check')) {
  if (!existsSync(out)) { console.error('Missing packages/io/wasm/pushform-dwg.wasm: run pnpm build:dwg-reader'); process.exit(1); }
  process.exit(0);
}
mkdirSync(`${root}packages/io/wasm`, { recursive: true });
execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-wasip1'], { cwd: crate, stdio: 'inherit' });
copyFileSync(`${crate}/target/wasm32-wasip1/release/pushform_dwg_reader.wasm`, out);
console.log(`packages/io/wasm/pushform-dwg.wasm: ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
