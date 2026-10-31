// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createStepThreadPool, importedMemoryLimits, sharedStepMemory, type StepThreadWorker } from './stepThreads';
import { instantiateStepReader, type StepReaderModule } from './stepWasm';

/**
 * Lazy, memoized loading of the STEP reader module (`packages/io/wasm/pushform-step.wasm` and its threaded twin
 * `pushform-step-threads.wasm`, built from `crates/step-reader` by `pnpm build:step-reader`). Nothing imports it until
 * a STEP file is read, so the wasm downloads only then. Node (vitest, the headless MCP server) reads the file beside
 * the package; the browser and the desktop webview fetch the URL Vite gives the bundled file.
 *
 * The threaded build meshes parts on worker threads. It needs a shared memory, so the page must be cross-origin
 * isolated (the web app's headers make it so), and workers; otherwise, or when it fails to set up, the single-threaded
 * build is used.
 */
export interface StepThreadsOptions { count: number; makeWorker: () => StepThreadWorker }

let modulePromise: Promise<StepReaderModule> | undefined;

/** How many threads the reader may use here: the cores, at most 8; 0 where threads cannot run. */
export function stepThreadCount(): number {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined') return 0;
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) return 0;
  return Math.min(8, Math.max(1, navigator.hardwareConcurrency || 1));
}

function browserThreads(): StepThreadsOptions | undefined {
  const count = stepThreadCount();
  if (!count) return undefined;
  return { count, makeWorker: () => {
    const worker = new Worker(new URL('./stepThreadWorker.ts', import.meta.url), { type: 'module' });
    return { post: m => worker.postMessage(m), onMessage: h => { worker.onmessage = e => h(e.data); worker.onerror = e => h({ type: 'error', message: e.message || 'A STEP reader thread failed.' }); }, terminate: () => worker.terminate() };
  } };
}

async function instantiateThreaded(bytes: Uint8Array, module: WebAssembly.Module, threads: StepThreadsOptions): Promise<StepReaderModule> {
  const limits = importedMemoryLimits(bytes);
  if (!limits?.shared) throw new Error('The threaded STEP reader does not import a shared memory.');
  const memory = sharedStepMemory(limits);
  if (!memory) throw new Error('No shared memory large enough for the STEP reader.');
  const pool = createStepThreadPool(module, memory, threads.count, threads.makeWorker);
  return instantiateStepReader(module, pool);
}

/**
 * The reader module, loaded on the first call. `options.threads` (Node callers, tests) picks the threaded build with
 * the given workers; the browser decides from the page. Later calls return the module loaded first.
 */
export function loadStepReader(options?: { threads?: StepThreadsOptions | false }): Promise<StepReaderModule> {
  modulePromise ??= (async () => {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      const threads = options?.threads || undefined;
      // PF_STEP_WASM points tests and experiments at another build of the module.
      const file = process.env.PF_STEP_WASM ?? new URL(threads ? '../wasm/pushform-step-threads.wasm' : '../wasm/pushform-step.wasm', import.meta.url);
      const bytes = await readFile(file).catch(() => { throw new Error('The STEP reader is not built: run pnpm build:step-reader.'); });
      if (!threads) return instantiateStepReader(bytes);
      return instantiateThreaded(bytes, await WebAssembly.compile(bytes), threads);
    }
    const threads = options?.threads === false ? undefined : options?.threads ?? browserThreads();
    if (threads) {
      try {
        const { default: wasmUrl } = await import('../wasm/pushform-step-threads.wasm?url');
        const response = await fetch(wasmUrl);
        if (!response.ok) throw new Error(`The threaded STEP reader could not be downloaded (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const module = await instantiateThreaded(bytes, await WebAssembly.compile(bytes), threads);
        console.info(`STEP reader: ${threads.count} threads`);
        return module;
      } catch (cause) {
        console.warn('STEP reader: threads unavailable, reading single-threaded.', cause);
      }
    }
    const { default: wasmUrl } = await import('../wasm/pushform-step.wasm?url');
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`The STEP reader could not be downloaded (${response.status}).`);
    const module = typeof WebAssembly.compileStreaming === 'function' ? await WebAssembly.compileStreaming(response) : await WebAssembly.compile(await response.arrayBuffer());
    return instantiateStepReader(module);
  })();
  modulePromise.catch(() => { modulePromise = undefined; });
  return modulePromise;
}
