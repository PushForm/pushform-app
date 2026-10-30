// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec2, Vec2 } from '@pushform/core';
import { pointSegmentClosest2D, segSegIntersect2D } from './intersections';
import { pointInRing, signedArea } from './polygon2d';

/** Input segment with a caller-defined id (ids need not be unique: duplicates merge). */
export interface ArrangementSegment {
  id: number;
  a: Vec2;
  b: Vec2;
}
export interface ArrangementOptions {
  /** Snapping distance for vertices, T-junctions and crossings. */
  tol?: number;
  /** Cells with |area| below this are discarded. Default tol². */
  areaTol?: number;
}
/** A sub-edge of the arrangement graph between two arrangement vertices. */
export interface ArrangementEdge {
  a: number;
  b: number;
  /** Original segments covering this sub-edge; `forward` = the segment runs a→b. */
  segs: { id: number; forward: boolean }[];
}
/** Reference to a sub-edge traversed in a ring; `forward` = traversed a→b. */
export interface ArrangementEdgeRef {
  edge: number;
  forward: boolean;
}
export interface ArrangementCell {
  /** Outer ring, CCW. */
  outer: MVec2[];
  /** Holes, CW (boundaries of isolated inner components). */
  holes: MVec2[][];
  outerVertices: number[];
  holeVertices: number[][];
  outerEdges: ArrangementEdgeRef[];
  holeEdges: ArrangementEdgeRef[][];
  /** Original segment ids that appear on the outer ring or any hole (unique). */
  segIds: number[];
  /** Positive area of the outer ring minus holes. */
  area: number;
}
export interface Arrangement {
  vertices: MVec2[];
  edges: ArrangementEdge[];
  cells: ArrangementCell[];
}

/** Tolerance-snapping 2D point hash (cell = tol, 9-neighbourhood search). */
class PointHash2 {
  private cells = new Map<string, number[]>();
  readonly points: MVec2[] = [];
  constructor(private readonly tol: number) {}
  getOrAdd(p: Vec2): number {
    const t = this.tol;
    const cx = Math.floor(p[0] / t), cy = Math.floor(p[1] / t);
    let best = -1, bestD = t * t;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const i of list) {
          const q = this.points[i]!;
          const ex = q[0] - p[0], ey = q[1] - p[1];
          const d = ex * ex + ey * ey;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = this.points.length;
    this.points.push([p[0], p[1]]);
    const k = `${cx},${cy}`;
    const list = this.cells.get(k);
    if (list) list.push(id);
    else this.cells.set(k, [id]);
    return id;
  }
}

/**
 * Interior split parameters for every segment: crossings, T-junctions and collinear overlaps.
 * O(n²) with a bounding-box reject; replaceable by a sweep with the same contract.
 */
export function computeSegmentSplits(segments: readonly ArrangementSegment[], tol: number): number[][] {
  const n = segments.length;
  const splits: number[][] = segments.map(() => []);
  const bb = new Float64Array(n * 4);
  const len = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = segments[i]!;
    bb[i * 4] = Math.min(s.a[0], s.b[0]) - tol;
    bb[i * 4 + 1] = Math.min(s.a[1], s.b[1]) - tol;
    bb[i * 4 + 2] = Math.max(s.a[0], s.b[0]) + tol;
    bb[i * 4 + 3] = Math.max(s.a[1], s.b[1]) + tol;
    len[i] = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  }
  const t2 = tol * tol;
  const endpointOn = (p: Vec2, k: number): void => {
    const s = segments[k]!;
    const l = len[k]!;
    if (l <= tol) return;
    const c = pointSegmentClosest2D(p, s.a, s.b);
    if (c.distSq > t2) return;
    const d = c.t * l;
    if (d > tol && l - d > tol) splits[k]!.push(c.t);
  };
  for (let i = 0; i < n; i++) {
    if (len[i]! <= tol) continue;
    const si = segments[i]!;
    for (let j = i + 1; j < n; j++) {
      if (len[j]! <= tol) continue;
      if (
        bb[i * 4]! > bb[j * 4 + 2]! ||
        bb[j * 4]! > bb[i * 4 + 2]! ||
        bb[i * 4 + 1]! > bb[j * 4 + 3]! ||
        bb[j * 4 + 1]! > bb[i * 4 + 3]!
      )
        continue;
      const sj = segments[j]!;
      endpointOn(sj.a, i);
      endpointOn(sj.b, i);
      endpointOn(si.a, j);
      endpointOn(si.b, j);
      const r = segSegIntersect2D(si.a, si.b, sj.a, sj.b, tol);
      if (r.kind === 'point') {
        const di = r.t * len[i]!, dj = r.s * len[j]!;
        const innerI = di > tol && len[i]! - di > tol;
        const innerJ = dj > tol && len[j]! - dj > tol;
        if (innerI && innerJ) {
          splits[i]!.push(r.t);
          splits[j]!.push(r.s);
        }
      }
    }
  }
  return splits;
}

/**
 * Build the planar arrangement of a set of segments: snap vertices, split at crossings and
 * T-junctions, build a half-edge graph and enumerate bounded faces (cells) with holes.
 */
export function planarArrangement(
  segments: readonly ArrangementSegment[],
  opts: ArrangementOptions = {},
): Arrangement {
  const tol = opts.tol ?? 1e-9;
  const areaTol = opts.areaTol ?? tol * tol;
  const vh = new PointHash2(tol);
  const splits = computeSegmentSplits(segments, tol);

  // --- sub-edges
  const edges: ArrangementEdge[] = [];
  const edgeByPair = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const va = vh.getOrAdd(s.a), vb = vh.getOrAdd(s.b);
    if (va === vb) continue;
    const ts = splits[i]!.slice().sort((x, y) => x - y);
    const chain: number[] = [va];
    for (const t of ts) {
      const p: Vec2 = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
      const v = vh.getOrAdd(p);
      if (v !== chain[chain.length - 1]) chain.push(v);
    }
    if (vb !== chain[chain.length - 1]) chain.push(vb);
    for (let k = 0; k + 1 < chain.length; k++) {
      const u = chain[k]!, v = chain[k + 1]!;
      if (u === v) continue;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const existing = edgeByPair.get(key);
      if (existing !== undefined) {
        const e = edges[existing]!;
        e.segs.push({ id: s.id, forward: e.a === u });
      } else {
        edgeByPair.set(key, edges.length);
        edges.push({ a: u, b: v, segs: [{ id: s.id, forward: true }] });
      }
    }
  }
  const vertices = vh.points;

  // --- half-edges: h = 2e (a→b), 2e+1 (b→a)
  const H = edges.length * 2;
  const heFrom = new Int32Array(H), heTo = new Int32Array(H);
  const outgoing: number[][] = vertices.map(() => []);
  for (let e = 0; e < edges.length; e++) {
    const { a, b } = edges[e]!;
    heFrom[2 * e] = a;
    heTo[2 * e] = b;
    heFrom[2 * e + 1] = b;
    heTo[2 * e + 1] = a;
    outgoing[a]!.push(2 * e);
    outgoing[b]!.push(2 * e + 1);
  }
  const angleOf = (h: number): number => {
    const p = vertices[heFrom[h]!]!, q = vertices[heTo[h]!]!;
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  };
  const heNext = new Int32Array(H);
  for (const list of outgoing) {
    list.sort((x, y) => angleOf(x) - angleOf(y));
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const h = list[i]!; // outgoing at v; its twin arrives at v
      const twin = h ^ 1;
      // next of `twin` (arriving at v) is the outgoing edge clockwise from h: list[i-1]
      heNext[twin] = list[(i - 1 + n) % n]!;
    }
  }

  // --- connected components (union-find on vertices)
  const parent = new Int32Array(vertices.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }

  // --- cycles
  interface Cycle {
    hes: number[];
    verts: number[];
    area: number;
    component: number;
  }
  const visited = new Uint8Array(H);
  const positive: Cycle[] = [], negative: Cycle[] = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (visited[h0]) continue;
    const raw: number[] = [];
    let h = h0;
    do {
      visited[h] = 1;
      raw.push(h);
      h = heNext[h]!;
    } while (h !== h0 && raw.length <= H);
    // strip spurs (edge immediately followed by its twin), including wrap-around
    const st: number[] = [];
    for (const x of raw) {
      if (st.length && st[st.length - 1] === (x ^ 1)) st.pop();
      else st.push(x);
    }
    while (st.length >= 2 && st[0] === (st[st.length - 1]! ^ 1)) {
      st.shift();
      st.pop();
    }
    if (st.length < 3) continue;
    const verts = st.map((x) => heFrom[x]!);
    const ring = verts.map((v) => vertices[v]!);
    const area = signedArea(ring);
    if (Math.abs(area) <= areaTol) continue;
    const cycle: Cycle = { hes: st, verts, area, component: find(verts[0]!) };
    (area > 0 ? positive : negative).push(cycle);
  }

  // --- assign holes (negative cycles) to the smallest containing positive cycle of another component
  const holesOf: Cycle[][] = positive.map(() => []);
  for (const hole of negative) {
    const p = vertices[hole.verts[0]!]!;
    let best = -1, bestArea = Infinity;
    for (let i = 0; i < positive.length; i++) {
      const c = positive[i]!;
      if (c.component === hole.component || c.area >= bestArea) continue;
      if (pointInRing(p, c.verts.map((v) => vertices[v]!))) {
        best = i;
        bestArea = c.area;
      }
    }
    if (best >= 0) holesOf[best]!.push(hole);
  }

  const refsOf = (hes: number[]): ArrangementEdgeRef[] =>
    hes.map((h) => ({ edge: h >> 1, forward: (h & 1) === 0 }));
  const cells: ArrangementCell[] = positive.map((c, i) => {
    const holes = holesOf[i]!;
    const segIds = new Set<number>();
    const addIds = (hes: number[]): void => {
      for (const h of hes) for (const s of edges[h >> 1]!.segs) segIds.add(s.id);
    };
    addIds(c.hes);
    let area = c.area;
    for (const h of holes) {
      addIds(h.hes);
      area += h.area;
    }
    return {
      outer: c.verts.map((v) => [vertices[v]![0], vertices[v]![1]] as MVec2),
      holes: holes.map((h) => h.verts.map((v) => [vertices[v]![0], vertices[v]![1]] as MVec2)),
      outerVertices: c.verts.slice(),
      holeVertices: holes.map((h) => h.verts.slice()),
      outerEdges: refsOf(c.hes),
      holeEdges: holes.map((h) => refsOf(h.hes)),
      segIds: [...segIds],
      area,
    };
  });

  return { vertices, edges, cells };
}

/** Map a ring of arrangement edge refs back to original segment ids with direction. */
export function ringSegmentRefs(
  arr: Arrangement,
  refs: readonly ArrangementEdgeRef[],
): { id: number; forward: boolean }[] {
  const out: { id: number; forward: boolean }[] = [];
  for (const r of refs) {
    const e = arr.edges[r.edge]!;
    const s = e.segs[0]!;
    out.push({ id: s.id, forward: s.forward === r.forward });
  }
  return out;
}
