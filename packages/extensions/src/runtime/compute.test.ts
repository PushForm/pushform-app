// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionError, computeModuleProblems, extensionManifestSchema } from '@pushform/extension-protocol';
import { ComputeHost, type ComputeWorkerHandle, type SpawnComputeWorker } from './compute';
import { runComputeWorker } from './computeWorker';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession } from './host';
import { messagePortTransport } from './port';
import { lockDownRuntime } from './web/lockdown';
import { MODULES, wat } from './wat.testing';

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A compute worker running in this thread over a MessageChannel; terminate closes the channel. */
const inProcess: SpawnComputeWorker = async () => {
  const channel = new MessageChannel();
  channels.push(channel);
  runComputeWorker({
    post: (message, transfer) => channel.port2.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port2.onmessage = (e) => handler(e.data); },
  });
  return {
    post: (message, transfer) => channel.port1.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port1.onmessage = (e) => handler(e.data); },
    terminate: () => { channel.port1.close(); channel.port2.close(); },
  };
};

/** A worker that loads but never answers a run, as a hung module does. */
function hanging(): { spawn: SpawnComputeWorker; terminated: () => number } {
  let terminated = 0;
  return {
    terminated: () => terminated,
    spawn: async () => {
      let handler: (message: unknown) => void = () => {};
      const handle: ComputeWorkerHandle = {
        post: (message) => { if ((message as { type: string }).type === 'init') queueMicrotask(() => handler({ type: 'ready' })); },
        listen: (h) => { handler = h; },
        terminate: () => { terminated++; },
      };
      return handle;
    },
  };
}

type Compute = { run(input: unknown, options?: { signal?: AbortSignal; onProgress?: (u: { value: number | null; partial?: unknown }) => void }): Promise<unknown> };
type Wasm = { load(input: unknown): Promise<{ instance: string }>; call(input: unknown): Promise<unknown>; unload(input: unknown): Promise<unknown> };

async function setup(source: string, options: { maxPages?: number; timeoutMs?: number; spawn?: SpawnComputeWorker; maxWorkers?: number } = {}) {
  const bytes = await wat(source);
  const manifest = extensionManifestSchema.parse({
    id: 'com.example.pack', name: 'Pack', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
    defaultLocale: 'en', license: 'MIT', files: {}, permissions: [],
    contributions: [{ target: 'model.command', id: 'com.example.pack.run', name: 'Run' }],
    wasm: [{ name: 'solver', file: 'solver.wasm', maxMemoryPages: options.maxPages ?? 4, timeoutMs: options.timeoutMs ?? 5000 }],
  });
  const compute = new ComputeHost({ manifest, files: new Map([['solver.wasm', bytes]]), spawn: options.spawn ?? inProcess, maxWorkers: options.maxWorkers ?? 2 });
  const channel = new MessageChannel();
  channels.push(channel);
  const session = new ExtensionSession({ manifest, grants: [], port: messagePortTransport(channel.port1), services: compute.services() });
  let context!: ExtensionContext;
  void startGuest(messagePortTransport(channel.port2), async () => ({ activate(c: ExtensionContext) { context = c; } }));
  await session.activate();
  return { compute: context.compute as Compute, wasm: context.wasm as Wasm, host: compute, bytes };
}

const failureOf = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('compute modules', () => {
  it('follow the compute interface, and modules with other imports are refused', async () => {
    expect(computeModuleProblems(await wat(MODULES.echo), 4)).toEqual([]);
    expect(computeModuleProblems(await wat(MODULES.fetches), 4)).toContain('it imports env.fetch, which the compute interface does not provide');
    expect(computeModuleProblems(await wat('(module (memory 1))'), 4)).toEqual(expect.arrayContaining([
      'it must import its memory as pf.memory', 'it does not export the function pf_run']));
  });
});

describe('compute.run', () => {
  it('runs a JSON job in a worker, reporting progress and the partial result', async () => {
    const { compute } = await setup(MODULES.echo);
    const updates: unknown[] = [];
    const out = await compute.run({ module: 'solver', json: { sheets: 3, parts: ['A', 'B'] } }, { onProgress: (u) => updates.push(u) });
    expect(out).toEqual({ sheets: 3, parts: ['A', 'B'] });
    expect(updates).toEqual([{ value: 0.5 }, { value: null, partial: { sheets: 3, parts: ['A', 'B'] } }]);
  });

  it('returns bytes for byte input', async () => {
    const { compute } = await setup(MODULES.echo);
    expect(await compute.run({ module: 'solver', data: new Uint8Array([1, 2, 3]) })).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('caps memory at the declared maximum', async () => {
    const { compute } = await setup(MODULES.grow, { maxPages: 2 });
    const out = await compute.run({ module: 'solver', data: new Uint8Array() }) as Uint8Array;
    expect(new DataView(out.buffer, out.byteOffset).getInt32(0, true)).toBe(-1);
  });

  it('tells the module to stop before its time limit so it can return its best result', async () => {
    const { compute } = await setup(MODULES.soft, { timeoutMs: 300 });
    const started = performance.now();
    expect(await compute.run({ module: 'solver', json: null })).toBe('best');
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('ends a module that runs past its time limit and answers limit.exceeded', async () => {
    const worker = hanging();
    const { compute } = await setup(MODULES.echo, { timeoutMs: 100, spawn: worker.spawn });
    expect((await failureOf(compute.run({ module: 'solver', json: 1 }))).code).toBe('limit.exceeded');
    expect(worker.terminated()).toBe(1);
  });

  it('ends the worker when the extension cancels', async () => {
    const worker = hanging();
    const { compute } = await setup(MODULES.echo, { spawn: worker.spawn });
    const controller = new AbortController();
    const running = compute.run({ module: 'solver', json: 1 }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect((await failureOf(running)).code).toBe('cancelled');
    await vi.waitFor(() => expect(worker.terminated()).toBe(1));
  });

  it('limits concurrent jobs', async () => {
    const worker = hanging();
    const { compute } = await setup(MODULES.echo, { spawn: worker.spawn, maxWorkers: 1, timeoutMs: 200 });
    const first = compute.run({ module: 'solver', json: 1 }).catch((e: ExtensionError) => e.code);
    await new Promise((r) => setTimeout(r, 20));
    expect((await failureOf(compute.run({ module: 'solver', json: 2 }))).code).toBe('limit.exceeded');
    expect(await first).toBe('limit.exceeded');
  });

  it('refuses undeclared modules, mixed input, output that is not JSON, and modules that break the interface', async () => {
    const { compute } = await setup(MODULES.notJson);
    expect((await failureOf(compute.run({ module: 'other', json: 1 }))).code).toBe('validation.failed');
    expect((await failureOf(compute.run({ module: 'solver', json: 1, data: new Uint8Array() }))).code).toBe('validation.failed');
    expect((await failureOf(compute.run({ module: 'solver', json: 1 }))).message).toMatch(/not valid JSON/);
    const bad = await setup(MODULES.fetches);
    expect((await failureOf(bad.compute.run({ module: 'solver', json: 1 }))).message).toMatch(/could not start: .*env\.fetch/);
  });
});

describe('wasm.load', () => {
  it('keeps a module loaded across calls until it is unloaded', async () => {
    const { wasm } = await setup(MODULES.counter);
    const { instance } = await wasm.load({ module: 'solver' });
    expect(await wasm.call({ instance, data: new Uint8Array() })).toEqual(new Uint8Array([1]));
    expect(await wasm.call({ instance, data: new Uint8Array() })).toEqual(new Uint8Array([2]));
    await wasm.unload({ instance });
    expect((await failureOf(wasm.call({ instance, data: new Uint8Array() }))).message).toMatch(/no loaded module/);
  });
});

describe('extension runtime lockdown', () => {
  it('removes WebAssembly from the extension runtime, so only declared modules ever compile', () => {
    const scope = { WebAssembly: { compile: () => {} }, URL: { createObjectURL: () => '' } } as Record<string, unknown>;
    lockDownRuntime(scope);
    expect(scope.WebAssembly).toBeUndefined();
  });
});
