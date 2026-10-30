// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Lazy, memoized initialisation of the manifold-3d wasm module.
 *
 * Node (vitest, CLI): `manifold.js` resolves `manifold.wasm` next to itself through
 * `new URL('manifold.wasm', import.meta.url)` and reads it with `fs`; nothing to configure.
 *
 * Browser / Vite worker: the same `new URL(..., import.meta.url)` pattern is understood by Vite, which
 * copies the wasm into the asset graph when `manifold-3d` is bundled. Two things to keep in mind:
 *  - add `optimizeDeps: { exclude: ['manifold-3d'] }` to the app's Vite config; the dev-server
 *    pre-bundler (esbuild) does not rewrite `import.meta.url`, so without it the worker 404s on the wasm;
 *  - the worker must be created with `{ type: 'module' }` (see `backends/WorkerBackend.ts`) so the
 *    dynamic import below works inside it.
 * If a host still cannot locate the file, pass `{ locateFile: () => wasmUrl }` with
 * `import wasmUrl from 'manifold-3d/manifold.wasm?url'`.
 */
import type { ManifoldToplevel } from 'manifold-3d';

let modulePromise: Promise<ManifoldToplevel> | undefined;

/** Load (once) and set up manifold-3d. Safe to call repeatedly; returns the same instance. */
export function loadManifold(): Promise<ManifoldToplevel> {
  modulePromise ??= (async () => {
    const { default: Module } = await import('manifold-3d');
    const wasm = await Module();
    wasm.setup();
    return wasm;
  })();
  return modulePromise;
}
