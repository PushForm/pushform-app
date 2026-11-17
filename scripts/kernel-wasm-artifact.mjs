#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The kernel's WebAssembly module is compiled from Rust and C++ and is not committed. It is stamped with a hash of
// everything it is built from: the kernel crates, the vendored binding, the build flags and the pinned toolchain. This
// module computes that hash, so tests and builds can tell when a module no longer matches its sources.
// Usage: node scripts/kernel-wasm-artifact.mjs <hash|status|ci-plan>
/* global process, console, URL, Buffer */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
export const wasmDir = `${root}/packages/kernel/wasm`;
export const stampPath = `${wasmDir}/kernel-wasm.stamp.json`;

/** The toolchain versions the module is built with; only this pair is tested. */
export const TOOLCHAIN = { rust: '1.98.0', emscripten: '6.0.13' };
/** The files of a built module. */
export const MODULE_FILES = ['pushform-kernel.js', 'pushform_kernel.wasm'];

// Everything the module is built from. Files only ever seen by the build step (Manifold's C++ is fetched by a pinned
// commit that lives in these sources) need no entry of their own.
const INPUT_DIRS = ['crates/native-kernel', 'crates/kernel-wasm'];
const INPUT_FILES = ['packages/core/src/tolerance.ts', 'scripts/build-kernel-wasm.mjs'];
const IGNORED = new Set(['target', '.DS_Store']);

function listFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Documentation never reaches the module, so editing it must not make everyone's module stale.
    if (IGNORED.has(entry.name) || entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One input's hash. Git for Windows checks text out with CRLF, and a module built on another platform must still match. */
export const sourceFileHash = (bytes) => sha256(Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));

/** The hash a built module is stamped with. */
export function sourceHash() {
  const files = [...INPUT_FILES.map((f) => join(root, f))];
  for (const dir of INPUT_DIRS) listFiles(join(root, dir), files);
  const entries = files.map((file) => `${relative(root, file).split(sep).join('/')}\0${sourceFileHash(readFileSync(file))}\n`);
  entries.sort();
  return sha256(`${TOOLCHAIN.rust}\0${TOOLCHAIN.emscripten}\n${entries.join('')}`);
}

export const readStamp = () => (existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, 'utf8')) : undefined);
export function writeStamp(hash, fileNames) {
  const files = {};
  for (const name of fileNames) files[name] = sha256(readFileSync(`${wasmDir}/${name}`));
  writeFileSync(stampPath, `${JSON.stringify({ sourceHash: hash, files }, null, 2)}\n`);
}

/** Whether the module in `packages/kernel/wasm` matches these sources. */
export function moduleStatus() {
  const missing = MODULE_FILES.filter((name) => !existsSync(`${wasmDir}/${name}`));
  if (missing.length) return { state: 'missing', message: `Missing packages/kernel/wasm/${missing[0]}.` };
  const stamp = readStamp();
  if (stamp === undefined) return { state: 'stale', message: 'packages/kernel/wasm was built before modules were stamped with their source hash.' };
  const hash = sourceHash();
  if (stamp.sourceHash !== hash) return { state: 'stale', message: `The kernel sources changed since this module was built (stamp ${stamp.sourceHash.slice(0, 12)}, sources ${hash.slice(0, 12)}).` };
  for (const [name, expected] of Object.entries(stamp.files)) {
    if (!existsSync(`${wasmDir}/${name}`) || sha256(readFileSync(`${wasmDir}/${name}`)) !== expected) return { state: 'stale', message: `packages/kernel/wasm/${name} was changed after it was stamped.` };
  }
  return { state: 'fresh', sourceHash: hash };
}

const HOW_TO = 'Run `pnpm build:kernel-wasm` to compile it. It needs Rust, Emscripten and cmake; see "Develop" in README.md.';
/** The message `pnpm test` fails with, or undefined when the module is usable. */
export function moduleProblem() {
  const status = moduleStatus();
  return status.state === 'fresh' ? undefined : `The Rust kernel's WebAssembly module is ${status.state}: ${status.message} ${HOW_TO}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'hash') console.log(sourceHash());
  else if (command === 'status') {
    const status = moduleStatus();
    console.log(JSON.stringify(status));
    process.exitCode = status.state === 'fresh' ? 0 : 1;
  } else if (command === 'ci-plan') {
    // For the CI action: the pinned toolchain and the key its build is cached under.
    process.stdout.write(`rust=${TOOLCHAIN.rust}\nemscripten=${TOOLCHAIN.emscripten}\nsource_hash=${sourceHash()}\n`);
  } else {
    console.error('Usage: node scripts/kernel-wasm-artifact.mjs <hash|status|ci-plan>');
    process.exitCode = 1;
  }
}
