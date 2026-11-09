// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import { InlineBackend } from '../../backends/InlineBackend';
import { KernelClient } from '../../client/KernelClient';
import type { MeshWire } from '../../protocol';
import { meshTopologyProblems } from '../../meshChecks';
import { faceCount, square, topRegion, uploadBox, uploadComponent } from '../../test/helpers';
import type { KernelContext } from '../context';

let backend: InlineBackend;
let client: KernelClient;
let ctx: KernelContext;
let nextBodyId = 1;
const newBodyId = (): number => nextBodyId++;

beforeAll(async () => {
  backend = new InlineBackend({ typescriptOnly: true });
  client = new KernelClient(backend);
  await client.init();
  ctx = await backend.getContext();
});
afterAll(() => client.dispose());
afterEach(() => vi.restoreAllMocks());

const maxZ = (m: MeshWire): number => Math.max(...m.verts.filter((_, i) => i % 3 === 2));

/** Count what a run does in the wasm module: meshes turned into solids, simplifies and decomposes. */
function watch(): { solids: () => number; simplifies: () => number; decomposes: () => number } {
  const mesh = vi.spyOn(ctx.wasm, 'Mesh');
  // Instances do not inherit from the exported constructor's prototype, so spy on a real one's.
  const sample = ctx.wasm.Manifold.cube([1, 1, 1]);
  const proto = Object.getPrototypeOf(sample) as { simplify: () => unknown; decompose: () => unknown };
  sample.delete();
  const simplify = vi.spyOn(proto, 'simplify');
  const decompose = vi.spyOn(proto, 'decompose');
  return { solids: () => mesh.mock.calls.length, simplifies: () => simplify.mock.calls.length, decomposes: () => decompose.mock.calls.length };
}

/** These watch the TypeScript kernel's internals (its cache and calls into Manifold), which the Rust kernel does not expose. */
const typescriptInternals = false;

describe('pushPull preview', () => {
  it('answers with triangles to draw and nothing that could be committed', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const request = { body, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false), distance: 0.5, mode: 'merge' as const, nextFaceId: 6 };
    const preview = await client.pushPull({ ...request, preview: true });
    expect(Object.keys(preview).sort()).toEqual(['mesh', 'preview']);
    expect(preview.preview).toBe(true);
    expect(preview.mesh.runId).toBe(0);
    expect(meshTopologyProblems(preview.mesh)).toEqual([]);
    expect(maxZ(preview.mesh)).toBeCloseTo(1.5, 5);
    // one id per face, so the renderer draws no lines along triangle edges
    const full = await client.pushPull(request);
    expect(faceCount(preview.mesh)).toBe(faceCount(full.components[0]!.mesh));
  });

  it.skipIf(typescriptInternals)('skips the rebuild, the simplify and the decompose of a boolean result', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const request = { body, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false), distance: 0.5, mode: 'merge' as const, nextFaceId: 6 };
    const full = watch();
    await client.pushPull(request);
    expect(full.solids()).toBe(3); // the solid, the tool and the rebuilt result
    expect(full.simplifies()).toBe(1);
    expect(full.decomposes()).toBe(1);
    vi.restoreAllMocks();
    const preview = watch();
    await client.pushPull({ ...request, preview: true });
    expect(preview.solids()).toBe(2); // the solid and the tool only
    expect(preview.simplifies()).toBe(0);
    expect(preview.decomposes()).toBe(0);
  });

  it('draws a moved face without building a solid, keeping the faces it had', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const spies = watch();
    const preview = await client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 1, mode: 'merge', preview: true, nextFaceId: 6 });
    expect(spies.solids()).toBe(0);
    expect(spies.simplifies()).toBe(0);
    expect(maxZ(preview.mesh)).toBeCloseTo(2, 9);
    expect(faceCount(preview.mesh)).toBe(6);
    expect(meshTopologyProblems(preview.mesh)).toEqual([]);
  });

  it.skipIf(typescriptInternals)('gives a moved face its own buffers, since the worker transfers a result away', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const preview = await client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0.5, mode: 'merge', preview: true, nextFaceId: 6 });
    const cached = ctx.cache.get(body.bodyId, body.version)!.mesh!;
    expect(preview.mesh.tris.buffer).not.toBe(cached.tris.buffer);
    expect(preview.mesh.faceId.buffer).not.toBe(cached.faceId.buffer);
    expect(preview.mesh.verts.buffer).not.toBe(cached.verts.buffer);
  });

  it('does not move a face that would pass a vertex of the solid', async () => {
    const base = await uploadBox(client, newBodyId(), [0, 0, 0], [2, 1, 1]);
    const post = await uploadBox(client, newBodyId(), [0, 0, 1], [1, 1, 1.5]);
    const top = await uploadBox(client, newBodyId(), [0, 0, 1.5], [2, 1, 2.5]);
    const u1 = await client.boolean({ op: 'add', a: base, b: post, nextFaceId: 6 });
    const u1Body = await uploadComponent(client, newBodyId(), 1, u1.components[0]!);
    const u2 = await client.boolean({ op: 'add', a: u1Body, b: top, nextFaceId: u1.nextFaceId });
    const body = await uploadComponent(client, newBodyId(), 1, u2.components[0]!);
    const request = { body, region: topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0.5, mode: 'merge' as const, nextFaceId: u2.nextFaceId };
    const preview = await client.pushPull({ ...request, preview: true });
    const full = await client.pushPull(request);
    expect(full.moved).toBeUndefined();
    // fused into the overhang like the full result, not stretched up against it
    expect(faceCount(preview.mesh)).toBe(faceCount(full.components[0]!.mesh));
  });

  it.skipIf(typescriptInternals)('does not move a face that would pass through another face of the solid', async () => {
    // A box and a bar across above it: moving the top by 2.5 meets no vertex of the bar, only its faces.
    const box = meshBox([0, 0, 0], [1, 1, 1]);
    const bar = meshBox([-1, 0.4, 2], [2, 0.6, 3]);
    const verts = new Float64Array([...box.verts, ...bar.verts]);
    const tris = new Uint32Array([...box.tris, ...[...bar.tris].map((i) => i + box.verts.length / 3)]);
    const faceId = new Uint32Array([...box.faceId, ...[...bar.faceId].map((f) => f + 6)]);
    const body = { bodyId: newBodyId(), version: 1 };
    await client.ensureBody(body.bodyId, body.version, { verts, tris, faceId });
    const request = { body, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 2.5, mode: 'merge' as const, nextFaceId: 12 };
    const full = await client.pushPull(request);
    expect(full.moved).toBeUndefined();
    const spies = watch();
    const preview = await client.pushPull({ ...request, preview: true });
    expect(spies.solids()).toBe(2); // the boolean, not a moved face
    expect(faceCount(preview.mesh)).toBe(full.components.reduce((n, c) => n + faceCount(c.mesh), 0));
  });

  it('reports a push that leaves nothing as an empty mesh', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const preview = await client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: -1, mode: 'merge', preview: true, nextFaceId: 6 });
    expect(preview.mesh.tris.length).toBe(0);
  });

  it('previews a new body the same way', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const spies = watch();
    const preview = await client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.5), 1, false), distance: 0.25, mode: 'newBody', preview: true, nextFaceId: 1 });
    expect(spies.simplifies()).toBe(0);
    expect(spies.decomposes()).toBe(0);
    expect(faceCount(preview.mesh)).toBe(6);
    expect(maxZ(preview.mesh)).toBeCloseTo(1.25, 5);
  });
});
