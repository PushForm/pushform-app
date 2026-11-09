// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Vitest setup: every `InlineBackend` in the suite compiles the Rust kernel's WebAssembly module once per test file and
 * instantiates its own copy, each with its own memory. Needs the module (see the error thrown when it is missing).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setRustKernelModuleFactory, type RustKernelModuleFactory } from '../rustKernelModule';

const modulePath = resolve(__dirname, '../../wasm/pushform-kernel.js');
if (!existsSync(modulePath)) throw new Error('The test suite needs the kernel module: run pnpm build:kernel-wasm');

const factory = ((await import(/* @vite-ignore */ modulePath)) as { default: RustKernelModuleFactory }).default;
// Compiled once per test file: each backend still gets its own instance and memory.
const compiled = new WebAssembly.Module(readFileSync(resolve(__dirname, '../../wasm/pushform_kernel.wasm')));
const instantiate: RustKernelModuleFactory = (options) =>
  factory({
    ...options,
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      done(new WebAssembly.Instance(compiled, imports), compiled);
      return {};
    },
  });

setRustKernelModuleFactory(instantiate);
