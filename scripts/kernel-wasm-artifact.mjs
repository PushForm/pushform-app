#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The kernel's WebAssembly module is built from Rust and C++ sources most contributors cannot compile, so CI publishes
// it and everyone else downloads it, addressed by a hash of everything it is built from: the kernel crates, the vendored
// binding, the build flags and the pinned toolchain. This module computes that hash and reads the lock file that records
// the published module's checksums. Usage: node scripts/kernel-wasm-artifact.mjs <hash|status|ci-plan|pin>
/* global process, console, fetch, URL */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');
export const wasmDir = `${root}/packages/kernel/wasm`;
export const lockPath = `${root}/packages/kernel/kernel-wasm.lock.json`;
export const stampPath = `${wasmDir}/kernel-wasm.stamp.json`;

/** The toolchain versions the module is built with; the published module is reproducible from these and the sources. */
export const TOOLCHAIN = { rust: '1.98.0', emscripten: '6.0.13' };
/** Where a published module for a source hash lives: a GitHub Release of this repository, tagged by the hash. */
export const RELEASE_REPO = 'PushForm/pushform-app';
export const releaseTag = (hash) => `kernel-wasm-${hash}`;
export const assetUrl = (hash, name) => `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(hash)}/${name}`;
/** The files of a published module. The faults build only ever runs in tests. */
export const MODULE_FILES = ['pushform-kernel.js', 'pushform_kernel.wasm'];
export const TEST_MODULE_FILES = ['pushform-kernel-faults.js', 'pushform_kernel_faults.wasm'];

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

/** The hash a published module is addressed by. */
export function sourceHash() {
  const files = [...INPUT_FILES.map((f) => join(root, f))];
  for (const dir of INPUT_DIRS) listFiles(join(root, dir), files);
  const entries = files.map((file) => `${relative(root, file).split(sep).join('/')}\0${sha256(readFileSync(file))}\n`);
  entries.sort();
  return sha256(`${TOOLCHAIN.rust}\0${TOOLCHAIN.emscripten}\n${entries.join('')}`);
}

export const readLock = () => JSON.parse(readFileSync(lockPath, 'utf8'));
export function writeLock(lock) {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
export const readStamp = () => (existsSync(stampPath) ? JSON.parse(readFileSync(stampPath, 'utf8')) : undefined);
export function writeStamp(origin, hash, fileNames) {
  const files = {};
  for (const name of fileNames) files[name] = sha256(readFileSync(`${wasmDir}/${name}`));
  writeFileSync(stampPath, `${JSON.stringify({ sourceHash: hash, origin, files }, null, 2)}\n`);
}

/** Whether the module in `packages/kernel/wasm` matches these sources. */
export function moduleStatus() {
  const missing = MODULE_FILES.filter((name) => !existsSync(`${wasmDir}/${name}`));
  if (missing.length) return { state: 'missing', message: `Missing packages/kernel/wasm/${missing[0]}.` };
  const stamp = readStamp();
  if (stamp === undefined) return { state: 'stale', message: 'packages/kernel/wasm was built before modules were stamped with their source hash.' };
  const hash = sourceHash();
  if (stamp.sourceHash !== hash) return { state: 'stale', message: `The kernel sources changed since this module was ${stamp.origin === 'local' ? 'built' : 'downloaded'} (stamp ${stamp.sourceHash.slice(0, 12)}, sources ${hash.slice(0, 12)}).` };
  for (const [name, expected] of Object.entries(stamp.files)) {
    if (!existsSync(`${wasmDir}/${name}`) || sha256(readFileSync(`${wasmDir}/${name}`)) !== expected) return { state: 'stale', message: `packages/kernel/wasm/${name} was changed after it was stamped.` };
  }
  return { state: 'fresh', origin: stamp.origin, sourceHash: hash };
}

const HOW_TO = 'Run `pnpm fetch:kernel-wasm` for the prebuilt module or `pnpm build:kernel-wasm` to compile it (needs Rust and Emscripten).';
/** The message `pnpm test` fails with, or undefined when the module is usable. */
export function moduleProblem() {
  const status = moduleStatus();
  return status.state === 'fresh' ? undefined : `The Rust kernel's WebAssembly module is ${status.state}: ${status.message} ${HOW_TO}`;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Record the checksums of the module CI published for these sources. Run after the first main build that publishes it. */
async function pin() {
  const hash = sourceHash();
  const files = {};
  for (const name of [...MODULE_FILES, ...TEST_MODULE_FILES]) files[name] = sha256(await download(assetUrl(hash, name)));
  writeLock({ sourceHash: hash, files });
  console.log(`Pinned the published module for sources ${hash}. Commit packages/kernel/kernel-wasm.lock.json.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'hash') console.log(sourceHash());
  else if (command === 'status') {
    const status = moduleStatus();
    console.log(JSON.stringify(status));
    process.exitCode = status.state === 'fresh' ? 0 : 1;
  } else if (command === 'ci-plan') {
    // For the CI action: the pinned toolchain, and whether the published module can be downloaded instead of built.
    const lock = readLock();
    const hash = sourceHash();
    const pinned = lock.sourceHash === hash && Object.keys(lock.files ?? {}).length > 0;
    process.stdout.write(`rust=${TOOLCHAIN.rust}\nemscripten=${TOOLCHAIN.emscripten}\nsource_hash=${hash}\npinned=${pinned}\n`);
  } else if (command === 'pin') {
    await pin();
  } else {
    console.error('Usage: node scripts/kernel-wasm-artifact.mjs <hash|status|ci-plan|pin>');
    process.exitCode = 1;
  }
}
