// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OcctModule } from 'occt-import-js';

/**
 * Lazy, memoized loading of the STEP reader (occt-import-js: OpenCascade compiled to wasm, LGPL-2.1). It is a
 * separately loaded module: nothing imports it until a STEP file is read, so the wasm downloads only then.
 *
 * Node (vitest, CLI) reads the wasm next to the package's script with `fs`. In the browser and the desktop webview the
 * import worker is a module worker, which Emscripten's environment check does not recognize, so the wasm is fetched
 * here from the URL Vite gives the bundled file and handed over as bytes.
 */
let modulePromise: Promise<OcctModule> | undefined;

export function loadStepReader(): Promise<OcctModule> {
  modulePromise ??= (async () => {
    const { default: init } = await import('occt-import-js');
    if (typeof process !== 'undefined' && process.versions?.node) return init();
    const { default: wasmUrl } = await import('occt-import-js/dist/occt-import-js.wasm?url');
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`The STEP reader could not be downloaded (${response.status}).`);
    return init({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
  })();
  modulePromise.catch(() => { modulePromise = undefined; });
  return modulePromise;
}
