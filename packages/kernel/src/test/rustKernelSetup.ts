// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Vitest setup for `PF_KERNEL=rust`: every `InlineBackend` in the suite runs on the Rust kernel's WebAssembly module
 * instead of the TypeScript kernel. Needs `pnpm build:kernel-wasm`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NativeKernelBackend } from '../backends/NativeKernelBackend';
import { setInlineKernelFactory } from '../backends/InlineBackend';
import { InlineRustTransport, type RustModuleFactory } from '../backends/differentialFixtures';

const modulePath = resolve(__dirname, '../../wasm/pushform-kernel.js');
if (!existsSync(modulePath)) throw new Error('PF_KERNEL=rust needs the kernel module: run pnpm build:kernel-wasm');

const factory = ((await import(/* @vite-ignore */ modulePath)) as { default: RustModuleFactory }).default;
// Compiled once per test file: each backend still gets its own instance and memory.
const compiled = new WebAssembly.Module(readFileSync(resolve(__dirname, '../../wasm/pushform_kernel.wasm')));
const instantiate: RustModuleFactory = (options) =>
  factory({
    ...options,
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      done(new WebAssembly.Instance(compiled, imports), compiled);
      return {};
    },
  });

setInlineKernelFactory(() => new NativeKernelBackend(undefined, new InlineRustTransport(instantiate), { fallback: false }));
