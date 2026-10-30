// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COPLANAR_TOL, MERGE_TOL, basisToLocal, basisToWorld, planeDistance } from '@pushform/core';
import type { CurveId, FaceLocalId, Id, Vec2, Vec3 } from '@pushform/core';
import { pointInPolygon, pointOnRing, pointSegmentClosest2D, segSegIntersect2D } from '@pushform/geom';
import type { Draft } from 'immer';
import type { Body, FaceRecord, ImprintEdge, ImprintGraph } from '../entities/body';
import { createImprintGraph } from '../entities/body';
import type { EntityContainer } from '../entities/definition';
import { facePolygonUv } from './Regions';

/** A body face that contains a set of points (all within COPLANAR_TOL of its plane and inside its polygon). */
export interface FaceLocation {
  readonly bodyId: Id;
  readonly faceId: FaceLocalId;
}

/** True when `p` lies on face `f` (on its plane and inside or on the boundary of its polygon). */
export function faceContainsPoint(f: FaceRecord, p: Vec3, tol = COPLANAR_TOL): boolean {
  if (Math.abs(planeDistance(f.plane, p)) > tol) return false;
  const [u, v] = basisToLocal(f.basis, p);
  const poly = facePolygonUv(f);
  if (pointInPolygon([u, v], poly)) return true;
  for (const ring of poly) if (pointOnRing([u, v], ring, MERGE_TOL)) return true;
  return false;
}

/**
 * Find the single body face (in `container`) that contains every point, or null. Used to route
 * drawn geometry into a face's imprint graph instead of the sketch (lines drawn on a
 * face split it).
 */
export function findFaceContainingPoints(container: EntityContainer, points: readonly Vec3[]): FaceLocation | null {
  if (points.length === 0) return null;
  for (const body of container.bodies.values()) {
    if (body.hidden) continue;
    for (const face of body.faces.values()) {
      if (points.every((p) => faceContainsPoint(face, p))) return { bodyId: body.id, faceId: face.id };
    }
  }
  return null;
}

/** The part of a segment, from parameter `t0` to `t1` (0 at its start, 1 at its end), that lies on a body face. */
export interface FaceSpan {
  readonly bodyId: Id;
  readonly faceId: FaceLocalId;
  readonly t0: number;
  readonly t1: number;
}

/**
 * The parts of segment a→b (container coordinates) that lie on body faces in `container`, in order along it: for
 * each face whose plane holds the whole segment, the parameter intervals inside its outline and outside its holes,
 * boundaries included. Lines are clipped to these spans when they are drawn.
 */
export function segmentFaceSpans(container: EntityContainer, a: Vec3, b: Vec3): FaceSpan[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (length <= MERGE_TOL) return [];
  const eps = MERGE_TOL / length;
  const spans: FaceSpan[] = [];
  for (const body of container.bodies.values()) {
    if (body.hidden) continue;
    for (const face of body.faces.values()) {
      if (Math.abs(planeDistance(face.plane, a)) > COPLANAR_TOL || Math.abs(planeDistance(face.plane, b)) > COPLANAR_TOL) continue;
      const poly = facePolygonUv(face);
      const [ua, va] = basisToLocal(face.basis, a), [ub, vb] = basisToLocal(face.basis, b);
      const du = ub - ua, dv = vb - va;
      const at = (t: number): Vec2 => [ua + du * t, va + dv * t];
      // where the segment crosses or touches the face's boundary
      const ts = [0, 1];
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
          const ex = q[0]! - p[0]!, ey = q[1]! - p[1]!;
          const den = du * ey - dv * ex;
          if (Math.abs(den) > 1e-15) {
            const t = ((p[0]! - ua) * ey - (p[1]! - va) * ex) / den;
            const s = ((p[0]! - ua) * dv - (p[1]! - va) * du) / den;
            if (t > -eps && t < 1 + eps && s > -1e-9 && s < 1 + 1e-9) ts.push(Math.min(1, Math.max(0, t)));
          }
          // a ring corner on the segment (also covers boundary edges running along it)
          const t = ((p[0]! - ua) * du + (p[1]! - va) * dv) / (du * du + dv * dv);
          if (t > 0 && t < 1) {
            const c = at(t);
            if (Math.hypot(c[0] - p[0]!, c[1] - p[1]!) <= MERGE_TOL) ts.push(t);
          }
        }
      }
      ts.sort((x, y) => x - y);
      const inside = (t: number): boolean => {
        const c = at(t);
        return pointInPolygon(c, poly) || poly.some((ring) => pointOnRing(c, ring, MERGE_TOL));
      };
      let open: number | null = null;
      for (let i = 0; i + 1 < ts.length; i++) {
        const t0 = ts[i]!, t1 = ts[i + 1]!;
        if (t1 - t0 <= eps) continue;
        if (inside((t0 + t1) / 2)) {
          if (open === null) open = t0;
        } else if (open !== null) {
          spans.push({ bodyId: body.id, faceId: face.id, t0: open, t1: t0 });
          open = null;
        }
      }
      if (open !== null) spans.push({ bodyId: body.id, faceId: face.id, t0: open, t1: 1 });
    }
  }
  // ends within the merge tolerance of the segment's ends are its ends, so no sliver is left over
  return spans
    .filter((s) => s.t1 - s.t0 > eps)
    .map((s) => ({ ...s, t0: s.t0 <= eps ? 0 : s.t0, t1: s.t1 >= 1 - eps ? 1 : s.t1 }))
    .sort((x, y) => x.t0 - y.t0);
}

function graphFor(body: Draft<Body>, faceId: FaceLocalId): Draft<ImprintGraph> {
  let g = body.imprints.get(faceId);
  if (!g) {
    g = createImprintGraph() as Draft<ImprintGraph>;
    body.imprints.set(faceId, g);
  }
  return g;
}

function vertexFor(g: Draft<ImprintGraph>, uv: Vec2): number {
  for (const [id, p] of g.vertices) {
    if (Math.hypot(p[0] - uv[0], p[1] - uv[1]) <= MERGE_TOL) return id;
  }
  const id = g.nextId++;
  g.vertices.set(id, [uv[0], uv[1]]);
  return id;
}

export interface ImprintEdgeOptions {
  soft?: boolean;
  smooth?: boolean;
  hidden?: boolean;
  curveId?: CurveId | null;
}

/** Split an existing imprint edge at vertex `v` (which must lie on it); the first piece keeps the id. */
function splitImprintEdge(g: Draft<ImprintGraph>, edgeId: number, v: number): void {
  const e = g.edges.get(edgeId);
  if (!e || e.a === v || e.b === v) return;
  const second: ImprintEdge = { ...e, id: g.nextId++, a: v, b: e.b };
  e.b = v;
  g.edges.set(second.id, second);
}

function addPiece(g: Draft<ImprintGraph>, va: number, vb: number, opts: ImprintEdgeOptions): number {
  if (va === vb) return -1;
  for (const e of g.edges.values()) if ((e.a === va && e.b === vb) || (e.a === vb && e.b === va)) return e.id;
  const id = g.nextId++;
  g.edges.set(id, {
    id,
    a: va,
    b: vb,
    soft: opts.soft ?? false,
    smooth: opts.smooth ?? false,
    hidden: opts.hidden ?? false,
    curveId: opts.curveId ?? null,
  });
  return id;
}

/**
 * Add an imprint edge between two world points on face `faceId` of `body`, with
 * sticky-geometry rules in the face plane: endpoints merge with existing imprint vertices within
 * MERGE_TOL, an endpoint landing on an existing edge splits it (T-junction), crossings split both
 * edges, and existing vertices on the new segment split it. Returns the ids of the pieces of the
 * new segment (existing coincident pieces are reused), empty when degenerate.
 */
export function addImprintEdge(body: Draft<Body>, faceId: FaceLocalId, a: Vec3, b: Vec3, opts: ImprintEdgeOptions = {}): number[] {
  const face = body.faces.get(faceId);
  if (!face) throw new Error(`addImprintEdge: face ${faceId} not on body ${body.id}`);
  const g = graphFor(body, faceId);
  const [au, av] = basisToLocal(face.basis, a);
  const [bu, bv] = basisToLocal(face.basis, b);
  const A: Vec2 = [au, av], B: Vec2 = [bu, bv];
  const len = Math.hypot(bu - au, bv - av);
  if (len <= MERGE_TOL) return [];
  const existingEdges = [...g.edges.values()].map((e) => ({ ...e }));
  const splitsT = new Map<number, Vec2>(); // param along the new segment (quantized) → uv
  const addSplit = (t: number, uv: Vec2) => {
    if (t <= MERGE_TOL / len || t >= 1 - MERGE_TOL / len) return;
    splitsT.set(Math.round(t * 1e9), uv);
  };
  // T-junctions onto the new segment: existing vertices on its interior
  for (const p of g.vertices.values()) {
    const c = pointSegmentClosest2D(p, A, B);
    if (c.distSq <= MERGE_TOL * MERGE_TOL) addSplit(c.t, p);
  }
  // crossings and endpoints landing on existing edges
  for (const e of existingEdges) {
    const pa = g.vertices.get(e.a), pb = g.vertices.get(e.b);
    if (!pa || !pb) continue;
    const x = segSegIntersect2D(A, B, pa, pb, MERGE_TOL);
    if (x.kind === 'point') {
      const elen = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      const sInterior = x.s > MERGE_TOL / elen && x.s < 1 - MERGE_TOL / elen;
      if (sInterior) {
        const v = vertexFor(g, x.point);
        splitImprintEdge(g, e.id, v);
      }
      addSplit(x.t, x.point);
    }
  }
  // build the pieces of the new segment
  const ts = [...splitsT.entries()].sort((p, q) => p[0] - q[0]).map(([, uv]) => uv);
  const chain: number[] = [vertexFor(g, A), ...ts.map((uv) => vertexFor(g, uv)), vertexFor(g, B)];
  const ids: number[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const id = addPiece(g, chain[i]!, chain[i + 1]!, opts);
    if (id >= 0 && !ids.includes(id)) ids.push(id);
  }
  if (ids.length) g.version++;
  return ids;
}

export function removeImprintEdge(body: Draft<Body>, faceId: FaceLocalId, edgeId: number): boolean {
  const g = body.imprints.get(faceId);
  if (!g) return false;
  const e = g.edges.get(edgeId);
  if (!e) return false;
  g.edges.delete(edgeId);
  for (const v of [e.a, e.b]) {
    let used = false;
    for (const o of g.edges.values()) if (o.a === v || o.b === v) used = true;
    if (!used) g.vertices.delete(v);
  }
  g.version++;
  if (g.edges.size === 0) body.imprints.delete(faceId);
  return true;
}

export interface ImprintEdgeWorld {
  readonly bodyId: Id;
  readonly faceId: FaceLocalId;
  readonly edgeId: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly soft: boolean;
  readonly smooth: boolean;
  readonly hidden: boolean;
}

/** All imprint edges of a body in world coordinates (for rendering and picking). */
export function imprintEdgesWorld(body: Body): ImprintEdgeWorld[] {
  const out: ImprintEdgeWorld[] = [];
  for (const [faceId, g] of body.imprints) {
    const face = body.faces.get(faceId);
    if (!face) continue;
    for (const e of g.edges.values()) {
      const pa = g.vertices.get(e.a), pb = g.vertices.get(e.b);
      if (!pa || !pb) continue;
      out.push({
        bodyId: body.id,
        faceId,
        edgeId: e.id,
        a: basisToWorld(face.basis, pa[0], pa[1]),
        b: basisToWorld(face.basis, pb[0], pb[1]),
        soft: e.soft,
        smooth: e.smooth,
        hidden: e.hidden,
      });
    }
  }
  return out;
}
