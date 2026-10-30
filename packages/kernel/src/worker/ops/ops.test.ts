// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { meshBox, m4translation, planeBasis, type Vec3 } from '@pushform/core';
import { InlineBackend } from '../../backends/InlineBackend';
import { KernelClient } from '../../client/KernelClient';
import { meshEulerCharacteristic } from '../../meshChecks';
import type { MeshWire } from '../../protocol';
import { meshSelfIntersection } from './autofold';
import { expectManifold, faceCount, faceIds, square, topRegion, uploadBox, uploadComponent } from '../../test/helpers';

let client: KernelClient;
let nextBodyId = 1;
const newBodyId = (): number => nextBodyId++;

beforeAll(async () => {
  client = new KernelClient(new InlineBackend());
  await client.init();
});
afterAll(() => client.dispose());

describe('fromTriangles', () => {
  it('accepts a 2x3x4 box: volume 24, 6 faces of 2 triangles each', async () => {
    const r = await client.fromTriangles({ mesh: { ...meshBox([0, 0, 0], [2, 3, 4]), runId: 0 }, nextFaceId: 6 });
    expect(r.status).toBe('NoError');
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(24, 6);
    expect(c.props.area).toBeCloseTo(2 * (6 + 8 + 12), 6);
    expect(faceIds(c.mesh)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const id of faceIds(c.mesh)) expect(c.mesh.faceId.filter((f) => f === id)).toHaveLength(2);
    expect(c.faceOrigin.get(1)).toEqual([{ runId: c.faceOrigin.get(1)![0]!.runId, faceId: 1 }]);
    await expectManifold(client, c.mesh);
  });

  it('reports the Manifold status for an open mesh', async () => {
    const box = meshBox([0, 0, 0], [1, 1, 1]);
    const open = { verts: box.verts, tris: box.tris.slice(0, 30), faceId: box.faceId.slice(0, 10), runId: 0 };
    const r = await client.fromTriangles({ mesh: open, nextFaceId: 6 });
    expect(r.status).toBe('NotManifold');
    expect(r.components).toHaveLength(0);
  });

  it('splits non-adjacent coplanar triangles into separate faces', async () => {
    // Two unit boxes side by side with a gap, both labelled face ids 0..5: 12 faces after normalize.
    const a = meshBox([0, 0, 0], [1, 1, 1]), b = meshBox([2, 0, 0], [3, 1, 1]);
    const verts = new Float64Array([...a.verts, ...b.verts]);
    const tris = new Uint32Array([...a.tris, ...b.tris.map((i) => i + 8)]);
    const faceId = new Uint32Array([...a.faceId, ...b.faceId]);
    const r = await client.fromTriangles({ mesh: { verts, tris, faceId, runId: 0 }, nextFaceId: 6 });
    expect(r.status).toBe('NoError');
    expect(r.components).toHaveLength(2);
    const all = new Set([...faceIds(r.components[0]!.mesh), ...faceIds(r.components[1]!.mesh)]);
    expect(all.size).toBe(12);
    expect(r.nextFaceId).toBe(12);
  });
});

describe('pushPull', () => {
  it('pulls the whole top face of a unit box by 1: one 6-face body of volume 2, top keeps id 1', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.pushPull({
      body,
      region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true),
      distance: 1,
      mode: 'merge',
      nextFaceId: 6,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(2, 6);
    expect(faceIds(c.mesh)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(c.mesh.tris.length / 3).toBe(12);
    // The top face now sits at z = 2 and carries id 1.
    for (let t = 0; t < c.mesh.faceId.length; t++) {
      if (c.mesh.faceId[t] !== 1) continue;
      for (let k = 0; k < 3; k++) expect(c.mesh.verts[c.mesh.tris[t * 3 + k]! * 3 + 2]).toBeCloseTo(2, 6);
    }
    expect(c.faceOrigin.get(1)).toEqual([{ runId: r.toolRunId, faceId: 1 }]);
    await expectManifold(client, c.mesh);
  });

  it('pulls a 0.2 square region up by 0.5: volume 1.02 and 11 faces', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.pushPull({
      body,
      region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false),
      distance: 0.5,
      mode: 'merge',
      nextFaceId: 6,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(1.02, 6);
    expect(faceCount(c.mesh)).toBe(11);
    expect(faceIds(c.mesh).slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.nextFaceId).toBe(11);
    // Four side faces map to the four boundary edges of the square.
    expect(Object.values(r.sideFaceForBoundaryEdge).sort()).toEqual([0, 1, 2, 3]);
    await expectManifold(client, c.mesh);
  });

  it('pushes the 0.2 square through the box: through-hole of volume 0.96 with genus 1', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.pushPull({
      body,
      region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false),
      distance: -1,
      mode: 'merge',
      nextFaceId: 6,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.96, 6);
    expect(meshEulerCharacteristic(c.mesh)).toBe(0);
    expect(faceCount(c.mesh)).toBe(10);
    const next = await uploadComponent(client, body.bodyId, 2, c);
    expect((await client.properties({ body: next })).genus).toBe(1);
    await expectManifold(client, c.mesh);
  });

  it('pushes the 0.2 square down by 0.5: blind hole of volume 0.98', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.pushPull({
      body,
      region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false),
      distance: -0.5,
      mode: 'merge',
      nextFaceId: 6,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.98, 6);
    expect(faceCount(c.mesh)).toBe(11);
    expect(meshEulerCharacteristic(c.mesh)).toBe(2);
    await expectManifold(client, c.mesh);
  });

  it('merges a pulled region into a neighbouring coplanar face (stacked boxes)', async () => {
    // L-shaped body: 2x1x1 slab with a 1x1x1 block on its left half.
    const slab = await uploadBox(client, newBodyId(), [0, 0, 0], [2, 1, 1]);
    const block = await uploadBox(client, newBodyId(), [0, 0, 1], [1, 1, 2]);
    const union = await client.boolean({ op: 'add', a: slab, b: block, nextFaceId: 6 });
    expect(union.components).toHaveLength(1);
    const L = union.components[0]!;
    expect(L.props.volume).toBeCloseTo(3, 6);
    expect(faceCount(L.mesh)).toBe(8); // 6 slab faces (coplanar sides merged) + block top + block +x wall
    const lBody = await uploadComponent(client, newBodyId(), 1, L);
    // Pull the step (slab top at x in [1,2], id 1 from the slab) up by exactly 1.
    const r = await client.pushPull({
      body: lBody,
      region: topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true),
      distance: 1,
      mode: 'merge',
      nextFaceId: union.nextFaceId,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(4, 6);
    expect(faceCount(c.mesh)).toBe(6);
    expect(c.mesh.tris.length / 3).toBe(12);
    await expectManifold(client, c.mesh);
  });

  it('pulls into the underside of an overhang and fuses with it', async () => {
    // Base 2x1x1 and an overhang 2x1x1 at z in [1.5, 2.5] joined by a 1x1x0.5 post on the left half.
    const base = await uploadBox(client, newBodyId(), [0, 0, 0], [2, 1, 1]);
    const post = await uploadBox(client, newBodyId(), [0, 0, 1], [1, 1, 1.5]);
    const top = await uploadBox(client, newBodyId(), [0, 0, 1.5], [2, 1, 2.5]);
    const u1 = await client.boolean({ op: 'add', a: base, b: post, nextFaceId: 6 });
    const u1Body = await uploadComponent(client, newBodyId(), 1, u1.components[0]!);
    const u2 = await client.boolean({ op: 'add', a: u1Body, b: top, nextFaceId: u1.nextFaceId });
    const body = await uploadComponent(client, newBodyId(), 1, u2.components[0]!);
    // Pull the step face (x in [1,2] at z=1, id 1) up by 0.5 so it reaches the overhang's underside.
    const r = await client.pushPull({
      body,
      region: topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true),
      distance: 0.5,
      mode: 'merge',
      nextFaceId: u2.nextFaceId,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(5, 4);
    expect(faceCount(c.mesh)).toBe(6);
    await expectManifold(client, c.mesh);
  });

  it('newBody mode extrudes a standalone solid and leaves the source body alone', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.pushPull({
      body,
      region: topRegion([0.5, 0.5, 1], square(0, 0, 0.5), 1, false),
      distance: 0.25,
      mode: 'newBody',
      nextFaceId: 1,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.0625, 9);
    expect(faceCount(c.mesh)).toBe(6);
    expect(r.nextFaceId).toBe(7);
    expect((await client.properties({ body })).volume).toBeCloseTo(1, 9);
    await expectManifold(client, c.mesh);
  });

  it('extrudeSketch builds a prism with a hole', async () => {
    const r = await client.extrudeSketch({
      basis: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
      polygon: [...square(0, 0, 2), ...square(0, 0, 1)],
      distance: -3,
      nextFaceId: 1,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(9, 6);
    expect(faceCount(c.mesh)).toBe(10);
    expect(meshEulerCharacteristic(c.mesh)).toBe(0);
    // Pushed along -n: the solid spans z in [-3, 0].
    let minZ = Infinity;
    for (let i = 2; i < c.mesh.verts.length; i += 3) minZ = Math.min(minZ, c.mesh.verts[i]!);
    expect(minZ).toBeCloseTo(-3, 6);
    expect(Object.values(r.sideFaceForBoundaryEdge).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await expectManifold(client, c.mesh);
  });

  it('rejects a zero distance', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    await expect(
      client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0, mode: 'merge', nextFaceId: 6 }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
  });
});

describe('boolean', () => {
  it('subtracts overlapping boxes', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [0.5, 0.5, 0.5], [2, 2, 2]);
    const r = await client.boolean({ op: 'subtract', a, b, nextFaceId: 6 });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.875, 9);
    expect(faceCount(c.mesh)).toBe(9);
    expect(faceIds(c.mesh).slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.secondary).toHaveLength(0);
    await expectManifold(client, c.mesh);
  });

  it('splits into inside and outside parts', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [0.5, 0.5, 0.5], [2, 2, 2]);
    const r = await client.boolean({ op: 'split', a, b, nextFaceId: 6 });
    expect(r.components.length + r.secondary.length).toBe(2);
    expect(r.components[0]!.props.volume).toBeCloseTo(0.125, 9);
    expect(r.secondary[0]!.props.volume).toBeCloseTo(0.875, 9);
    await expectManifold(client, r.components[0]!.mesh);
    await expectManifold(client, r.secondary[0]!.mesh);
  });

  it('intersect, add and trim', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [0.5, 0.5, 0.5], [2, 2, 2]);
    expect((await client.boolean({ op: 'intersect', a, b, nextFaceId: 6 })).components[0]!.props.volume).toBeCloseTo(0.125, 9);
    expect((await client.boolean({ op: 'add', a, b, nextFaceId: 6 })).components[0]!.props.volume).toBeCloseTo(1 + 3.375 - 0.125, 9);
    const trim = await client.boolean({ op: 'trim', a, b, nextFaceId: 6 });
    expect(trim.components[0]!.props.volume).toBeCloseTo(0.875, 9);
    expect((await client.properties({ body: b })).volume).toBeCloseTo(3.375, 9);
  });

  it('a subtract that removes everything yields no components', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [-1, -1, -1], [2, 2, 2]);
    const r = await client.boolean({ op: 'subtract', a, b, nextFaceId: 6 });
    expect(r.components).toHaveLength(0);
  });
});

describe('other ops', () => {
  it('transform translates and keeps face ids', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 2, 3]);
    const r = await client.transform({ body, matrix: m4translation([10, 0, 0]), nextFaceId: 6 });
    const c = r.components[0]!;
    expect(faceIds(c.mesh)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(c.props.volume).toBeCloseTo(6, 9);
    let minX = Infinity;
    for (let i = 0; i < c.mesh.verts.length; i += 3) minX = Math.min(minX, c.mesh.verts[i]!);
    expect(minX).toBeCloseTo(10, 9);
    await expectManifold(client, c.mesh);
  });

  it('a mirroring transform still yields a positive solid', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 2, 3]);
    const r = await client.transform({ body, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], nextFaceId: 6 });
    expect(r.components[0]!.props.volume).toBeCloseTo(6, 9);
    await expectManifold(client, r.components[0]!.mesh);
  });

  it('decompose separates connected solids, largest first', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [5, 0, 0], [7, 2, 2]);
    const both = await client.boolean({ op: 'add', a, b, nextFaceId: 6 });
    expect(both.components).toHaveLength(2);
    expect(both.components[0]!.props.volume).toBeCloseTo(8, 9);
    expect(both.components[1]!.props.volume).toBeCloseTo(1, 9);
  });

  it('sectionCut returns the outline of a box at mid height', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [2, 1, 1]);
    const r = await client.sectionCut({ body, plane: { n: [0, 0, 1], d: -0.5 } });
    expect(r.loops).toHaveLength(1);
    const loop = r.loops[0]!;
    expect(loop.length / 3).toBe(4);
    for (let i = 2; i < loop.length; i += 3) expect(loop[i]).toBeCloseTo(0.5, 6);
    const xs = [], ys = [];
    for (let i = 0; i < loop.length; i += 3) {
      xs.push(loop[i]!);
      ys.push(loop[i + 1]!);
    }
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(2, 6);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
    // A tilted plane cuts a hexagon-ish polygon with points on the plane.
    const tilted = await client.sectionCut({ body, plane: { n: [Math.SQRT1_2, 0, Math.SQRT1_2], d: -Math.SQRT1_2 } });
    expect(tilted.loops).toHaveLength(1);
    const t = tilted.loops[0]!;
    for (let i = 0; i < t.length; i += 3) expect(Math.SQRT1_2 * t[i]! + Math.SQRT1_2 * t[i + 2]! - Math.SQRT1_2).toBeCloseTo(0, 5);
  });

  it('hull of two boxes', async () => {
    const a = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const b = await uploadBox(client, newBodyId(), [2, 0, 0], [3, 1, 1]);
    const r = await client.hull({ bodies: [a, b], nextFaceId: 1 });
    expect(r.components[0]!.props.volume).toBeCloseTo(3, 9);
    expect(faceCount(r.components[0]!.mesh)).toBe(6);
    await expectManifold(client, r.components[0]!.mesh);
  });

  it('simplify keeps the box', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 1, 1]);
    const r = await client.simplify({ body, nextFaceId: 6 });
    expect(r.components[0]!.mesh.tris.length / 3).toBe(12);
  });

  it('properties, stats, release and re-upload through the mesh provider', async () => {
    const body = await uploadBox(client, newBodyId(), [0, 0, 0], [1, 2, 3]);
    const p = await client.properties({ body });
    expect(p.volume).toBeCloseTo(6, 9);
    expect(p.area).toBeCloseTo(22, 9);
    expect(p.genus).toBe(0);
    expect(p.bounds.max).toEqual([1, 2, 3]);
    const before = (await client.stats()).cached;
    expect(before).toBeGreaterThan(0);
    // Release in the worker only; the client still remembers the upload and re-sends on demand.
    const backend = new InlineBackend();
    const c2 = new KernelClient(backend);
    const b2 = await uploadBox(c2, 1, [0, 0, 0], [1, 1, 1]);
    (await backend.getContext()).cache.clear();
    expect((await c2.properties({ body: b2 })).volume).toBeCloseTo(1, 9);
    c2.dispose();
  });
});

/** Mesh from index polygons (fans), one face id per polygon; vertices are shared by index. */
function meshFromPolygons(verts: number[][], polys: Array<{ id: number; loop: number[] }>): MeshWire {
  const tris: number[] = [], faceId: number[] = [];
  for (const { id, loop } of polys) {
    for (let j = 1; j + 1 < loop.length; j++) {
      tris.push(loop[0]!, loop[j]!, loop[j + 1]!);
      faceId.push(id);
    }
  }
  return { verts: Float64Array.from(verts.flat()), tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId), runId: 0 };
}

/** Unit-box vertices in `meshBox` order; 0-3 bottom, 4-7 top. */
const BOX_VERTS = (): number[][] => [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const BOX_SIDES = [
  { id: 0, loop: [0, 3, 2, 1] },
  { id: 2, loop: [0, 1, 5, 4] },
  { id: 3, loop: [1, 2, 6, 5] },
  { id: 4, loop: [2, 3, 7, 6] },
  { id: 5, loop: [3, 0, 4, 7] },
];

describe('autofold', () => {
  const request = (mesh: MeshWire, nextFaceId: number) =>
    client['backend'].request({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh, nextFaceId });

  it('accepts a box whose top-front edge was raised unevenly: top folded into two faces', async () => {
    const v = BOX_VERTS();
    v[4] = [0, 0, 1.3];
    v[5] = [1, 0, 1.15];
    const mesh = meshFromPolygons(v, [...BOX_SIDES, { id: 1, loop: [4, 5, 6] }, { id: 6, loop: [4, 6, 7] }]);
    const r = await request(mesh, 7);
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(faceCount(c.mesh)).toBe(7);
    expect(faceIds(c.mesh)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(c.props.volume).toBeGreaterThan(1);
    expect(c.faceOrigin.get(6)).toEqual([{ runId: c.faceOrigin.get(6)![0]!.runId, faceId: 6 }]);
    expect(r.nextFaceId).toBe(7);
    await expectManifold(client, c.mesh);
  });

  it('accepts a box collapsed into a wedge by merging the top edge into the back one (5 faces)', async () => {
    // Vertices 4 and 5 merged onto 7 and 6: the top face vanished, two sides became triangles.
    const v = BOX_VERTS().slice(0, 4).concat([[1, 1, 1], [0, 1, 1]]); // 4 = old 6, 5 = old 7
    const mesh = meshFromPolygons(v, [
      { id: 0, loop: [0, 3, 2, 1] },
      { id: 2, loop: [0, 1, 4, 5] },
      { id: 3, loop: [1, 2, 4] },
      { id: 4, loop: [2, 3, 5, 4] },
      { id: 5, loop: [3, 0, 5] },
    ]);
    const r = await request(mesh, 6);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.5, 9);
    expect(faceIds(c.mesh)).toEqual([0, 2, 3, 4, 5]);
    await expectManifold(client, c.mesh);
  });

  it('rejects a vertex pushed through the opposite face as self-intersecting', async () => {
    const v = BOX_VERTS();
    v[5] = [1, 0, -0.5];
    // Every face stays a closed, consistently oriented fan, but the top pieces pierce the bottom.
    const mesh = meshFromPolygons(v, [
      { id: 0, loop: [0, 3, 2, 1] },
      { id: 1, loop: [5, 6, 7] },
      { id: 6, loop: [5, 7, 4] },
      { id: 2, loop: [5, 4, 0] },
      { id: 7, loop: [5, 0, 1] },
      { id: 3, loop: [5, 1, 2] },
      { id: 8, loop: [5, 2, 6] },
      { id: 4, loop: [2, 3, 7, 6] },
      { id: 5, loop: [3, 0, 4, 7] },
    ]);
    await expect(request(mesh, 9)).rejects.toMatchObject({ code: 'ManifoldError', details: { reason: 'SelfIntersecting' } });
  });

  it('rejects an open mesh as not manifold', async () => {
    const box = meshBox([0, 0, 0], [1, 1, 1]);
    const open = { verts: box.verts, tris: box.tris.slice(0, 30), faceId: box.faceId.slice(0, 10), runId: 0 };
    await expect(request(open, 6)).rejects.toMatchObject({ code: 'ManifoldError', details: { reason: 'NotManifold', status: 'NotManifold' } });
  });

  it('meshSelfIntersection ignores adjacent and merely touching triangles', () => {
    expect(meshSelfIntersection({ ...meshBox([0, 0, 0], [1, 1, 1]) })).toBeNull();
    // Two boxes sharing a face but not vertices: touching, not intersecting.
    const a = meshBox([0, 0, 0], [1, 1, 1]), b = meshBox([0.25, 0.25, 1], [0.75, 0.75, 2]);
    const verts = new Float64Array([...a.verts, ...b.verts]);
    const tris = new Uint32Array([...a.tris, ...b.tris.map((i) => i + 8)]);
    const faceId = new Uint32Array([...a.faceId, ...b.faceId]);
    expect(meshSelfIntersection({ verts, tris, faceId })).toBeNull();
    const c = meshBox([0.25, 0.25, 0.5], [0.75, 0.75, 2]);
    expect(meshSelfIntersection({ verts: new Float64Array([...a.verts, ...c.verts]), tris, faceId })).not.toBeNull();
  });
});

describe('followMe', () => {
  const squareProfile = (size: number, origin: Vec3, n: Vec3) => ({ profile: square(0, 0, size), profileBasis: planeBasis(origin, n) });

  it('a straight path is an extrude: exact volume, 6 faces', async () => {
    const r = await client.followMe({ ...squareProfile(0.2, [0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.04, 6);
    expect(faceCount(c.mesh)).toBe(6);
    await expectManifold(client, c.mesh);
  });

  it('a square along an L-shaped path mitres the corner: one solid of volume 0.08', async () => {
    // Profile centred on the path: the mitre removes and adds equal wedges, so volume = area x length.
    const r = await client.followMe({
      ...squareProfile(0.2, [0, 0, 0], [1, 0, 0]),
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      closed: false,
      nextFaceId: 1,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(Math.abs(c.props.volume - 0.08) / 0.08).toBeLessThan(0.02);
    expect(meshEulerCharacteristic(c.mesh)).toBe(2);
    // Coplanar top faces of both legs merge into one L-shaped face: 2 caps + top + bottom + 4 walls.
    expect(faceCount(c.mesh)).toBe(8);
    await expectManifold(client, c.mesh);
  });

  it('an offset square along the L path follows its centroid (Pappus): 0.04 x 1.8', async () => {
    const r = await client.followMe({
      profile: [[[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]]], // centroid 0.1 towards +y (inside the bend) and +z
      profileBasis: { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      closed: false,
      nextFaceId: 1,
    });
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.04 * 1.8, 6);
    await expectManifold(client, c.mesh);
  });

  it('starts at the path end nearest the profile and projects a tilted profile', async () => {
    // Profile sits at the far end and is tilted 30 degrees about y: projected along x it is still 0.2 wide.
    const n: Vec3 = [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)];
    const r = await client.followMe({ profile: square(0, 0, 0.2), profileBasis: planeBasis([1, 0, 0], n), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(0.04 * Math.cos(Math.PI / 6), 6);
    await expectManifold(client, c.mesh);
  });

  it('a circle along a closed square path makes a genus-1 solid', async () => {
    const segs = 24, radius = 0.1;
    const circle = [Array.from({ length: segs }, (_, i) => [radius * Math.cos((2 * Math.PI * i) / segs), radius * Math.sin((2 * Math.PI * i) / segs)])];
    const r = await client.followMe({
      profile: circle,
      profileBasis: planeBasis([0, 0, 0], [1, 0, 0]),
      path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
      closed: true,
      nextFaceId: 1,
    });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    const polygonArea = (segs / 2) * radius * radius * Math.sin((2 * Math.PI) / segs);
    expect(Math.abs(c.props.volume - polygonArea * 4) / (polygonArea * 4)).toBeLessThan(0.02);
    expect(meshEulerCharacteristic(c.mesh)).toBe(0);
    const body = await uploadComponent(client, newBodyId(), 1, c);
    expect((await client.properties({ body })).genus).toBe(1);
    await expectManifold(client, c.mesh);
  });

  it('a profile with a hole sweeps into a tube', async () => {
    const r = await client.followMe({
      profile: [...square(0, 0, 0.4), ...square(0, 0, 0.2)],
      profileBasis: planeBasis([0, 0, 0], [0, 0, 1]),
      path: [[0, 0, 0], [0, 0, 1], [1, 0, 1]],
      closed: false,
      nextFaceId: 1,
    });
    const c = r.components[0]!;
    expect(Math.abs(c.props.volume - 0.12 * 2) / 0.24).toBeLessThan(0.02);
    expect(meshEulerCharacteristic(c.mesh)).toBe(0);
    await expectManifold(client, c.mesh);
  });

  it('rejects degenerate input', async () => {
    const base = squareProfile(0.2, [0, 0, 0], [1, 0, 0]);
    await expect(client.followMe({ ...base, path: [[0, 0, 0]], closed: false, nextFaceId: 1 })).rejects.toMatchObject({ code: 'InvalidInput' });
    await expect(client.followMe({ ...base, path: [[0, 0, 0], [1, 0, 0], [0, 0, 0]], closed: false, nextFaceId: 1 })).rejects.toMatchObject({ code: 'InvalidInput' });
    await expect(client.followMe({ ...squareProfile(0.2, [0, 0, 0], [0, 0, 1]), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 })).rejects.toMatchObject({ code: 'InvalidInput' });
  });
});

describe('revolve', () => {
  const rect = (rIn: number, rOut: number, h: number) => [[[rIn, 0], [rOut, 0], [rOut, h], [rIn, h]]];
  const xz = { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3, n: [0, -1, 0] as Vec3 };
  const ringVolume = (rIn: number, rOut: number, h: number, segs: number, frac = 1): number =>
    ((segs * frac) / 2) * Math.sin((2 * Math.PI) / segs) * (rOut * rOut - rIn * rIn) * h;

  it('a rectangle revolved 360 degrees makes a faceted ring', async () => {
    const r = await client.revolve({ profile: rect(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, segments: 48, nextFaceId: 1 });
    expect(r.components).toHaveLength(1);
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(ringVolume(0.5, 1, 1, 48), 6);
    expect(Math.abs(c.props.volume - Math.PI * 0.75) / (Math.PI * 0.75)).toBeLessThan(0.01);
    expect(meshEulerCharacteristic(c.mesh)).toBe(0);
    expect(faceCount(c.mesh)).toBe(48 * 2 + 2);
    await expectManifold(client, c.mesh);
  });

  it('a 90 degree revolve is a quarter ring with two flat ends', async () => {
    const r = await client.revolve({ profile: rect(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90, segments: 48, nextFaceId: 1 });
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(ringVolume(0.5, 1, 1, 48, 0.25), 6);
    expect(faceCount(c.mesh)).toBe(12 * 2 + 4);
    await expectManifold(client, c.mesh);
  });

  it('works with an arbitrary axis and clips the profile at the axis', async () => {
    // Profile in the plane y = 2 spanning x in [-0.5, 1]: the part at x < 0 is dropped -> solid cylinder.
    const basis = { origin: [0, 2, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3, n: [0, -1, 0] as Vec3 };
    const r = await client.revolve({ profile: rect(-0.5, 1, 1), profileBasis: basis, axisOrigin: [0, 2, 5], axisDir: [0, 0, -1], angleDeg: 360, segments: 24, nextFaceId: 1 });
    const c = r.components[0]!;
    expect(c.props.volume).toBeCloseTo(ringVolume(0, 1, 1, 24), 6);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < c.mesh.verts.length; i += 3) {
      minY = Math.min(minY, c.mesh.verts[i]!);
      maxY = Math.max(maxY, c.mesh.verts[i]!);
    }
    expect(minY).toBeCloseTo(1, 6);
    expect(maxY).toBeCloseTo(3, 6);
    await expectManifold(client, c.mesh);
  });

  it('rejects bad angles, segment counts and axes', async () => {
    const base = { profile: rect(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0] as Vec3, axisDir: [0, 0, 1] as Vec3, segments: 24, nextFaceId: 1 };
    await expect(client.revolve({ ...base, angleDeg: 0 })).rejects.toMatchObject({ code: 'InvalidInput' });
    await expect(client.revolve({ ...base, angleDeg: 90, segments: 2 })).rejects.toMatchObject({ code: 'InvalidInput' });
    await expect(client.revolve({ ...base, angleDeg: 90, axisDir: [0, 1, 0] })).rejects.toMatchObject({ code: 'InvalidInput' });
  });
});
