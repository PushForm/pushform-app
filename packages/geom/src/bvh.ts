// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, MeshData, Ray, Vec3 } from '@pushform/core';
import { rayAt, raySegmentClosest, rayTriangle } from '@pushform/core';

/**
 * Flat AABB tree. Leaves hold `count` primitive ids from `order[start..start+count)`.
 * Internal nodes have `count = 0` and children `left`/`right`.
 */
export interface BVH {
  bounds: Float64Array; // 6 per node: minx miny minz maxx maxy maxz
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  count: Int32Array;
  order: Uint32Array;
  nodeCount: number;
  /** 6 per primitive, in primitive order (used for exact leaf tests). */
  primBounds: Float64Array;
}

export interface BuildOptions {
  maxLeaf?: number;
}

/**
 * Generic median-split builder. `primBounds` is 6 floats per primitive; `centroids` 3 per primitive.
 */
export function buildBVH(primBounds: Float64Array, centroids: Float64Array, opts: BuildOptions = {}): BVH {
  return bvhBuilder(primBounds, centroids, opts).build();
}

/** Subtrees with fewer primitives than this are built between two steps of `buildBVHSteps`. */
const STEP_PRIMITIVES = 16384;

/**
 * `buildBVH` that yields between large subtrees, for callers that spread a big build over several tasks (PF-189).
 * Builds the same tree.
 */
export function* buildBVHSteps(primBounds: Float64Array, centroids: Float64Array, opts: BuildOptions = {}): Generator<void, BVH, void> {
  return yield* bvhBuilder(primBounds, centroids, opts).steps();
}

function bvhBuilder(primBounds: Float64Array, centroids: Float64Array, opts: BuildOptions) {
  const maxLeaf = Math.max(1, opts.maxLeaf ?? 4);
  const n = primBounds.length / 6;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cap = Math.max(1, 2 * Math.ceil(n / Math.max(1, maxLeaf)) * 2 + 1);
  const bounds = new Float64Array(cap * 6);
  const left = new Int32Array(cap).fill(-1);
  const right = new Int32Array(cap).fill(-1);
  const start = new Int32Array(cap);
  const count = new Int32Array(cap);
  let nodeCount = 0;

  /** Make node `nodeCount` over `order[s..e)`: a leaf (returns -1) or an inner node split at the returned index. */
  const enter = (s: number, e: number): number => {
    const node = nodeCount++;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity, cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let i = s; i < e; i++) {
      const p = order[i]! * 6, c = order[i]! * 3;
      minx = Math.min(minx, primBounds[p]!);
      miny = Math.min(miny, primBounds[p + 1]!);
      minz = Math.min(minz, primBounds[p + 2]!);
      maxx = Math.max(maxx, primBounds[p + 3]!);
      maxy = Math.max(maxy, primBounds[p + 4]!);
      maxz = Math.max(maxz, primBounds[p + 5]!);
      cminx = Math.min(cminx, centroids[c]!);
      cminy = Math.min(cminy, centroids[c + 1]!);
      cminz = Math.min(cminz, centroids[c + 2]!);
      cmaxx = Math.max(cmaxx, centroids[c]!);
      cmaxy = Math.max(cmaxy, centroids[c + 1]!);
      cmaxz = Math.max(cmaxz, centroids[c + 2]!);
    }
    const b = node * 6;
    bounds[b] = minx; bounds[b + 1] = miny; bounds[b + 2] = minz;
    bounds[b + 3] = maxx; bounds[b + 4] = maxy; bounds[b + 5] = maxz;
    const len = e - s;
    const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
    if (len <= maxLeaf || (ex === 0 && ey === 0 && ez === 0)) {
      start[node] = s;
      count[node] = len;
      return -1;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    // split at the median centroid along the axis; selecting it is linear, where sorting each level was not
    const mid = s + (len >> 1);
    selectNth(order, s, e, mid, centroids, axis);
    count[node] = 0;
    return mid;
  };
  const build = (s: number, e: number): number => {
    const node = nodeCount, mid = enter(s, e);
    if (mid >= 0) {
      left[node] = build(s, mid);
      right[node] = build(mid, e);
    }
    return node;
  };
  function* buildSteps(s: number, e: number): Generator<void, number, void> {
    if (e - s < STEP_PRIMITIVES) return build(s, e);
    const node = nodeCount, mid = enter(s, e);
    yield;
    if (mid >= 0) {
      left[node] = yield* buildSteps(s, mid);
      right[node] = yield* buildSteps(mid, e);
    }
    return node;
  }
  const result = (): BVH => {
    if (n === 0) {
      nodeCount = 1;
      bounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], 0);
    }
    return { bounds, left, right, start, count, order, nodeCount, primBounds };
  };
  return {
    build: (): BVH => {
      if (n > 0) build(0, n);
      return result();
    },
    *steps(): Generator<void, BVH, void> {
      if (n > 0) yield* buildSteps(0, n);
      return result();
    },
  };
}

/**
 * Reorder `order[s..e)` so that `order[k]` holds the primitive whose centroid would sort there along `axis`, with
 * none after it smaller and none before it larger (quickselect with Hoare partitioning).
 */
function selectNth(order: Uint32Array, s: number, e: number, k: number, centroids: Float64Array, axis: number): void {
  const key = (i: number): number => centroids[order[i]! * 3 + axis]!;
  let lo = s, hi = e - 1;
  while (hi > lo) {
    const a = key(lo), m = key((lo + hi) >> 1), z = key(hi);
    const pivot = a < m ? (m < z ? m : a < z ? z : a) : (a < z ? a : m < z ? z : m);
    let i = lo, j = hi;
    while (i <= j) {
      while (key(i) < pivot) i++;
      while (key(j) > pivot) j--;
      if (i <= j) {
        const t = order[i]!; order[i] = order[j]!; order[j] = t;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

/** Slab test; returns [tmin, tmax] of the ray within the box or null. */
function rayBox(
  bounds: Float64Array,
  node: number,
  o: Vec3,
  inv: Vec3,
  pad: number,
  maxT: number,
): [number, number] | null {
  let tmin = 0, tmax = maxT;
  const b = node * 6;
  for (let k = 0; k < 3; k++) {
    const lo = bounds[b + k]! - pad, hi = bounds[b + 3 + k]! + pad;
    // An empty tree's root is the inverted box [+Inf, -Inf]; a general ray must not pass it.
    if (lo > hi) return null;
    const ik = inv[k]!;
    if (ik === Infinity || ik === -Infinity) {
      if (o[k]! < lo || o[k]! > hi) return null;
      continue;
    }
    let t1 = (lo - o[k]!) * ik, t2 = (hi - o[k]!) * ik;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return [tmin, tmax];
}

// ---------------------------------------------------------------------------------------------
// Triangles

export function buildTriBVH(mesh: MeshData, opts?: BuildOptions): BVH {
  const n = mesh.tris.length / 3;
  const pb = new Float64Array(n * 6), cen = new Float64Array(n * 3);
  const p = mesh.verts, t = mesh.tris;
  for (let i = 0; i < n; i++) {
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = t[i * 3 + k]! * 3;
      const x = p[v]!, y = p[v + 1]!, z = p[v + 2]!;
      minx = Math.min(minx, x); miny = Math.min(miny, y); minz = Math.min(minz, z);
      maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); maxz = Math.max(maxz, z);
    }
    const o = i * 6, c = i * 3;
    pb[o] = minx; pb[o + 1] = miny; pb[o + 2] = minz; pb[o + 3] = maxx; pb[o + 4] = maxy; pb[o + 5] = maxz;
    cen[c] = (minx + maxx) / 2; cen[c + 1] = (miny + maxy) / 2; cen[c + 2] = (minz + maxz) / 2;
  }
  return buildBVH(pb, cen, opts);
}

export interface TriHit {
  tri: number;
  t: number;
  point: MVec3;
}

/** Nearest triangle hit along the ray (front and back faces). */
export function raycastTriBVH(bvh: BVH, mesh: MeshData, ray: Ray, maxT = Infinity): TriHit | null {
  if (bvh.order.length === 0) return null;
  const inv: Vec3 = [1 / ray.dir[0], 1 / ray.dir[1], 1 / ray.dir[2]];
  let best: TriHit | null = null;
  let limit = maxT;
  const stack: number[] = [0];
  const p = mesh.verts, t = mesh.tris;
  while (stack.length) {
    const node = stack.pop()!;
    const r = rayBox(bvh.bounds, node, ray.origin, inv, 0, limit);
    if (!r) continue;
    if (bvh.count[node]! > 0) {
      const s = bvh.start[node]!, e = s + bvh.count[node]!;
      for (let i = s; i < e; i++) {
        const tri = bvh.order[i]!;
        const a = t[tri * 3]! * 3, b = t[tri * 3 + 1]! * 3, c = t[tri * 3 + 2]! * 3;
        const hit = rayTriangle(
          ray,
          [p[a]!, p[a + 1]!, p[a + 2]!],
          [p[b]!, p[b + 1]!, p[b + 2]!],
          [p[c]!, p[c + 1]!, p[c + 2]!],
        );
        if (hit !== null && hit < limit) {
          limit = hit;
          best = { tri, t: hit, point: rayAt(ray, hit) };
        }
      }
    } else {
      // visit nearer child first
      const l = bvh.left[node]!, rr = bvh.right[node]!;
      const rl = rayBox(bvh.bounds, l, ray.origin, inv, 0, limit);
      const rrr = rayBox(bvh.bounds, rr, ray.origin, inv, 0, limit);
      if (rl && rrr) {
        if (rl[0] < rrr[0]) {
          stack.push(rr, l);
        } else stack.push(l, rr);
      } else if (rl) stack.push(l);
      else if (rrr) stack.push(rr);
    }
  }
  return best;
}

export interface BVHHit {
  prim: number;
  t: number;
}

/**
 * Nearest primitive along the ray by a caller-supplied exact test: `test(prim, limit)` returns the
 * ray parameter of a hit strictly below `limit` or null. Only primitives whose own bounds the ray
 * crosses before the current best are tested, nearer children first, so most are never tested.
 */
export function raycastBVH(bvh: BVH, ray: Ray, test: (prim: number, limit: number) => number | null, maxT = Infinity): BVHHit | null {
  if (bvh.order.length === 0) return null;
  const inv: Vec3 = [1 / ray.dir[0], 1 / ray.dir[1], 1 / ray.dir[2]];
  let best: BVHHit | null = null;
  let limit = maxT;
  const stack: number[] = [0];
  while (stack.length) {
    const node = stack.pop()!;
    if (!rayBox(bvh.bounds, node, ray.origin, inv, 0, limit)) continue;
    if (bvh.count[node]! > 0) {
      const s = bvh.start[node]!, e = s + bvh.count[node]!;
      for (let i = s; i < e; i++) {
        const prim = bvh.order[i]!;
        if (!rayBox(bvh.primBounds, prim, ray.origin, inv, 0, limit)) continue;
        const t = test(prim, limit);
        if (t !== null && t < limit) {
          limit = t;
          best = { prim, t };
        }
      }
    } else {
      const l = bvh.left[node]!, rr = bvh.right[node]!;
      const rl = rayBox(bvh.bounds, l, ray.origin, inv, 0, limit);
      const rrr = rayBox(bvh.bounds, rr, ray.origin, inv, 0, limit);
      if (rl && rrr) {
        if (rl[0] < rrr[0]) stack.push(rr, l);
        else stack.push(l, rr);
      } else if (rl) stack.push(l);
      else if (rrr) stack.push(rr);
    }
  }
  return best;
}

/** BVH over axis-aligned boxes (6 floats per box: min xyz, max xyz); primitive i is box i. */
export function buildBoxBVH(boxes: Float64Array, opts?: BuildOptions): BVH {
  const n = boxes.length / 6;
  const cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const b = i * 6;
    cen.set([(boxes[b]! + boxes[b + 3]!) / 2, (boxes[b + 1]! + boxes[b + 4]!) / 2, (boxes[b + 2]! + boxes[b + 5]!) / 2], i * 3);
  }
  return buildBVH(boxes, cen, opts);
}

// ---------------------------------------------------------------------------------------------
// Segments

export interface Segment3 {
  a: Vec3;
  b: Vec3;
}

export function buildSegBVH(segments: readonly Segment3[], opts?: BuildOptions): BVH {
  const [pb, cen] = segmentBounds(segments);
  return buildBVH(pb, cen, opts);
}

/** `buildSegBVH` that yields between large subtrees (see `buildBVHSteps`). */
export function* buildSegBVHSteps(segments: readonly Segment3[], opts?: BuildOptions): Generator<void, BVH, void> {
  const [pb, cen] = segmentBounds(segments);
  yield;
  return yield* buildBVHSteps(pb, cen, opts);
}

function segmentBounds(segments: readonly Segment3[]): [Float64Array, Float64Array] {
  const n = segments.length;
  const pb = new Float64Array(n * 6), cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { a, b } = segments[i]!;
    const p = i * 6, c = i * 3;
    pb[p] = Math.min(a[0], b[0]); pb[p + 1] = Math.min(a[1], b[1]); pb[p + 2] = Math.min(a[2], b[2]);
    pb[p + 3] = Math.max(a[0], b[0]); pb[p + 4] = Math.max(a[1], b[1]); pb[p + 5] = Math.max(a[2], b[2]);
    cen[c] = (a[0] + b[0]) / 2; cen[c + 1] = (a[1] + b[1]) / 2; cen[c + 2] = (a[2] + b[2]) / 2;
  }
  return [pb, cen];
}

export interface SegHit {
  seg: number;
  /** Ray parameter of the closest approach. */
  t: number;
  /** Segment parameter (0..1) of the closest approach. */
  s: number;
  point: MVec3;
  distSq: number;
}

/**
 * All segments passing within `radiusFn(t)` of the ray, where t is the ray parameter at the closest
 * approach (lets callers use a perspective-dependent pick radius). Sorted by t.
 */
export function querySegBVHRay(
  bvh: BVH,
  segments: readonly Segment3[],
  ray: Ray,
  radiusFn: (t: number) => number,
  maxT = Infinity,
): SegHit[] {
  const inv: Vec3 = [1 / ray.dir[0], 1 / ray.dir[1], 1 / ray.dir[2]];
  const hits: SegHit[] = [];
  const stack: number[] = [0];
  while (stack.length) {
    const node = stack.pop()!;
    // conservative pad: the largest radius over the box's extent along the ray
    const b = node * 6;
    let tFar = 0;
    for (let k = 0; k < 8; k++) {
      const cx = (k & 1 ? bvh.bounds[b + 3] : bvh.bounds[b])!;
      const cy = (k & 2 ? bvh.bounds[b + 4] : bvh.bounds[b + 1])!;
      const cz = (k & 4 ? bvh.bounds[b + 5] : bvh.bounds[b + 2])!;
      const proj = (cx - ray.origin[0]) * ray.dir[0] + (cy - ray.origin[1]) * ray.dir[1] + (cz - ray.origin[2]) * ray.dir[2];
      if (proj > tFar) tFar = proj;
    }
    if (!Number.isFinite(tFar)) continue;
    const pad = Math.max(radiusFn(0), radiusFn(Math.min(tFar, maxT)));
    if (!rayBox(bvh.bounds, node, ray.origin, inv, pad, maxT + pad)) continue;
    if (bvh.count[node]! > 0) {
      const s = bvh.start[node]!, e = s + bvh.count[node]!;
      for (let i = s; i < e; i++) {
        const seg = bvh.order[i]!;
        const sg = segments[seg]!;
        const c = raySegmentClosest(ray, sg.a, sg.b);
        if (c.t > maxT) continue;
        const r = radiusFn(c.t);
        if (c.distSq <= r * r) hits.push({ seg, t: c.t, s: c.s, point: rayAt(ray, c.t), distSq: c.distSq });
      }
    } else {
      stack.push(bvh.left[node]!, bvh.right[node]!);
    }
  }
  hits.sort((x, y) => x.t - y.t);
  return hits;
}

/** Primitive ids whose bounds overlap the box. */
export function queryBVHBox(bvh: BVH, min: Vec3, max: Vec3): number[] {
  const out: number[] = [];
  const stack: number[] = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const b = node * 6;
    if (
      bvh.bounds[b]! > max[0] || bvh.bounds[b + 3]! < min[0] ||
      bvh.bounds[b + 1]! > max[1] || bvh.bounds[b + 4]! < min[1] ||
      bvh.bounds[b + 2]! > max[2] || bvh.bounds[b + 5]! < min[2]
    )
      continue;
    if (bvh.count[node]! > 0) {
      const s = bvh.start[node]!, e = s + bvh.count[node]!;
      for (let i = s; i < e; i++) {
        const id = bvh.order[i]!, p = id * 6, pb = bvh.primBounds;
        if (
          pb[p]! > max[0] || pb[p + 3]! < min[0] ||
          pb[p + 1]! > max[1] || pb[p + 4]! < min[1] ||
          pb[p + 2]! > max[2] || pb[p + 5]! < min[2]
        )
          continue;
        out.push(id);
      }
    } else stack.push(bvh.left[node]!, bvh.right[node]!);
  }
  return out;
}
