#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global process, console, URL, performance */
// Time a STEP import through the WebAssembly reader in Node, with the threaded module on worker threads or the
// single-threaded one. Usage: node scripts/step-threads-bench.mjs <file.step> [--threads N] (0 for the single-threaded
// module; the default is the core count, at most 8). Needs pnpm build:step-reader.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// esbuild is a dependency of the MCP package; this script borrows it the same way pushform-mcp does.
const { build } = createRequire(join(root, 'packages/mcp/package.json'))('esbuild');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: step-threads-bench <file.step> [--threads N]'); process.exit(2); }
const flag = args.indexOf('--threads');
const threads = flag >= 0 ? Number(args[flag + 1]) : Math.min(8, availableParallelism());

const plugins = [
  { name: 'manifold-external', setup(b) { b.onResolve({ filter: /^manifold-3d$/ }, async a => {
    if (a.pluginData === 'inner') return undefined;
    const r = await b.resolve('manifold-3d', { kind: 'import-statement', resolveDir: join(root, 'packages/kernel/src'), pluginData: 'inner' });
    return r.errors.length ? { errors: r.errors } : { path: pathToFileURL(r.path).href, external: true };
  }); } },
  { name: 'asset-url-external', setup(b) { b.onResolve({ filter: /\?url$/ }, a => ({ path: a.path, external: true })); } },
];
const bundle = async (contents, format) => (await build({
  stdin: { contents, resolveDir: root, loader: 'js' }, bundle: true, platform: 'node', format, target: 'node22', write: false, logLevel: 'error', plugins,
})).outputFiles[0].text;

const dir = mkdtempSync(join(tmpdir(), 'step-bench-'));
const mainFile = join(dir, 'main.mjs'), workerFile = join(dir, 'thread.cjs');
writeFileSync(mainFile, await bundle(`export { loadStepReader } from './packages/io/src/stepModule.ts'; export { readStep } from './packages/io/src/step.ts';`, 'esm'));
writeFileSync(workerFile, await bundle(`
  const { parentPort } = require('node:worker_threads');
  const { runStepThread } = require('./packages/io/src/stepThreads.ts');
  runStepThread({ post: m => parentPort.postMessage(m), onMessage: h => parentPort.on('message', h) });`, 'cjs'));

const makeWorker = () => {
  const worker = new Worker(workerFile);
  return { post: m => worker.postMessage(m), onMessage: h => { worker.on('message', h); worker.on('error', e => h({ type: 'error', message: e.message })); }, terminate: () => worker.terminate() };
};

try {
  // The bundle runs from a temporary directory, so the module is named outright.
  process.env.PF_STEP_WASM = join(root, 'packages/io/wasm', threads > 0 ? 'pushform-step-threads.wasm' : 'pushform-step.wasm');
  const { loadStepReader, readStep } = await import(pathToFileURL(mainFile).href);
  const bytes = readFileSync(file);
  const t0 = performance.now();
  const stamp = () => `${String(Math.round(performance.now() - t0)).padStart(7)} ms`;
  const m = await loadStepReader({ threads: threads > 0 ? { count: threads, makeWorker } : false });
  console.log(`${stamp()}  module loaded, threads: ${m.threads ? m.threads.count : 'none'}`);
  let last = '';
  const scene = await readStep(new Uint8Array(bytes), p => {
    const key = `${p.stage}:${p.current === p.total || p.current === 0 || p.current % 100 === 0}`;
    if (p.current === 0 || p.current === p.total || p.current % 200 === 0) { if (key !== last || p.current === p.total) console.log(`${stamp()}  ${p.stage} ${p.current}/${p.total} ${p.detail ?? ''}`); last = key; }
  }, 1 << 30);
  let parts = 0, triangles = 0;
  for (const def of [scene.root, ...scene.definitions.values()]) for (const part of def.meshParts ?? []) { parts++; triangles += part.geometry.triangles.length / 3; }
  console.log(`${stamp()}  done: ${parts} mesh parts, ${triangles.toLocaleString('en-US')} triangles, ${scene.definitions.size} definitions, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
} catch (cause) {
  console.error(cause);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
  process.exit();
}
