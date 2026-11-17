// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * What failures inside the Rust kernel's WebAssembly module look like from JavaScript, using the build with requests
 * that fail on purpose (`node scripts/build-kernel-wasm.mjs --faults`). Skipped when that build is missing. The
 * out-of-memory paths need several gigabytes and are checked in real browsers instead.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RustKernelModule } from '../../wasm/pushform-kernel.js';
import { RustKernelCaller, RustKernelRejection } from '../worker/rustKernelCore';

const modulePath = resolve(__dirname, '../../wasm/pushform-kernel-faults.js');
const fault = (kind: number): Uint8Array => new Uint8Array([0xf0, kind]);
const PANIC = 1, CXX_EXCEPTION = 3, ABORT = 6;

async function load(): Promise<RustKernelCaller> {
  const { default: create } = (await import(/* @vite-ignore */ modulePath)) as { default: (options?: object) => Promise<RustKernelModule> };
  return new RustKernelCaller(await create({ printErr: () => undefined }));
}

describe.skipIf(!existsSync(modulePath))('faults in the Rust kernel WebAssembly module', () => {
  it('answers a panic as an Internal kernel error and keeps working', async () => {
    const caller = await load();
    let error: unknown;
    try {
      caller.call(fault(PANIC));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RustKernelRejection);
    expect(JSON.parse((error as RustKernelRejection).info)).toMatchObject({ code: 'Internal', message: 'fault injection: panic in the kernel' });
    expect(() => caller.call(new Uint8Array(4))).toThrow(RustKernelRejection);
  });

  it('traps on a C++ exception, which Rust cannot catch, rather than answering', async () => {
    const caller = await load();
    let error: unknown;
    try {
      caller.call(fault(CXX_EXCEPTION));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(error).not.toBeInstanceOf(RustKernelRejection);
  });

  it('traps on an abort', async () => {
    const caller = await load();
    expect(() => caller.call(fault(ABORT))).toThrow(WebAssembly.RuntimeError);
  });
});
