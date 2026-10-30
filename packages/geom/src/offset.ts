// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec2, Vec2 } from '@pushform/core';
import { LENGTH_TOL } from '@pushform/core';
import { planarArrangement, type Arrangement, type ArrangementSegment } from './planarArrangement';
import { pointInRing, signedArea, type PolygonsWithHoles, type Ring } from './polygon2d';
import { polygonInteriorPoint } from './triangulate';

/**
 * Polygon offset (Offset tool) for simple polygons with holes.
 *
 * Every edge is offset along its right-hand normal (outward for a CCW outer ring, into the hole
 * for a CW hole ring, so `distance > 0` always grows the polygon and `distance < 0` shrinks it).
 * Consecutive offset edges are joined by intersecting their lines (mitre); a mitre longer than
 * `mitreLimit · |distance|` is replaced by a bevel. Edge runs tagged with an arc are offset as
 * concentric arcs (same center, radius ± d, same segment count) so circles stay circles.
 *
 * The raw offset curve self-intersects wherever features are smaller than the offset; `cleanup`
 * builds its planar arrangement and keeps the cells with positive winding number (the same
 * positive-fill rule polygon-clipping offsetters use), then dissolves shared cell edges back
 * into rings. The result may split into several polygons (inward offset of a dumbbell) or
 * vanish entirely (offset larger than the inradius).
 */

/** Arc metadata for an edge of an input ring: edges with the same `key` form one arc run. */
export interface OffsetArc {
  readonly key: number | string;
  readonly center: Vec2;
  readonly radius: number;
}

export interface OffsetOptions {
  /** Mitre length cap in multiples of |distance|; longer corners are bevelled. Default 8. */
  readonly mitreLimit?: number | undefined;
  /** Resolve self-intersections (default true). False returns the raw mitred rings ("allow overlaps"). */
  readonly cleanup?: boolean | undefined;
  /** Snapping tolerance for the arrangement. Default `LENGTH_TOL`. */
  readonly tol?: number | undefined;
  /**
   * Arc tags per ring and per edge (edge `i` runs from point `i` to point `i + 1`), parallel to
   * the input polygon. Rings or edges without a tag are offset as straight edges.
   */
  readonly arcs?: readonly (readonly (OffsetArc | null)[] | undefined)[] | undefined;
}

export interface OffsetResult {
  /** Resulting polygons (outer CCW, holes CW), largest area first. */
  readonly polygons: PolygonsWithHoles[];
  /** Arc tag of every output edge, parallel to `polygons` (`tags[p][ring][edge]`). */
  readonly tags: (OffsetArc | null)[][][];
}

const DEFAULT_MITRE_LIMIT = 8;

interface RawRing {
  points: MVec2[];
  /** Tag of the edge leaving each point. */
  tags: (OffsetArc | null)[];
}

// ---------------------------------------------------------------------------------------------
// public API

/** Offset a polygon with holes; returns the largest resulting polygon (`[]` when it vanished). */
export function offsetPolygon(poly: PolygonsWithHoles, distance: number, opts: OffsetOptions = {}): PolygonsWithHoles {
  return offsetPolygonFull(poly, distance, opts).polygons[0] ?? [];
}

/** Offset a polygon with holes; returns every resulting polygon with per-edge arc tags. */
export function offsetPolygonFull(poly: PolygonsWithHoles, distance: number, opts: OffsetOptions = {}): OffsetResult {
  const tol = opts.tol ?? LENGTH_TOL;
  const mitreLimit = opts.mitreLimit ?? DEFAULT_MITRE_LIMIT;
  const cleanup = opts.cleanup !== false && distance !== 0;
  const rings: RawRing[] = [];
  poly.forEach((ring, ri) => {
    if (ring.length < 3) return;
    const pts: MVec2[] = ring.map((p) => [p[0]!, p[1]!]);
    let tags: (OffsetArc | null)[] = (opts.arcs?.[ri] ?? []).slice();
    while (tags.length < pts.length) tags.push(null);
    const area = signedArea(pts);
    if (area === 0) return;
    const wantCCW = ri === 0;
    if (area > 0 !== wantCCW) {
      pts.reverse();
      const n = pts.length;
      tags = tags.map((_, j) => tags[(2 * n - 2 - j) % n] ?? null);
    }
    rings.push(offsetRingRaw(pts, tags, distance, mitreLimit, cleanup));
  });
  if (!cleanup) {
    const polygons = rings.map((r) => r.points.map((p): number[] => [p[0], p[1]]));
    return polygons.length ? { polygons: [polygons], tags: [rings.map((r) => r.tags)] } : { polygons: [], tags: [] };
  }
  return cleanupRings(rings, tol);
}

/**
 * Offset an open polyline: `distance > 0` moves it to the right of its travel direction. Joins
 * are mitred (bevelled past `mitreLimit`); the ends are not capped.
 */
export function offsetPolyline(points: readonly Vec2[], distance: number, opts: OffsetOptions = {}): MVec2[] {
  const mitreLimit = opts.mitreLimit ?? DEFAULT_MITRE_LIMIT;
  const pts = dedupe(points);
  const n = pts.length;
  if (n < 2) return pts;
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < n; i++) segs.push(offsetStraight(pts[i]!, pts[i + 1]!, distance));
  const out: MVec2[] = [segs[0]!.a];
  for (let i = 0; i + 1 < segs.length; i++) {
    const j = join(segs[i]!, segs[i + 1]!, pts[i + 1]!, Math.abs(distance) * mitreLimit, false, false);
    for (const p of j) out.push(p);
  }
  out.push(segs[segs.length - 1]!.b);
  return out;
}

// ---------------------------------------------------------------------------------------------
// raw offset

interface Seg {
  a: MVec2;
  b: MVec2;
  tag: OffsetArc | null;
}

function dedupe(points: readonly Vec2[]): MVec2[] {
  const out: MVec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) <= LENGTH_TOL) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

function offsetStraight(a: Vec2, b: Vec2, d: number): Seg {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  // right-hand normal of the travel direction
  const nx = dy / l, ny = -dx / l;
  return { a: [a[0] + nx * d, a[1] + ny * d], b: [b[0] + nx * d, b[1] + ny * d], tag: null };
}

function offsetArcEdge(a: Vec2, b: Vec2, d: number, arc: OffsetArc): Seg {
  const c = arc.center;
  const r = arc.radius;
  if (!(r > LENGTH_TOL)) return offsetStraight(a, b, d);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = dy / l, ny = -dx / l;
  const mx = (a[0] + b[0]) / 2 - c[0], my = (a[1] + b[1]) / 2 - c[1];
  // the offset grows the radius when the right-hand normal points away from the center
  const s = nx * mx + ny * my >= 0 ? 1 : -1;
  const r2 = Math.max(0, r + s * d);
  const k = r2 / r;
  const scale = (p: Vec2): MVec2 => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  return { a: scale(a), b: scale(b), tag: arc };
}

/** Intersection of the infinite lines through two segments, or null when (nearly) parallel. */
function lineLine(s: Seg, t: Seg): MVec2 | null {
  const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1];
  const qx = t.b[0] - t.a[0], qy = t.b[1] - t.a[1];
  const denom = rx * qy - ry * qx;
  const rl = Math.hypot(rx, ry), ql = Math.hypot(qx, qy);
  if (rl === 0 || ql === 0 || Math.abs(denom) <= 1e-12 * rl * ql) return null;
  const wx = t.a[0] - s.a[0], wy = t.a[1] - s.a[1];
  const u = (wx * qy - wy * qx) / denom;
  return [s.a[0] + rx * u, s.a[1] + ry * u];
}

/**
 * Points joining offset edge `s` to `t` at the original vertex `v` (excluding `s.a` and `t.b`):
 * one mitre point, or the bevel pair `[s.b, t.a]`. Arc runs join on their shared endpoint.
 *
 * `concave`: the corner is concave relative to the offset direction (the offset edges cross or
 * overlap). With cleanup the original vertex is inserted between the two offset endpoints
 * (`[s.b, v, t.a]`, Clipper's trick): a feature smaller than the offset then flips into an
 * explicit self-intersecting loop of negative winding instead of an inverted CCW ring that the
 * winding rule could not tell from a valid one.
 */
function join(s: Seg, t: Seg, v: Vec2, mitreMax: number, sameArc: boolean, concave: boolean): MVec2[] {
  if (sameArc) return [s.b];
  const dist = Math.hypot(s.b[0] - t.a[0], s.b[1] - t.a[1]);
  if (dist <= LENGTH_TOL) return [s.b];
  if (concave) return [s.b, [v[0], v[1]], t.a];
  const x = lineLine(s, t);
  if (!x) return [s.b, t.a];
  const ml = Math.hypot(x[0] - v[0], x[1] - v[1]);
  if (ml > mitreMax) return [s.b, t.a];
  return [x];
}

function offsetRingRaw(pts: MVec2[], tags: (OffsetArc | null)[], d: number, mitreLimit: number, markConcave: boolean): RawRing {
  const n = pts.length;
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const tag = tags[i] ?? null;
    segs.push(tag ? offsetArcEdge(a, b, d, tag) : offsetStraight(a, b, d));
  }
  const mitreMax = Math.abs(d) * mitreLimit;
  const outPts: MVec2[] = [];
  const outTags: (OffsetArc | null)[] = [];
  for (let i = 0; i < n; i++) {
    // join at vertex i between edge i-1 and edge i, then edge i itself leaves the last point
    const p0 = pts[(i + n - 1) % n]!, p1 = pts[i]!, p2 = pts[(i + 1) % n]!;
    const prev = segs[(i + n - 1) % n]!, cur = segs[i]!;
    const sameArc = prev.tag !== null && cur.tag !== null && prev.tag.key === cur.tag.key;
    const cross = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
    const concave = markConcave && cross * d < 0;
    const j = join(prev, cur, p1, mitreMax, sameArc, concave);
    for (let k = 0; k < j.length; k++) {
      outPts.push(j[k]!);
      if (k + 1 < j.length) outTags.push(null); // bevel / vertex spike edges carry no arc
    }
    outTags.push(cur.tag);
  }
  return { points: outPts, tags: outTags };
}

// ---------------------------------------------------------------------------------------------
// cleanup

/** Winding number of `p` with respect to the raw rings (positive for CCW enclosure). */
function windingNumber(p: Vec2, rings: readonly RawRing[]): number {
  let wn = 0;
  for (const r of rings) {
    const pts = r.points;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!, b = pts[(i + 1) % n]!;
      const isLeft = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) {
        if (b[1] > p[1] && isLeft > 0) wn++;
      } else if (b[1] <= p[1] && isLeft < 0) wn--;
    }
  }
  return wn;
}

function cleanupRings(rings: RawRing[], tol: number): OffsetResult {
  const segments: ArrangementSegment[] = [];
  const tagById: (OffsetArc | null)[] = [];
  for (const r of rings) {
    const n = r.points.length;
    for (let i = 0; i < n; i++) {
      const a = r.points[i]!, b = r.points[(i + 1) % n]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol) continue;
      tagById.push(r.tags[i] ?? null);
      segments.push({ id: segments.length, a, b });
    }
  }
  if (!segments.length) return { polygons: [], tags: [] };
  const arr = planarArrangement(segments, { tol });

  // cells of the true offset region: positive winding of the raw curve
  const usage = new Map<number, number>();
  let kept = 0;
  for (const cell of arr.cells) {
    const ip = polygonInteriorPoint([cell.outer, ...cell.holes]);
    if (!ip || windingNumber(ip, rings) <= 0) continue;
    kept++;
    for (const ref of cell.outerEdges) usage.set(ref.edge, (usage.get(ref.edge) ?? 0) + (ref.forward ? 1 : -1));
    for (const hole of cell.holeEdges) for (const ref of hole) usage.set(ref.edge, (usage.get(ref.edge) ?? 0) + (ref.forward ? 1 : -1));
  }
  if (!kept) return { polygons: [], tags: [] };

  // dissolve shared edges: the boundary is every edge used in one direction only
  const loops = chainBoundary(arr, usage);
  interface Out {
    ring: MVec2[];
    tags: (OffsetArc | null)[];
    area: number;
  }
  const outers: Out[] = [], holes: Out[] = [];
  for (const l of loops) {
    const ring = l.verts.map((v): MVec2 => [arr.vertices[v]![0], arr.vertices[v]![1]]);
    const area = signedArea(ring);
    if (Math.abs(area) <= tol * tol) continue;
    const tags = l.edges.map((e) => tagById[arr.edges[e]!.segs[0]!.id] ?? null);
    (area > 0 ? outers : holes).push({ ring, tags, area });
  }
  outers.sort((a, b) => b.area - a.area);
  const result: { rings: Ring[]; tags: (OffsetArc | null)[][]; area: number }[] = outers.map((o) => ({
    rings: [o.ring.map((p): number[] => [p[0], p[1]])],
    tags: [o.tags],
    area: o.area,
  }));
  for (const h of holes) {
    const p = h.ring[0]!;
    // smallest containing outer
    let best = -1;
    for (let i = outers.length - 1; i >= 0; i--) {
      if (pointInRing(p, outers[i]!.ring)) {
        best = i;
        break;
      }
    }
    if (best < 0) continue;
    result[best]!.rings.push(h.ring.map((p2): number[] => [p2[0], p2[1]]));
    result[best]!.tags.push(h.tags);
    result[best]!.area += h.area;
  }
  result.sort((a, b) => b.area - a.area);
  return { polygons: result.map((r) => r.rings), tags: result.map((r) => r.tags) };
}

interface BoundaryLoop {
  verts: number[];
  edges: number[];
}

/** Chain directed boundary edges (usage ≠ 0) into closed loops, keeping the region on the left. */
function chainBoundary(arr: Arrangement, usage: Map<number, number>): BoundaryLoop[] {
  interface Half {
    edge: number;
    from: number;
    to: number;
    used: boolean;
  }
  const halves: Half[] = [];
  const outgoing = new Map<number, Half[]>();
  for (const [e, u] of usage) {
    if (u === 0) continue;
    const edge = arr.edges[e]!;
    const h: Half = u > 0 ? { edge: e, from: edge.a, to: edge.b, used: false } : { edge: e, from: edge.b, to: edge.a, used: false };
    halves.push(h);
    const list = outgoing.get(h.from);
    if (list) list.push(h);
    else outgoing.set(h.from, [h]);
  }
  const angleOf = (from: number, to: number): number => {
    const p = arr.vertices[from]!, q = arr.vertices[to]!;
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  };
  const loops: BoundaryLoop[] = [];
  for (const start of halves) {
    if (start.used) continue;
    const loop: BoundaryLoop = { verts: [], edges: [] };
    let h: Half | undefined = start;
    let guard = 0;
    while (h && !h.used && guard++ <= halves.length) {
      h.used = true;
      loop.verts.push(h.from);
      loop.edges.push(h.edge);
      const candidates: Half[] = (outgoing.get(h.to) ?? []).filter((c) => !c.used);
      if (candidates.length <= 1) {
        h = candidates[0];
        continue;
      }
      // several ways out (cells touching at a vertex): the region is on the left, so take the
      // sharpest left turn = the first edge met rotating clockwise from the way we came
      // (largest CCW angle from `back`)
      const back = angleOf(h.to, h.from);
      let best: Half | undefined, bestTurn = -Infinity;
      for (const c of candidates) {
        let turn = angleOf(c.from, c.to) - back;
        while (turn <= 0) turn += 2 * Math.PI;
        while (turn > 2 * Math.PI) turn -= 2 * Math.PI;
        if (turn > bestTurn) {
          bestTurn = turn;
          best = c;
        }
      }
      h = best;
    }
    if (loop.verts.length >= 3) loops.push(loop);
  }
  return loops;
}
