// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Replays the golden corpus through the Rust kernel and requires every answer to match bit for bit: the permanent record
 * of the results the kernel has to keep producing. The native build is compared too when its test binary exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeGoldenCorpus, type GoldenRecord } from './goldenCorpus';
import { HarnessTransport } from './differentialFixtures';
import type { RustKernelModule } from '../../wasm/pushform-kernel.js';
import { RustKernelCaller, RustKernelRejection, trapErrorInfo } from '../worker/rustKernelCore';

const corpusPath = resolve(__dirname, '../../goldens/kernel-corpus.bin.br');
const modulePath = resolve(__dirname, '../../wasm/pushform-kernel.js');
const wasmPath = resolve(__dirname, '../../wasm/pushform_kernel.wasm');
const harnessPath = process.env.PF_KERNEL_HARNESS ?? resolve(__dirname, '../../../../crates/native-kernel/target/release/pushform-native-kernel-harness');

type Answer = { ok: true; bytes: Uint8Array } | { ok: false; info: string };

function firstDifference(a: Uint8Array, b: Uint8Array): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `byte ${i} of ${n}: ${a[i]} vs ${b[i]}`;
  return `length ${a.length} vs ${b.length}`;
}

/** Where a replayed answer differs from the record, or undefined when it matches exactly. */
function difference(record: GoldenRecord, answer: Answer): string | undefined {
  const { outcome } = record;
  if (outcome.kind === 'error') {
    if (answer.ok) return `expected the error ${outcome.info} but got a result`;
    return answer.info === outcome.info ? undefined : `error ${answer.info} differs from ${outcome.info}`;
  }
  if (!answer.ok) return `expected a result but got ${answer.info}`;
  if (outcome.kind === 'stats') {
    const cached = new Uint32Array(answer.bytes.buffer.slice(answer.bytes.byteOffset, answer.bytes.byteOffset + 8))[1]!;
    return cached === outcome.cached ? undefined : `cached ${cached} vs ${outcome.cached}`;
  }
  return Buffer.compare(answer.bytes, outcome.response) === 0 ? undefined : firstDifference(answer.bytes, outcome.response);
}

function replay(records: readonly GoldenRecord[], call: (request: Uint8Array, index: number) => Answer): void {
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const answer = call(record.request, i);
    const diff = difference(record, answer);
    if (diff !== undefined) {
      const op = new DataView(record.request.buffer, record.request.byteOffset).getUint32(0, true);
      expect.fail(`record ${i} (kernel op ${op}) differs from the corpus: ${diff}`);
    }
  }
}

describe.skipIf(!existsSync(corpusPath))('the golden corpus', () => {
  const records = (): GoldenRecord[] => decodeGoldenCorpus(readFileSync(corpusPath));

  it('the Rust WebAssembly module reproduces every recorded answer exactly', async () => {
    const factory = ((await import(/* @vite-ignore */ modulePath)) as { default: (options?: object) => Promise<RustKernelModule> }).default;
    const compiled = new WebAssembly.Module(readFileSync(wasmPath));
    const module = await factory({
      instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
        done(new WebAssembly.Instance(compiled, imports), compiled);
        return {};
      },
    });
    const caller = new RustKernelCaller(module);
    const corpus = records();
    expect(corpus.length).toBeGreaterThan(1000);
    replay(corpus, (request) => {
      try {
        return { ok: true, bytes: new Uint8Array(caller.call(request)) };
      } catch (e) {
        if (e instanceof RustKernelRejection) return { ok: false, info: e.info };
        throw new Error(trapErrorInfo(e));
      }
    });
  }, 120000);

  it.skipIf(!existsSync(harnessPath))('the native build reproduces them too', async () => {
    const harness = new HarnessTransport(harnessPath);
    harness.start();
    try {
      const corpus = records();
      for (let i = 0; i < corpus.length; i++) {
        const record = corpus[i]!;
        let answer: Answer;
        try {
          answer = { ok: true, bytes: new Uint8Array(await harness.call(record.request)) };
        } catch (e) {
          answer = { ok: false, info: String(e) };
        }
        const diff = difference(record, answer);
        if (diff !== undefined) expect.fail(`record ${i} differs from the corpus: ${diff}`);
      }
    } finally {
      harness.stop();
    }
  }, 300000);

  it('a one-bit change in a recorded answer is caught', () => {
    const [first] = records().filter((r) => r.outcome.kind === 'ok');
    const expected = first!.outcome as Extract<GoldenRecord['outcome'], { kind: 'ok' }>;
    const tampered = new Uint8Array(expected.response);
    tampered[tampered.length - 1]! ^= 1;
    expect(difference(first!, { ok: true, bytes: tampered })).toContain('byte');
    expect(difference(first!, { ok: true, bytes: expected.response })).toBeUndefined();
  });

  it('corpus entries that fail carry a kernel error with a code and message', () => {
    for (const record of records()) {
      if (record.outcome.kind !== 'error') continue;
      const info = JSON.parse(record.outcome.info) as { code?: unknown; message?: unknown };
      expect(typeof info.code).toBe('string');
      expect(typeof info.message).toBe('string');
    }
  });
});
