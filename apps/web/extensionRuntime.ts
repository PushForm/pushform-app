// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Serves the extension worker bootstrap as a string, `import workerSource from 'virtual:pushform-extension-worker'`.
 * The runtime starts it from a blob URL inside a sandboxed frame, where Chromium accepts only classic workers, so it
 * is bundled here as one classic script rather than by Vite's worker pipeline, which emits ES modules.
 */
export const EXTENSION_WORKER_MODULE = 'virtual:pushform-extension-worker';
const RESOLVED = `\0${EXTENSION_WORKER_MODULE}`;
export const WORKER_BOOTSTRAP_ENTRY = fileURLToPath(new URL('../../packages/extensions/src/runtime/web/workerBootstrap.ts', import.meta.url));

/** The worker bootstrap bundled as a minified classic script. */
export async function bundleWorkerBootstrap(): Promise<{ source: string; inputs: string[] }> {
  const result = await build({
    entryPoints: [WORKER_BOOTSTRAP_ENTRY], bundle: true, format: 'iife', minify: true, write: false, metafile: true,
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
      const { source, inputs } = await bundleWorkerBootstrap();
      for (const input of inputs) this.addWatchFile(fileURLToPath(new URL(input, `file://${process.cwd()}/`)));
      return `export default ${JSON.stringify(source)};`;
    },
  };
}
