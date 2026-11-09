// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Stands in for `rustWasm.ts` in a build without the Rust kernel, so that build never bundles the module's worker and
 * needs no Emscripten output. See the app's Vite config.
 */
export function createRustWasmBackend(): never {
  throw new Error('This build does not include the Rust kernel');
}

export function validateSolidWithRust(): never {
  throw new Error('This build does not include the Rust kernel');
}
