// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** How a fresh instance of the Rust kernel's WebAssembly module is created in this process. */
import type { RustKernelModule } from '../wasm/pushform-kernel.js';

export type RustKernelModuleFactory = (options?: object) => Promise<RustKernelModule>;

let factoryOverride: RustKernelModuleFactory | undefined;

/** Replaces how the Rust module is created (tests compile it once and instantiate per backend). `undefined` restores the default. */
export function setRustKernelModuleFactory(factory: RustKernelModuleFactory | undefined): void {
  factoryOverride = factory;
}

/** Creates one instance of the Rust module, with its own linear memory. */
export async function createRustKernelModule(options?: object): Promise<RustKernelModule> {
  if (factoryOverride !== undefined) return factoryOverride(options);
  let factory: RustKernelModuleFactory;
  try {
    factory = (await import('../wasm/pushform-kernel.js')).default;
  } catch (cause) {
    throw new Error('The kernel module is missing: run `pnpm build:kernel-wasm` first.', { cause });
  }
  return factory(options);
}
