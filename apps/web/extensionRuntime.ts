// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Serves the extension worker bootstraps as strings: `import workerSource, { computeSource } from
 * 'virtual:pushform-extension-worker'`. The runtime starts them from blob URLs inside a sandboxed frame, where
 * Chromium accepts only classic workers, so they are bundled here as classic scripts rather than by Vite's worker
 * pipeline, which emits ES modules.
 */
export const EXTENSION_WORKER_MODULE = 'virtual:pushform-extension-worker';
const RESOLVED = `\0${EXTENSION_WORKER_MODULE}`;
export const WORKER_BOOTSTRAP_ENTRY = fileURLToPath(new URL('../../packages/extensions/src/runtime/web/workerBootstrap.ts', import.meta.url));
export const COMPUTE_BOOTSTRAP_ENTRY = fileURLToPath(new URL('../../packages/extensions/src/runtime/web/computeBootstrap.ts', import.meta.url));

/** A bootstrap bundled as a minified classic script; the extension worker's by default. */
export async function bundleWorkerBootstrap(entry: string = WORKER_BOOTSTRAP_ENTRY): Promise<{ source: string; inputs: string[] }> {
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'iife', minify: true, write: false, metafile: true,
    target: 'es2022', platform: 'browser', legalComments: 'none', logLevel: 'silent',
  });
  return { source: result.outputFiles[0]!.text, inputs: Object.keys(result.metafile.inputs) };
}

export function extensionWorkerPlugin(): Plugin {
  return {
    name: 'pushform-extension-worker',
    resolveId: (id) => (id === EXTENSION_WORKER_MODULE ? RESOLVED : null),
    async load(id) {
      if (id !== RESOLVED) return null;
      const [worker, compute] = await Promise.all([bundleWorkerBootstrap(), bundleWorkerBootstrap(COMPUTE_BOOTSTRAP_ENTRY)]);
      for (const input of [...worker.inputs, ...compute.inputs]) this.addWatchFile(fileURLToPath(new URL(input, `file://${process.cwd()}/`)));
      return `export default ${JSON.stringify(worker.source)};\nexport const computeSource = ${JSON.stringify(compute.source)};`;
    },
  };
}
