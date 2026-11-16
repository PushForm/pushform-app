#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Build the Rust kernel (crates/kernel-wasm) to WebAssembly with Emscripten and place it where @pushform/kernel
// loads it from.
/* global process, console, URL */
// Needs the wasm32-unknown-emscripten Rust target (`rustup target add wasm32-unknown-emscripten`) and Emscripten's
// emcc, emcmake and emmake on PATH (`brew install emscripten`, or `source emsdk_env.sh`). The first build clones
// Manifold and compiles it. Usage: node scripts/build-kernel-wasm.mjs [--check] [--faults]
// The result is stamped with the hash of its sources, so tests and builds can tell when it needs building again.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash, TOOLCHAIN, writeStamp } from './kernel-wasm-artifact.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = `${root}crates/kernel-wasm`;
const outDir = `${root}packages/kernel/wasm`;
const target = 'wasm32-unknown-emscripten';
const targetDir = resolve(crate, process.env.CARGO_TARGET_DIR ?? 'target');
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
// Only this toolchain pair is tested; a different one still builds, but warns.
for (const [tool, expected, version] of [['rustc', TOOLCHAIN.rust, 'rustc'], ['emcc', TOOLCHAIN.emscripten, 'emcc']]) {
  try {
    const reported = process.platform === 'win32' && version === 'emcc'
      ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'emcc --version'], { encoding: 'utf8', windowsHide: true })
      : execFileSync(version, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!reported.includes(expected)) console.warn(`kernel: ${tool} is not the pinned ${expected}: ${reported.split('\n')[0]}`);
  } catch {
    console.warn(`kernel: could not run ${tool} to check its version`);
  }
}
// Rust's Emscripten target defaults to emcc.bat; current Windows SDKs ship emcc.exe.
const buildEnv = { ...process.env };
if (process.platform === 'win32' && !buildEnv.CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER) {
  buildEnv.CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER = execFileSync('where.exe', ['emcc.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
}
const built = [];
for (const { bin, args } of modules) {
  execFileSync('cargo', ['build', '--release', '--target', target, '--no-default-features', '--bin', bin, ...args], { cwd: crate, stdio: 'inherit', env: buildEnv, windowsHide: true });
  for (const file of outputs(bin)) {
    const out = `${outDir}/${file}`;
    copyFileSync(`${targetDir}/${target}/release/${file}`, out);
    console.log(`kernel: ${(statSync(out).size / 1048576).toFixed(2)} MiB at packages/kernel/wasm/${file}`);
    built.push(file);
  }
}
writeStamp(sourceHash(), built);
