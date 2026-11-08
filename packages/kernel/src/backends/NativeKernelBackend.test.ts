// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import { InlineBackend } from './InlineBackend';
import { NativeKernelBackend, type NativeKernelTransport } from './NativeKernelBackend';
import { encodeEnsureBody, encodePushPull } from './nativeWire';
import { KernelClient } from '../client/KernelClient';
import { KernelError, type KernelRequest } from '../protocol';
import { square, topRegion } from '../test/helpers';

/** Wire-level round trips with no native process: responses are scripted per request kind. */
function transport(overrides: Partial<NativeKernelTransport> = {}): NativeKernelTransport & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(overrides.call ?? (async () => ensureOk()));
  return { available: overrides.available ?? (async () => true), call, abort: overrides.abort ?? (async () => undefined) } as NativeKernelTransport & { call: ReturnType<typeof vi.fn> };
}

function ensureOk(runId = 42): ArrayBuffer {
  const buffer = new ArrayBuffer(12);
  const view = new DataView(buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, runId, true);
  return buffer;
}

function previewResponse(): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + 3 * 8 + 3 * 4 + 4);
  const view = new DataView(buffer);
  view.setUint32(0, 2, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 1, true);
  view.setFloat64(16, 1.5, true);
  view.setUint32(40, 0, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 2, true);
  view.setUint32(52, 7, true);
  return buffer;
}

const pushPullRequest = { type: 'pushPull' as const, body: { bodyId: 1, version: 1 }, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false), distance: 0.5, mode: 'merge' as const, nextFaceId: 6 };

function setup(t: NativeKernelTransport): { backend: NativeKernelBackend; worker: InlineBackend; request: ReturnType<typeof vi.spyOn> } {
  const worker = new InlineBackend();
  const request = vi.spyOn(worker, 'request');
  const backend = new NativeKernelBackend(worker, t);
  return { backend, worker, request };
}

describe('NativeKernelBackend', () => {
  it('sends push/pull to native and leaves everything else to the worker', async () => {
    const t = transport();
    const { backend, request } = setup(t);
    await backend.request({ type: 'ensureBody', bodyId: 1, version: 1 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(t.call).not.toHaveBeenCalled();
    backend.dispose();
  });

  it('falls back to the worker when native reports an error, for that request only', async () => {
    let attempts = 0;
    const t = transport({
      call: async () => {
        attempts++;
        if (attempts === 1) throw new Error('native failed');
        return previewResponse();
      },
    });
    const { backend, worker, request } = setup(t);
    const client = new KernelClient(backend);
    await client.ensureBody(1, 1, meshBox([0, 0, 0], [1, 1, 1]));
    request.mockClear();
    const first = await backend.request(pushPullRequest);
    expect(request).toHaveBeenCalledTimes(1); // the failed native attempt reran in the worker
    expect(first.components[0]!.props.volume).toBeCloseTo(1.02, 6);
    await backend.request({ ...pushPullRequest, distance: 0.25, preview: true });
    expect(attempts).toBe(2);
    worker.abortAll();
    backend.dispose();
  });

  it('uses the worker when the native kernel is missing from this build', async () => {
    const t = transport({ available: async () => { throw new Error('Command not found'); } });
    const { backend } = setup(t);
    const client = new KernelClient(backend);
    await client.ensureBody(1, 1, meshBox([0, 0, 0], [1, 1, 1]));
    const r = await backend.request(pushPullRequest);
    expect(r.components[0]!.props.volume).toBeCloseTo(1.02, 6);
    expect(t.call).not.toHaveBeenCalled();
    backend.dispose();
  });

  it('uploads a body to native on BodyNotCached and retries, separately from the worker cache', async () => {
    const bodies = new Set<string>();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const t = transport({
      call: async (request) => {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        const op = view.getUint32(0, true);
        const id = `${view.getFloat64(4, true)}:${view.getFloat64(12, true)}`;
        if (op === 1) {
          bodies.add(id);
          return ensureOk();
        }
        if (!bodies.has(id)) throw JSON.stringify({ code: 'BodyNotCached', message: 'missing', details: { bodyId: 1, version: 1 } });
        return previewResponse();
      },
    });
    const { backend, request } = setup(t);
    const client = new KernelClient(backend);
    backend.setMeshProvider?.((bodyId, version) => (bodyId === 1 && version === 1 ? { ...mesh, runId: 0 } : undefined));
    const result = await backend.request({ ...pushPullRequest, preview: true });
    expect(result.preview).toBe(true);
    expect(request).not.toHaveBeenCalled(); // no fallback, the worker never saw the body
    expect(t.call).toHaveBeenCalledTimes(3); // first attempt, upload, retry
    client.dispose();
  });

  it('falls back when the mesh for an uncached body is unknown', async () => {
    const t = transport({ call: async () => { throw JSON.stringify({ code: 'BodyNotCached', message: 'missing', details: { bodyId: 1, version: 1 } }); } });
    const { backend, request } = setup(t);
    const client = new KernelClient(backend);
    await client.ensureBody(1, 1, meshBox([0, 0, 0], [1, 1, 1]));
    backend.setMeshProvider?.(() => undefined);
    const r = await backend.request(pushPullRequest);
    expect(request).toHaveBeenCalled();
    expect(r.components[0]!.props.volume).toBeCloseTo(1.02, 6);
    client.dispose();
  });

  it('abortAll rejects in-flight requests with Aborted, without falling back, and stops native work', async () => {
    const pendingCalls: Array<(buffer: ArrayBuffer) => void> = [];
    const abort = vi.fn(async () => undefined);
    const t = transport({ abort, call: () => new Promise<ArrayBuffer>((resolve) => pendingCalls.push(resolve)) });
    const { backend, request } = setup(t);
    const client = new KernelClient(backend);
    await client.ensureBody(1, 1, meshBox([0, 0, 0], [1, 1, 1]));
    request.mockClear();
    const inFlight = backend.request(pushPullRequest);
    await vi.waitFor(() => expect(pendingCalls).toHaveLength(1));
    client.abortAll();
    await expect(inFlight).rejects.toMatchObject({ code: 'Aborted' });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    // A late answer from the native side is dropped; a new request works.
    pendingCalls[0]!(ensureOk());
    const again = backend.request({ ...pushPullRequest, preview: true });
    await vi.waitFor(() => expect(pendingCalls).toHaveLength(2));
    pendingCalls[1]!(previewResponse());
    expect((await again).preview).toBe(true);
    client.dispose();
  });

  it('propagates worker errors from a fallback unchanged', async () => {
    const t = transport({ call: async () => { throw new Error('nope'); } });
    const { backend } = setup(t);
    await expect(backend.request({ ...pushPullRequest, distance: 0 })).rejects.toMatchObject({ code: 'InvalidInput' });
    backend.dispose();
  });

  it('dispose rejects new work', async () => {
    const t = transport();
    const { backend } = setup(t);
    backend.dispose();
    await expect(backend.request(pushPullRequest)).rejects.toBeInstanceOf(KernelError);
  });
});

describe('native wire', () => {
  it('encodes requests as little-endian bytes', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const bytes = encodeEnsureBody({ type: 'ensureBody', bodyId: 3, version: 9, mesh: { ...mesh, runId: 0 } });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(1);
    expect(view.getFloat64(4, true)).toBe(3);
    expect(view.getUint32(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(mesh.verts.length / 3);
    const request: KernelRequest = { type: 'pushPull', body: { bodyId: 2, version: 4 }, region: topRegion([0, 0, 0], square(0, 0, 1), 3, true), distance: -1, mode: 'newBody', preview: true, nextFaceId: 100 };
    const pull = new DataView(encodePushPull(request).buffer);
    expect(pull.getUint32(0, true)).toBe(2);
  });
});
