// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { KernelRequest, ResFor } from '../protocol';
import { DeferredBackend } from './DeferredBackend';
import type { KernelBackend, MeshProvider } from './KernelBackend';

class FakeBackend implements KernelBackend {
  readonly requests: KernelRequest[] = [];
  provider: MeshProvider | undefined;
  aborts = 0;
  disposed = false;
  request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    this.requests.push(req);
    return Promise.resolve({ ready: true } as unknown as ResFor<R>);
  }
  abortAll(): void {
    this.aborts++;
  }
  dispose(): void {
    this.disposed = true;
  }
  setMeshProvider(provider: MeshProvider | undefined): void {
    this.provider = provider;
  }
}

const init: KernelRequest = { type: 'init' };

function deferred(): { backend: DeferredBackend; finish: (b: FakeBackend) => void } {
  let finish!: (b: FakeBackend) => void;
  const pending = new Promise<KernelBackend>((resolve) => { finish = resolve; });
  return { backend: new DeferredBackend(() => pending), finish };
}

describe('DeferredBackend', () => {
  it('waits for the backend, then forwards requests and the mesh provider set before it loaded', async () => {
    const { backend, finish } = deferred();
    const provider: MeshProvider = () => undefined;
    backend.setMeshProvider(provider);
    const answer = backend.request(init);
    const inner = new FakeBackend();
    finish(inner);
    await expect(answer).resolves.toEqual({ ready: true });
    expect(inner.requests).toEqual([init]);
    expect(inner.provider).toBe(provider);
    backend.abortAll();
    expect(inner.aborts).toBe(1);
  });

  it('aborts a request still waiting for the load, and does not send it', async () => {
    const { backend, finish } = deferred();
    const answer = backend.request(init);
    backend.abortAll();
    const inner = new FakeBackend();
    finish(inner);
    await expect(answer).rejects.toMatchObject({ code: 'Aborted' });
    expect(inner.requests).toEqual([]);
  });

  it('disposes a backend that finishes loading after dispose', async () => {
    const { backend, finish } = deferred();
    const answer = backend.request(init);
    backend.dispose();
    const inner = new FakeBackend();
    finish(inner);
    await expect(answer).rejects.toMatchObject({ code: 'Aborted' });
    expect(inner.disposed).toBe(true);
  });

  it('reports a failed load as a kernel error and tries again on the next request', async () => {
    let loads = 0;
    const inner = new FakeBackend();
    const backend = new DeferredBackend(() => (++loads === 1 ? Promise.reject(new Error('no module')) : Promise.resolve(inner)));
    await expect(backend.request(init)).rejects.toMatchObject({ code: 'Internal', message: expect.stringContaining('no module') });
    await expect(backend.request(init)).resolves.toEqual({ ready: true });
  });
});
