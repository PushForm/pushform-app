#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Build the push/pull kernel (crates/kernel-wasm) to WebAssembly with Emscripten and place it where @pushform/kernel
// loads it from.
/* global process, console, URL */
// Needs the wasm32-unknown-emscripten Rust target (`rustup target add wasm32-unknown-emscripten`) and Emscripten's
// emcc, emcmake and emmake on PATH (`brew install emscripten`, or `source emsdk_env.sh`). The first build clones
// Manifold and compiles it. Usage: node scripts/build-kernel-wasm.mjs [--check] [--faults]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}crates/kernel-wasm`;
const outDir = `${root}packages/kernel/wasm`;
const target = 'wasm32-unknown-emscripten';
const modules = [{ bin: 'pushform-kernel', args: [] }];
/** Cargo writes the glue as `<bin>.js` and the module as `<bin_with_underscores>.wasm`, the name the glue loads. */
const outputs = (bin) => [`${bin}.js`, `${bin.replaceAll('-', '_')}.wasm`];
// `--faults` also builds the module with requests that fail on purpose, for the failure tests.
if (process.argv.includes('--faults')) modules.push({ bin: 'pushform-kernel-faults', args: ['--features', 'fault-injection'] });

if (process.argv.includes('--check')) {
  for (const { bin } of modules) {
    for (const file of outputs(bin)) {
      if (!existsSync(`${outDir}/${file}`)) { console.error(`Missing packages/kernel/wasm/${file}: run pnpm build:kernel-wasm`); process.exit(1); }
    }
  }
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
for (const { bin, args } of modules) {
  execFileSync('cargo', ['build', '--release', '--target', target, '--no-default-features', '--bin', bin, ...args], { cwd: crate, stdio: 'inherit' });
  for (const file of outputs(bin)) {
    const out = `${outDir}/${file}`;
    copyFileSync(`${crate}/target/${target}/release/${file}`, out);
    console.log(`kernel: ${(statSync(out).size / 1048576).toFixed(2)} MiB at packages/kernel/wasm/${file}`);
  }
}
