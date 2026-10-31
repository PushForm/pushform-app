// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { COMPUTE_MODULE } from './package.test.ts';
import { computeModuleProblems, inspectWasmModule } from './wasm.ts';

describe('inspectWasmModule', () => {
  it('reads imports with memory limits and exports', () => {
    const info = inspectWasmModule(COMPUTE_MODULE);
    expect(info.imports).toEqual([{ module: 'pf', name: 'memory', kind: 'memory', memory: { min: 1, max: null, shared: false } }]);
    expect(info.exports.map((e) => e.name)).toEqual(['pf_abi_version', 'pf_alloc', 'pf_run']);
  });

  it('rejects data that is not a module or is cut short', () => {
    expect(() => inspectWasmModule(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a WebAssembly module/);
    expect(() => inspectWasmModule(COMPUTE_MODULE.subarray(0, 40))).toThrow(/truncated/);
  });
});

describe('computeModuleProblems', () => {
  it('accepts a conforming module and checks its memory against the declared maximum', () => {
    expect(computeModuleProblems(COMPUTE_MODULE, 16)).toEqual([]);
    expect(computeModuleProblems(COMPUTE_MODULE, 0)[0]).toMatch(/needs 1 memory pages at start/);
  });
});
