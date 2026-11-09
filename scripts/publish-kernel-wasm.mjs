#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Publish the WebAssembly kernel CI just built as a GitHub Release asset, addressed by its source hash. Run by the
// `publish-kernel-wasm` job on main; needs GH_TOKEN with contents: write. A release that already exists is left alone.
/* global process, console */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { MODULE_FILES, moduleStatus, RELEASE_REPO, releaseTag, sourceHash, TEST_MODULE_FILES, wasmDir } from './kernel-wasm-artifact.mjs';

const hash = sourceHash();
const status = moduleStatus();
if (status.state !== 'fresh' || status.sourceHash !== hash) throw new Error(`The kernel module to publish is ${status.state}: ${status.message}`);
const tag = releaseTag(hash);
const view = spawnSync('gh', ['release', 'view', tag, '--repo', RELEASE_REPO], { stdio: 'ignore' });
const notice = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
if (view.status === 0) {
  notice(`Kernel module for sources ${hash.slice(0, 12)} is already published.`);
  process.exit(0);
}
const assets = [...MODULE_FILES, ...TEST_MODULE_FILES].map((name) => `${wasmDir}/${name}`).filter((path) => existsSync(path));
execFileSync('gh', ['release', 'create', tag, ...assets, '--repo', RELEASE_REPO, '--title', `Kernel WebAssembly module ${hash.slice(0, 12)}`, '--notes', 'Prebuilt WebAssembly kernel, addressed by the hash of its sources (scripts/kernel-wasm-artifact.mjs).', '--latest=false'], { stdio: 'inherit' });
notice(`Published the kernel module for sources ${hash.slice(0, 12)}. Now run \`pnpm kernel-wasm:pin\` and commit packages/kernel/kernel-wasm.lock.json.`);
