#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global process */
// pushform-mcp. Workspace packages export TypeScript sources, which Node cannot run, so
// this launcher bundles src/cli.ts with esbuild into a temporary module and runs it. The Rust kernel's
// WebAssembly glue stays external, loaded from where the kernel resolves it, so its WASM file is found beside it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, '../src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'kernel-wasm-external',
      setup(b) {
        b.onResolve({ filter: /pushform-kernel\.js$/ }, (args) => ({ path: pathToFileURL(join(dirname(args.importer), args.path)).href, external: true }));
      },
    },
    {
      // The bundle runs from a temporary directory, so a workspace source's `new URL('./asset', import.meta.url)`
      // (the material library's textures) must keep pointing beside that source file.
      name: 'source-import-meta-url',
      setup(b) {
        b.onLoad({ filter: /[\\/]packages[\\/][^\\/]+[\\/]src[\\/].*\.ts$/ }, (args) => {
          const text = readFileSync(args.path, 'utf8');
          if (!text.includes('import.meta.url')) return undefined;
          return { contents: text.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)), loader: 'ts' };
        });
      },
    },
    {
      // `?url` imports (the STEP reader's wasm) only run in a browser; Node reads the file beside the package.
      name: 'asset-url-external',
      setup(b) {
        b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});

const dir = mkdtempSync(join(tmpdir(), 'pushform-mcp-'));
const file = join(dir, 'cli.mjs');
writeFileSync(file, result.outputFiles[0].text);
try {
  const { main } = await import(pathToFileURL(file).href);
  process.exitCode = await main(process.argv.slice(2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
