// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { instantiateStepReader, type StepReaderModule } from './stepWasm';

/**
 * Lazy, memoized loading of the STEP reader module (`packages/io/wasm/pushform-step.wasm`, built from
 * `crates/step-reader` by `pnpm build:step-reader`). Nothing imports it until a STEP file is read, so the wasm
 * downloads only then. Node (vitest, the headless MCP server) reads the file beside the package; the browser and the
 * desktop webview fetch the URL Vite gives the bundled file.
 */
let modulePromise: Promise<StepReaderModule> | undefined;

export function loadStepReader(): Promise<StepReaderModule> {
  modulePromise ??= (async () => {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      // PF_STEP_WASM points tests and experiments at another build of the module.
      const bytes = await readFile(process.env.PF_STEP_WASM ?? new URL('../wasm/pushform-step.wasm', import.meta.url)).catch(() => {
        throw new Error('The STEP reader is not built: run pnpm build:step-reader.');
      });
      return instantiateStepReader(bytes);
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
