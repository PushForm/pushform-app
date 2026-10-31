#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global process */
// pushform-mcp. Workspace packages export TypeScript sources, which Node cannot run, so
// this launcher bundles src/cli.ts with esbuild into a temporary module and runs it. manifold-3d
// stays external, loaded from where the kernel resolves it, so its WASM file is found beside it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const kernelDir = join(here, '../../kernel/src');
const ioDir = join(here, '../../io/src');

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
      name: 'manifold-external',
      setup(b) {
        b.onResolve({ filter: /^manifold-3d$/ }, async (args) => {
          if (args.pluginData === 'inner') return undefined;
          // resolve as the kernel would (import conditions), then load that file at run time
          const r = await b.resolve('manifold-3d', { kind: 'import-statement', resolveDir: kernelDir, pluginData: 'inner' });
          if (r.errors.length) return { errors: r.errors };
          return { path: pathToFileURL(r.path).href, external: true };
        });
      },
    },
    {
      // The STEP reader finds its wasm beside its own script, so it stays external like manifold-3d. Its `?url`
      // import only runs in a browser.
      name: 'step-reader-external',
      setup(b) {
        b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, external: true }));
        b.onResolve({ filter: /^occt-import-js$/ }, async (args) => {
          if (args.pluginData === 'inner') return undefined;
          const r = await b.resolve('occt-import-js', { kind: 'import-statement', resolveDir: ioDir, pluginData: 'inner' });
          if (r.errors.length) return { errors: r.errors };
          return { path: pathToFileURL(r.path).href, external: true };
        });
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
