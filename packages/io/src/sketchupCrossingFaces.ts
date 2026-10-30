// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { AREA_TOL, LENGTH_TOL, MERGE_TOL, basisToLocal, planeBasis, v3add, v3dist, v3dot, v3scale, v3sub, type Vec2, type Vec3 } from '@pushform/core';
import { planarArrangement, signedArea, triangulatePolygon, type ArrangementSegment } from '@pushform/geom';

/** A simple face cut from a source face: outer ring counterclockwise about the face normal, then holes. */
export interface FacePiece {
  loops: Vec3[][];
  /** Source edge id under each ring edge (from point i to point i + 1). */
  edges: number[][];
}
export interface ShadedRegion {
  pieces: FacePiece[];
  /** Points where the outline crosses or touches itself inside a source edge, by source edge id. */
  splits: Map<number, Vec3[]>;
  /** Parts of the outline that bound no shaded piece, with their source edge. */
  unshaded: { a: Vec3; b: Vec3; edge: number }[];
}

/** Winding number of a closed ring about a point. */
function winding(p: Vec2, ring: readonly Vec2[]): number {
  let w = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (a[1] <= p[1]) { if (b[1] > p[1] && side > 0) w++; } else if (b[1] <= p[1] && side < 0) w--;
  }
  return w;
}

/**
 * The region that is filled for a face whose outline crosses or touches itself, as simple faces. The loops
 * are cut at every crossing into the cells of their planar arrangement, and a cell is shaded where the outer
 * loop, counted in its own direction, winds around it more often than the holes do: the winding number of
 * the outer loop minus those of the holes is positive. This is the region the face mesh stored in the file covers,
 * unlike the outer loop's shoelace area minus the holes', which subtracts the parts the outline winds around backwards.
 * Pieces touching only at a point stay separate faces. Null when no cell has area.
 */
export function shadedRegion(loops: readonly Vec3[][], edges: readonly number[][], normal: Vec3): ShadedRegion | null {
  const basis = planeBasis(loops[0]![0]!, normal);
  const flat = loops.map(loop => loop.map((p): Vec2 => { const q = basisToLocal(basis, p); return [q[0], q[1]]; }));
  const segments: ArrangementSegment[] = [], segmentEdge: number[] = [], segmentEnds: [Vec3, Vec3][] = [];
  flat.forEach((ring, k) => ring.forEach((a, i) => {
    const j = (i + 1) % ring.length;
    segments.push({ id: segments.length, a, b: ring[j]! });
    segmentEdge.push(edges[k]![i]!);
    segmentEnds.push([loops[k]![i]!, loops[k]![j]!]);
  }));
  const arrangement = planarArrangement(segments, { tol: LENGTH_TOL, areaTol: AREA_TOL });
  // Each arrangement vertex in 3D: a source point where there is one, else a point along a source edge
  // through it, so that pieces and other faces on that edge share it exactly.
  const exact = new Map<string, Vec3>();
  flat.forEach((ring, k) => ring.forEach((p, i) => { if (!exact.has(`${p[0]},${p[1]}`)) exact.set(`${p[0]},${p[1]}`, loops[k]![i]!); }));
  const through: number[] = [];
  for (const e of arrangement.edges) for (const v of [e.a, e.b]) through[v] ??= e.segs[0]!.id;
  const lifted = arrangement.vertices.map((p, v): Vec3 => {
    const known = exact.get(`${p[0]},${p[1]}`);
    if (known) return known;
    for (const [k, ring] of flat.entries()) for (const [i, q] of ring.entries())
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= LENGTH_TOL) return loops[k]![i]!;
    const s = segments[through[v]!]!, [a, b] = segmentEnds[through[v]!]!;
    const d: Vec2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
    const t = ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]);
    return v3add(a, v3scale(v3sub(b, a), t));
  });
  // The outer loop counts in its own direction and holes against theirs, so a correctly wound face shades its usual region.
  const direction = flat.map((ring, k) => (signedArea(ring) < 0 ? -1 : 1) * (k === 0 ? 1 : -1));
  const used = new Set<number>(), pieces: FacePiece[] = [];
  for (const cell of arrangement.cells) {
    const tri = triangulatePolygon([cell.outer, ...cell.holes]);
    let best = -1, size = 0;
    const at = (i: number): Vec2 => [tri.coords[tri.indices[i]! * 2]!, tri.coords[tri.indices[i]! * 2 + 1]!];
    for (let i = 0; i < tri.indices.length; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (area > size) { size = area; best = i; }
    }
    if (best < 0) continue;
    const a = at(best), b = at(best + 1), c = at(best + 2);
    const inside: Vec2 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    if (flat.reduce((sum, ring, k) => sum + direction[k]! * winding(inside, ring), 0) <= 0) continue;
    const rings = [cell.outerEdges, ...cell.holeEdges];
    for (const ring of rings) for (const ref of ring) used.add(ref.edge);
    pieces.push({
      loops: [cell.outerVertices, ...cell.holeVertices].map(ring => ring.map(v => lifted[v]!)),
      edges: rings.map(ring => ring.map(ref => segmentEdge[arrangement.edges[ref.edge]!.segs[0]!.id]!)),
    });
  }
  if (!pieces.length) return null;
  const splits = new Map<number, Vec3[]>(), unshaded: ShadedRegion['unshaded'] = [];
  arrangement.edges.forEach((e, index) => {
    for (const { id } of e.segs) for (const v of [e.a, e.b]) {
      const p = lifted[v]!, [a, b] = segmentEnds[id]!;
      if (v3dist(p, a) <= LENGTH_TOL || v3dist(p, b) <= LENGTH_TOL) continue;
      const list = splits.get(segmentEdge[id]!) ?? splits.set(segmentEdge[id]!, []).get(segmentEdge[id]!)!;
      if (!list.some(q => v3dist(q, p) <= LENGTH_TOL)) list.push(p);
    }
    if (!used.has(index)) unshaded.push({ a: lifted[e.a]!, b: lifted[e.b]!, edge: segmentEdge[e.segs[0]!.id]! });
  });
  return { pieces, splits, unshaded };
}

/**
 * Adds the split points of each source edge to the ring edges lying on it, so that every face along an
 * edge that a crossing face splits shares the split's vertex. Returns the rings unchanged when none apply.
 */
export function insertSplits(loops: Vec3[][], edges: number[][], splits: ReadonlyMap<number, readonly Vec3[]>): FacePiece {
  if (!splits.size || !edges.some(ring => ring.some(e => splits.has(e)))) return { loops, edges };
  const out: FacePiece = { loops: [], edges: [] };
  loops.forEach((ring, k) => {
    const points: Vec3[] = [], ids: number[] = [];
    ring.forEach((a, i) => {
      const edge = edges[k]![i]!;
      for (const p of splitSegment(a, ring[(i + 1) % ring.length]!, splits.get(edge) ?? []).slice(0, -1)) { points.push(p); ids.push(edge); }
    });
    out.loops.push(points); out.edges.push(ids);
  });
  return out;
}

/** The segment from a to b through the split points strictly inside it (within the merge tolerance of it), in order. */
export function splitSegment(a: Vec3, b: Vec3, points: readonly Vec3[]): Vec3[] {
  const d = v3sub(b, a), length2 = v3dot(d, d);
  const inner = points
    .map(p => ({ p, t: v3dot(v3sub(p, a), d) / length2 }))
    .filter(({ p, t }) => t > 0 && t < 1 && v3dist(p, a) > LENGTH_TOL && v3dist(p, b) > LENGTH_TOL &&
      v3dist(p, v3add(a, v3scale(d, t))) <= MERGE_TOL)
    .sort((x, y) => x.t - y.t);
  return [a, ...inner.map(({ p }) => p), b];
}

/**
 * Adds each cut point to every other edge that runs through it within the merge tolerance (a source edge
 * overlapping or collinear with a cut edge), so faces along either edge share the cut's vertex.
 */
export function addThroughSplits(splits: Map<number, Vec3[]>, edges: readonly { id: number; v1Id: number; v2Id: number }[],
  vertices: ReadonlyMap<number, Vec3>): void {
  const points = [...splits.values()].flat().sort((p, q) => p[0] - q[0]);
  const first = (x: number): number => {
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid]![0] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const edge of edges) {
    const a = vertices.get(edge.v1Id), b = vertices.get(edge.v2Id);
    if (!a || !b) continue;
    const hi = Math.max(a[0], b[0]) + MERGE_TOL;
    for (let i = first(Math.min(a[0], b[0]) - MERGE_TOL); i < points.length && points[i]![0] <= hi; i++) {
      const p = points[i]!, list = splits.get(edge.id);
      if (list?.some(q => v3dist(q, p) <= LENGTH_TOL) || splitSegment(a, b, [p]).length !== 3) continue;
      if (list) list.push(p); else splits.set(edge.id, [p]);
    }
  }
}
