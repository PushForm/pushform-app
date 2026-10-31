// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COMPUTE_ABI_VERSION, computeModuleProblems, inspectWasmModule } from '@pushform/extension-protocol/wasm';

/**
 * The inside of a compute worker: one WebAssembly module, instantiated under the compute ABI with a memory the
 * worker creates at the declared maximum, then run on inputs the host sends. The worker has no other job, so the
 * host can end it at any moment, and it reports only the module's own progress, partial results and output.
 *
 * Messages, all on one port:
 * - in: `{ type: 'init', module, maxPages, softMs }`, then `{ type: 'run', id, input }` (input as an ArrayBuffer);
 * - out: `{ type: 'ready' }` or `{ type: 'failed', message }`; per run `{ type: 'progress', id, value }`,
 *   `{ type: 'partial', id, data }` and finally `{ type: 'result', id, output }` or `{ type: 'error', id, message }`.
 *
 * `pf.should_stop()` turns true once `softMs` has passed since the run began: a running module cannot receive
 * messages, so a time budget is how it learns to return its best result before the host's hard limit ends it.
 */

export interface ComputePort {
  post(message: unknown, transfer?: Transferable[]): void;
  listen(handler: (message: unknown) => void): void;
}

/** Limits on what a module may report during one run. */
export const COMPUTE_REPORT_LIMITS = {
  /** Largest output or partial result, in bytes. */
  outputBytes: 4 * 1024 * 1024,
  /** Shortest interval between progress reports, and between partial results. */
  progressMs: 50,
  partialMs: 200,
} as const;

interface Exports {
  pf_abi_version(): number;
  pf_alloc(length: number): number;
  pf_run(pointer: number, length: number): number;
}

export function runComputeWorker(port: ComputePort): void {
  let exports: Exports | null = null;
  let memory: WebAssembly.Memory | null = null;
  let softMs = Infinity;
  let run: { id: number; started: number; lastProgress: number; lastPartial: number } | null = null;

  const copyOut = (pointer: number, length: number): ArrayBuffer | null => {
    const buffer = memory!.buffer;
    if (length < 0 || length > COMPUTE_REPORT_LIMITS.outputBytes || pointer < 0 || pointer + length > buffer.byteLength) return null;
    return buffer.slice(pointer, pointer + length);
  };

  const imports = {
    pf: {
      progress(fraction: number) {
        if (!run || !Number.isFinite(fraction)) return;
        const now = performance.now();
        if (now - run.lastProgress < COMPUTE_REPORT_LIMITS.progressMs) return;
        run.lastProgress = now;
        port.post({ type: 'progress', id: run.id, value: Math.min(1, Math.max(0, fraction)) });
      },
      partial(pointer: number, length: number) {
        if (!run) return;
        const now = performance.now();
        if (now - run.lastPartial < COMPUTE_REPORT_LIMITS.partialMs) return;
        const data = copyOut(pointer, length);
        if (!data) return;
        run.lastPartial = now;
        port.post({ type: 'partial', id: run.id, data }, [data]);
      },
      should_stop() {
        return run && performance.now() - run.started >= softMs ? 1 : 0;
      },
    },
  };

  port.listen(async (raw) => {
    const message = raw as { type?: string; id?: number; module?: ArrayBuffer; maxPages?: number; softMs?: number; input?: ArrayBuffer };
    if (message.type === 'init' && !exports && message.module && typeof message.maxPages === 'number') {
      try {
        const bytes = new Uint8Array(message.module);
        const problems = computeModuleProblems(bytes, message.maxPages);
        if (problems.length) throw new Error(problems[0]);
        const requested = inspectWasmModule(bytes).imports.find((i) => i.module === 'pf' && i.name === 'memory')?.memory?.min ?? 1;
        const minimum = Math.min(message.maxPages, Math.max(1, requested));
        memory = new WebAssembly.Memory({ initial: minimum, maximum: message.maxPages });
        // Only the four ABI imports exist; a module asking for anything else fails to instantiate.
        const { instance } = await WebAssembly.instantiate(bytes, { pf: { memory, progress: imports.pf.progress, partial: imports.pf.partial, should_stop: imports.pf.should_stop } });
        const candidate = instance.exports as unknown as Exports;
        if (candidate.pf_abi_version() !== COMPUTE_ABI_VERSION) throw new Error(`it implements compute interface ${candidate.pf_abi_version()}, not ${COMPUTE_ABI_VERSION}`);
        exports = candidate;
        softMs = typeof message.softMs === 'number' && message.softMs > 0 ? message.softMs : Infinity;
        port.post({ type: 'ready' });
      } catch (error) {
        port.post({ type: 'failed', message: describe(error) });
      }
      return;
    }
    if (message.type === 'run' && typeof message.id === 'number' && message.input instanceof ArrayBuffer) {
      const id = message.id;
      if (!exports || run) {
        port.post({ type: 'error', id, message: exports ? 'The module is already running.' : 'The module is not loaded.' });
        return;
      }
      run = { id, started: performance.now(), lastProgress: -Infinity, lastPartial: -Infinity };
      try {
        const input = new Uint8Array(message.input);
        const pointer = exports.pf_alloc(input.byteLength);
        if (pointer < 0 || pointer + input.byteLength > memory!.buffer.byteLength) throw new Error('pf_alloc returned memory outside the module.');
        new Uint8Array(memory!.buffer, pointer, input.byteLength).set(input);
        const out = exports.pf_run(pointer, input.byteLength) >>> 0;
        if (out + 4 > memory!.buffer.byteLength) throw new Error('pf_run returned a pointer outside the module memory.');
        const length = new DataView(memory!.buffer).getUint32(out, true);
        if (length > COMPUTE_REPORT_LIMITS.outputBytes) throw new Error(`The output is larger than ${COMPUTE_REPORT_LIMITS.outputBytes} bytes.`);
        const output = copyOut(out + 4, length);
        if (!output) throw new Error('The output lies outside the module memory.');
        port.post({ type: 'result', id, output }, [output]);
      } catch (error) {
        port.post({ type: 'error', id, message: describe(error) });
      } finally {
        run = null;
      }
    }
  });
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : String(error)).slice(0, 500);

