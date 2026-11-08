// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { RustWasmKernelTransport } from './RustWasmKernelTransport';
import type { RustKernelWorkerRequest, RustKernelWorkerResponse } from '../worker/rustKernel.worker';

class FakeWorker {
  onmessage: ((ev: MessageEvent<RustKernelWorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly sent: RustKernelWorkerRequest[] = [];
  terminated = false;
  postMessage(message: RustKernelWorkerRequest): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(response: RustKernelWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<RustKernelWorkerResponse>);
  }
  lastId(): number {
    return this.sent[this.sent.length - 1]!.id;
  }
}

function setup(): { transport: RustWasmKernelTransport; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const transport = new RustWasmKernelTransport({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
  return { transport, workers };
}

/** Lets a promise chain reach its next `await`. */
const tick = () => new Promise((resolve) => setTimeout(resolve));

async function loaded(): Promise<{ transport: RustWasmKernelTransport; workers: FakeWorker[]; worker: FakeWorker }> {
  const { transport, workers } = setup();
  const available = transport.available();
  await tick();
  const worker = workers[0]!;
  worker.reply({ id: worker.lastId(), ok: true, loadMs: 12 });
  await expect(available).resolves.toBe(true);
  return { transport, workers, worker };
}

describe('RustWasmKernelTransport', () => {
  it('answers a call from the worker and records the load time', async () => {
    const { transport, worker } = await loaded();
    expect(transport.loadMs).toBe(12);
    const pending = transport.call(new Uint8Array([1, 2, 3]));
    await tick();
    const buffer = new ArrayBuffer(4);
    worker.reply({ id: worker.lastId(), ok: true, response: buffer, memoryBytes: 1024 });
    await expect(pending).resolves.toBe(buffer);
    expect(transport.memoryBytes).toBe(1024);
  });

  it('rejects with the kernel error text the worker answered', async () => {
    const { transport, worker } = await loaded();
    const pending = transport.call(new Uint8Array([1]));
    await tick();
    worker.reply({ id: worker.lastId(), ok: false, error: '{"code":"ManifoldError","message":"nope"}' });
    await expect(pending).rejects.toBe('{"code":"ManifoldError","message":"nope"}');
  });

  it('reports the module unavailable when it cannot load', async () => {
    const { transport, workers } = setup();
    const available = transport.available();
    await tick();
    workers[0]!.reply({ id: workers[0]!.lastId(), ok: false, error: 'CompileError: bad module' });
    await expect(available).resolves.toBe(false);
  });

  it('terminates the worker on abort, rejects what was in flight and starts over on the next call', async () => {
    const { transport, workers, worker } = await loaded();
    const pending = transport.call(new Uint8Array([1]));
    await tick();
    await transport.abort();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toSatisfy((e: string) => JSON.parse(e).code === 'Aborted');
    const next = transport.call(new Uint8Array([2]));
    await tick();
    const fresh = workers[1]!;
    fresh.reply({ id: fresh.lastId(), ok: true, loadMs: 1 });
    await tick();
    fresh.reply({ id: fresh.lastId(), ok: true, response: new ArrayBuffer(0) });
    await expect(next).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('rejects what was in flight when the worker dies, and starts a new one for the next call', async () => {
    const { transport, workers, worker } = await loaded();
    const pending = transport.call(new Uint8Array([1]));
    await tick();
    worker.onerror?.({ message: 'worker lost' } as ErrorEvent);
    await expect(pending).rejects.toSatisfy((e: string) => JSON.parse(e).message === 'worker lost');
    const next = transport.call(new Uint8Array([2]));
    await tick();
    expect(workers).toHaveLength(2);
    const fresh = workers[1]!;
    fresh.reply({ id: fresh.lastId(), ok: true, loadMs: 1 });
    await tick();
    fresh.reply({ id: fresh.lastId(), ok: true, response: new ArrayBuffer(0) });
    await expect(next).resolves.toBeInstanceOf(ArrayBuffer);
  });
});
