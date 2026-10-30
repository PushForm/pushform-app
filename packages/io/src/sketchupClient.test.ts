// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSketchUpInWorker } from './sketchupClient';

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.last = this; }
}
afterEach(() => vi.unstubAllGlobals());

describe('SketchUp worker client', () => {
  it('terminates the parser worker on cancellation and does not detach the input', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController(), bytes = new Uint8Array([1, 2, 3]);
    const onProgress = vi.fn();
    const pending = readSketchUpInWorker(bytes, { signal: controller.signal, onProgress });
    const worker = FakeWorker.last;
    expect(worker.postMessage.mock.calls[0]![0]).not.toBe(bytes);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect([...bytes]).toEqual([1, 2, 3]);
    worker.onmessage?.({ data: { type: 'progress', progress: { stage: 'Late', current: 1, total: 1 } } } as MessageEvent);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('forwards stage progress and cleans up on parser errors and worker crashes', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onProgress = vi.fn(), pending = readSketchUpInWorker(new Uint8Array(4), { onProgress });
    const worker = FakeWorker.last;
    const progress = { stage: 'Converting geometry', current: 1, total: 2 };
    worker.onmessage?.({ data: { type: 'progress', progress } } as MessageEvent);
    expect(onProgress).toHaveBeenCalledWith(progress);
    worker.onmessage?.({ data: { type: 'error', message: 'Invalid geometry' } } as MessageEvent);
    await expect(pending).rejects.toThrow('Invalid geometry');
    expect(worker.terminate).toHaveBeenCalledOnce();
    const crashed = readSketchUpInWorker(new Uint8Array(4));
    FakeWorker.last.onerror?.({ message: 'Worker crashed' } as ErrorEvent);
    await expect(crashed).rejects.toThrow('Worker crashed');
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });

  it('rejects pre-cancelled requests before starting a worker', async () => {
    vi.stubGlobal('Worker', vi.fn());
    const controller = new AbortController(); controller.abort();
    await expect(readSketchUpInWorker(new Uint8Array(4), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Worker).not.toHaveBeenCalled();
  });
});
