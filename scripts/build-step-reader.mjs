#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Build the STEP reader (crates/step-reader) to WebAssembly and place it where @pushform/io loads it from.
/* global process, console, URL */
// Needs a Rust toolchain with the wasm32-wasip1 and wasm32-wasip1-threads targets (`rustup target add
// wasm32-wasip1 wasm32-wasip1-threads`), as the desktop app already needs Rust. Two modules are built: the
// single-threaded reader and the threaded one for cross-origin isolated pages. Usage: node scripts/build-step-reader.mjs [--check]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}crates/step-reader`;
const builds = [
  { target: 'wasm32-wasip1', args: [], file: 'pushform-step.wasm' },
  { target: 'wasm32-wasip1-threads', args: ['--features', 'threads'], file: 'pushform-step-threads.wasm' },
];

if (process.argv.includes('--check')) {
  for (const { file } of builds) {
    if (!existsSync(`${root}packages/io/wasm/${file}`)) { console.error(`Missing packages/io/wasm/${file}: run pnpm build:step-reader`); process.exit(1); }
  }
  process.exit(0);
}
mkdirSync(`${root}packages/io/wasm`, { recursive: true });
for (const { target, args, file } of builds) {
  execFileSync('cargo', ['build', '--release', '--target', target, ...args], { cwd: crate, stdio: 'inherit' });
  const out = `${root}packages/io/wasm/${file}`;
  copyFileSync(`${crate}/target/${target}/release/pushform_step_reader.wasm`, out);
  console.log(`step reader: ${(statSync(out).size / 1048576).toFixed(1)} MiB at packages/io/wasm/${file}`);
}
