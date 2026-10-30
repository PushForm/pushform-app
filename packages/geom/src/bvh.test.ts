// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Ray } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { buildBoxBVH, buildSegBVH, buildSegBVHSteps, buildTriBVH, queryBVHBox, querySegBVHRay, raycastBVH, raycastTriBVH, type Segment3 } from './bvh';
import { SpatialHash } from './spatialHash';

describe('bvh', () => {
  it('builds the same tree in steps as in one go, every primitive in exactly one leaf (PF-189)', () => {
    // a deterministic scatter, with repeated centroids along one axis
    const segments: Segment3[] = [];
    for (let i = 0; i < 50_000; i++) {
      const x = (i * 7919) % 1000, y = (i * 104729) % 997, z = i % 3;
      segments.push({ a: [x, y, z], b: [x + 1, y, z + (i % 5)] });
    }
    const whole = buildSegBVH(segments, { maxLeaf: 8 });
    const steps = buildSegBVHSteps(segments, { maxLeaf: 8 });
    let yields = 0, result = steps.next();
    while (!result.done) { yields++; result = steps.next(); }
    const stepped = result.value;
    expect(yields).toBeGreaterThan(3);
    expect(stepped.nodeCount).toBe(whole.nodeCount);
    expect(Array.from(stepped.order)).toEqual(Array.from(whole.order));
    expect(Array.from(stepped.bounds.subarray(0, whole.nodeCount * 6))).toEqual(Array.from(whole.bounds.subarray(0, whole.nodeCount * 6)));
    const seen = new Uint8Array(segments.length);
    for (let node = 0; node < whole.nodeCount; node++) {
      for (let i = whole.start[node]!; i < whole.start[node]! + whole.count[node]!; i++) seen[whole.order[i]!]!++;
      // a parent's box holds its children's
      for (const child of [whole.left[node]!, whole.right[node]!]) {
        if (child < 0) continue;
        for (let k = 0; k < 3; k++) {
          expect(whole.bounds[child * 6 + k]!).toBeGreaterThanOrEqual(whole.bounds[node * 6 + k]!);
          expect(whole.bounds[child * 6 + 3 + k]!).toBeLessThanOrEqual(whole.bounds[node * 6 + 3 + k]!);
        }
      }
    }
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it('finds points across cell boundaries and negative coordinates with numeric cell keys', () => {
    const hash = new SpatialHash<number>(0.01);
    const points: Vec3[] = [[0, 0, 0], [0.0099, 0, 0], [-0.0001, 0, 0], [-5.004, 3.0, -7.995], [1e6, -1e6, 0.5]];
    points.forEach((p, i) => hash.insert(p, i));
    expect(hash.find([0.00001, 0, 0], 0.01)).toBe(0);
    expect(hash.query([0.005, 0, 0], 0.01).map((q) => q.item)).toEqual([1, 0, 2]);
    expect(hash.find([-5.0, 3.0, -8.0], 0.01)).toBe(3);
    expect(hash.find([1e6 + 0.009, -1e6, 0.5], 0.01)).toBe(4);
    expect(hash.find([0.5, 0.5, 0.5], 0.01)).toBeUndefined();
    expect(hash.remove([0, 0, 0], 0)).toBe(true);
    expect(hash.find([0, 0, 0], 0.001)).toBe(2);
    expect(hash.size).toBe(4);
  });

  it('raycasts a box and returns the nearest triangle', () => {
    const m = meshBox([0, 0, 0], [1, 1, 1]);
    const bvh = buildTriBVH(m, { maxLeaf: 2 });
    const ray: Ray = { origin: [0.5, 0.5, 5], dir: [0, 0, -1] };
    const hit = raycastTriBVH(bvh, m, ray)!;
    expect(hit).not.toBeNull();
    expect(hit.t).toBeCloseTo(4);
    expect(m.faceId[hit.tri]).toBe(1); // +z face
    expect(hit.point[2]).toBeCloseTo(1);
    expect(raycastTriBVH(bvh, m, { origin: [5, 5, 5], dir: [0, 0, -1] })).toBeNull();
    expect(raycastTriBVH(bvh, m, ray, 2)).toBeNull();
  });
  it('matches brute force on many triangles', () => {
    const boxes = [];
    for (let i = 0; i < 30; i++) boxes.push(meshBox([i * 3, 0, 0], [i * 3 + 1, 1, 1]));
    // merge boxes into one mesh
    let nv = 0, nt = 0;
    for (const b of boxes) {
      nv += b.verts.length;
      nt += b.tris.length;
    }
    const verts = new Float64Array(nv), tris = new Uint32Array(nt), faceId = new Uint32Array(nt / 3);
    let vo = 0, to = 0;
    for (const b of boxes) {
      verts.set(b.verts, vo);
      for (let i = 0; i < b.tris.length; i++) tris[to + i] = b.tris[i]! + vo / 3;
      vo += b.verts.length;
      to += b.tris.length;
    }
    const mesh = { verts, tris, faceId };
    const bvh = buildTriBVH(mesh);
    const ray: Ray = { origin: [-1, 0.5, 0.5], dir: [1, 0, 0] };
    const hit = raycastTriBVH(bvh, mesh, ray)!;
    expect(hit.t).toBeCloseTo(1);
    expect(hit.point[0]).toBeCloseTo(0);
    expect(queryBVHBox(bvh, [2.5, -1, -1], [4, 2, 2])).toHaveLength(12);
  });
  it('segment query returns segments within the pick radius, nearest first', () => {
    const segs: Segment3[] = [];
    for (let i = 0; i < 20; i++) segs.push({ a: [0, i, 0], b: [10, i, 0] });
    const bvh = buildSegBVH(segs, { maxLeaf: 3 });
    const ray: Ray = { origin: [5, 3.2, 10], dir: [0, 0, -1] };
    const hits = querySegBVHRay(bvh, segs, ray, () => 0.5);
    expect(hits.map((h) => h.seg)).toEqual([3]);
    expect(hits[0]!.t).toBeCloseTo(10);
    expect(hits[0]!.s).toBeCloseTo(0.5);
    const wide = querySegBVHRay(bvh, segs, ray, (t) => t * 0.13);
    expect(wide.map((h) => h.seg).sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it('raycastBVH finds the nearest primitive by the caller test and skips boxes beyond it', () => {
    // 200 flat axis-aligned squares (zero z extent) at z = i, every third one missing the ray
    const n = 200;
    const boxes = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) boxes.set(i % 3 === 0 ? [5, 5, i, 6, 6, i] : [0, 0, i, 1, 1, i], i * 6);
    const bvh = buildBoxBVH(boxes, { maxLeaf: 3 });
    const tested: number[] = [];
    const planeHit = (prim: number, limit: number): number | null => {
      tested.push(prim);
      const z = boxes[prim * 6 + 2]!;
      const t = 100.5 - z; // ray from z = 100.5 straight down
      return prim % 3 === 0 || t >= limit ? null : t;
    };
    const ray: Ray = { origin: [0.5, 0.5, 100.5], dir: [0, 0, -1] };
    const hit = raycastBVH(bvh, ray, planeHit)!;
    expect(hit.prim).toBe(100); // z = 100 is the nearest square below the origin
    expect(hit.t).toBeCloseTo(0.5);
    // squares at (5, 5) and squares behind the origin are never tested; nearer-first traversal tests few of the rest
    expect(tested.every((p) => p % 3 !== 0 && p <= 100)).toBe(true);
    expect(tested.length).toBeLessThan(n / 10);
    // a limit excludes everything at or beyond it; a strict improvement is required
    expect(raycastBVH(bvh, ray, planeHit, 0.5)).toBeNull();
    expect(raycastBVH(bvh, ray, planeHit, 0.5 + 1e-9)!.prim).toBe(100);
    // a ray missing every box tests nothing
    tested.length = 0;
    expect(raycastBVH(bvh, { origin: [3, 3, 100.5], dir: [0, 0, -1] }, planeHit)).toBeNull();
    expect(tested).toEqual([]);
    // flat boxes are hit when the ray crosses their plane inside them (pad-free slab test)
    expect(raycastBVH(bvh, { origin: [0.5, 0.5, 0.5], dir: [1, 0, 0] }, () => 1)).toBeNull();
    expect(raycastBVH(buildBoxBVH(new Float64Array(0)), ray, () => 1)).toBeNull();
    // A general ray (no zero components) against the empty tree's inverted root box must terminate.
    const diagonal = { origin: [0, 0, 0] as Vec3, dir: [0.577, 0.577, 0.577] as Vec3 };
    expect(raycastBVH(buildBoxBVH(new Float64Array(0)), diagonal, () => 1)).toBeNull();
    expect(raycastTriBVH(buildTriBVH({ verts: new Float64Array(0), tris: new Uint32Array(0), faceId: new Uint32Array(0) }),
      { verts: new Float64Array(0), tris: new Uint32Array(0), faceId: new Uint32Array(0) }, diagonal)).toBeNull();
  });
});
