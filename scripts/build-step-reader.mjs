#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Build the STEP reader (crates/step-reader) to WebAssembly and place it where @pushform/io loads it from.
/* global process, console, URL */
// Needs a Rust toolchain with the wasm32-wasip1 target (`rustup target add wasm32-wasip1`), as the desktop
// app already needs Rust. Usage: node scripts/build-step-reader.mjs [--check]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}crates/step-reader`;
const built = `${crate}/target/wasm32-wasip1/release/pushform_step_reader.wasm`;
const target = `${root}packages/io/wasm/pushform-step.wasm`;

if (process.argv.includes('--check')) {
  if (!existsSync(target)) { console.error(`Missing ${target}: run pnpm build:step-reader`); process.exit(1); }
  process.exit(0);
}
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-wasip1'], { cwd: crate, stdio: 'inherit' });
mkdirSync(`${root}packages/io/wasm`, { recursive: true });
copyFileSync(built, target);
console.log(`step reader: ${(statSync(target).size / 1048576).toFixed(1)} MiB at packages/io/wasm/pushform-step.wasm`);
