// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id, MVec3, Plane, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, PushFormError, basisToLocal, basisToWorld, planeBasis, planeFromPointNormal, v3cross, v3dist, v3len, v3sub } from '@pushform/core';
import { offsetPolygonFull, offsetPolyline, signedArea } from '@pushform/geom';
import type { OffsetArc, OffsetResult, PolygonsWithHoles } from '@pushform/geom';
import { addImprintEdge, allocId, computeRegions, containerAt, facePolygonUv, sketchFaceLoops, sketchFacePolygonUv } from '@pushform/model';
import type { Curve, DocumentDraft, DocumentState, EntityContainer, Sketch } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import { contextFrame, draftBodyAt, requireContextPath, sketchGraphAt } from './context';
import { PushPullTargetSchema, type PushPullTarget } from './pushpull';

/**
 * Offset (F): parallel copies of a face's loops (a new sketch face forms automatically, or
 * imprint edges on a body face) or of a chain of connected coplanar sketch edges.
 */

// ---------------------------------------------------------------------------------------------
// shared helpers (also used by Follow Me and Intersect Faces)

/** A face target: a sketch face or a body face (optionally one region of it). Same shape as a Push/Pull target. */
export type FaceTarget = PushPullTarget;
export const FaceTargetSchema = PushPullTargetSchema;

export interface FaceTargetInfo {
  readonly target: FaceTarget;
  readonly plane: Plane;
  readonly basis: PlaneBasis;
  /** In the face basis (u, v): outer CCW, holes CW. */
  readonly polygon: PolygonsWithHoles;
  /** World loops matching `polygon`. */
  readonly loops: Vec3[][];
  /** Arc tag per ring edge (sketch faces only; body faces offset as straight edges). */
  readonly arcs: (OffsetArc | null)[][];
  /** Source curves by tag key (sketch faces), for copying curve metadata onto the offset edges. */
  readonly curves: Map<string | number, Curve>;
  readonly bodyId: Id | null;
  readonly faceId: FaceLocalId | null;
  readonly sketchFaceId: Id | null;
}

/**
 * Entity container at an instance `path` (root for the empty path). Throws `context.invalid` when
 * a step is missing. Name kept from M1 when only the root was editable.
 */
export function rootContainerOf(state: DocumentState, path: readonly number[] = []): EntityContainer {
  try {
    return containerAt(state, path as readonly Id[]);
  } catch (e) {
    throw new PushFormError('context.invalid', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Resolve a face target against the document (read-only). Geometry is in the coordinates of the
 * target's container (context-local); see `resolveFaceTargetWorld` for tools. Throws
 * `PushFormError('face.target')` when missing.
 */
export function resolveFaceTarget(state: DocumentState, target: FaceTarget): FaceTargetInfo {
  const root = rootContainerOf(state, target.path);
  if (target.kind === 'sketchFace') {
    const sketch = root.sketch;
    const face = sketch.faces.get(target.id as Id);
    if (!face) throw new PushFormError('face.target', `Sketch face ${target.id} not found`);
    const curves = new Map<string | number, Curve>();
    const arcs = face.loops.map((loop) =>
      loop.map((ref): OffsetArc | null => {
        const e = sketch.edges.get(ref.edgeId);
        const c = e?.curveId !== null && e?.curveId !== undefined ? sketch.curves.get(e.curveId) : undefined;
        if (!c || (c.kind !== 'arc' && c.kind !== 'circle')) return null;
        curves.set(c.id as number, c);
        const l = basisToLocal(face.basis, c.center);
        return { key: c.id as number, center: [l[0], l[1]], radius: c.radius };
      }),
    );
    return {
      target,
      plane: face.plane,
      basis: face.basis,
      polygon: sketchFacePolygonUv(sketch, face),
      loops: sketchFaceLoops(sketch, face),
      arcs,
      curves,
      bodyId: null,
      faceId: null,
      sketchFaceId: face.id,
    };
  }
  const body = root.bodies.get(target.id as Id);
  const faceId = target.faceId as FaceLocalId;
  const face = body?.faces.get(faceId);
  if (!body || !face) throw new PushFormError('face.target', `Face ${target.faceId} not found on body ${target.id}`);
  const regions = computeRegions(body, faceId);
  const region = regions[target.region ?? 0];
  const polygon = !region || region.wholeFace ? facePolygonUv(face) : region.polygon;
  const loops = !region || region.wholeFace ? face.loops : polygon.map((ring) => ring.map((p) => basisToWorld(face.basis, p[0] ?? 0, p[1] ?? 0)));
  return {
    target,
    plane: face.plane,
    basis: face.basis,
    polygon,
    loops,
    arcs: polygon.map((ring) => ring.map(() => null)),
    curves: new Map(),
    bodyId: body.id,
    faceId,
    sketchFaceId: null,
  };
}

/**
 * `resolveFaceTarget` with plane, basis and loops transformed to world space (the polygon stays
 * in the transformed basis, so uv offsets are exact for rigid contexts). Tools use this to turn
 * cursor (world) positions into offset distances and to draw previews.
 */
export function resolveFaceTargetWorld(state: DocumentState, target: FaceTarget): FaceTargetInfo {
  const info = resolveFaceTarget(state, target);
  const frame = contextFrame(state, target.path as unknown as readonly Id[]);
  if (frame.identity) return info;
  const plane = frame.toWorldPlane(info.plane);
  const origin = frame.toWorld(info.basis.origin);
  const basis: PlaneBasis = {
    origin,
    u: v3normalizeSafe(frame.toWorldDir(info.basis.u)),
    v: v3normalizeSafe(frame.toWorldDir(info.basis.v)),
    n: plane.n,
  };
  const loops = info.loops.map((loop) => loop.map((p) => frame.toWorld(p)));
  const polygon = loops.map((loop) =>
    loop.map((p): [number, number] => {
      const l = basisToLocal(basis, p);
      return [l[0], l[1]];
    }),
  );
  const arcs = info.arcs.map((ring) =>
    ring.map((a) => {
      if (!a) return null;
      const c = frame.toWorld(basisToWorld(info.basis, a.center[0], a.center[1]));
      const l = basisToLocal(basis, c);
      return { key: a.key, center: [l[0], l[1]] as [number, number], radius: a.radius };
    }),
  );
  return { ...info, plane, basis, polygon, loops, arcs };
}

const v3normalizeSafe = (v: Vec3): MVec3 => {
  const l = v3len(v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [v[0], v[1], v[2]];
};

export interface EdgeChain {
  readonly vertexIds: Id[];
  readonly points: Vec3[];
  /** True when the chain returns to its first vertex (`points` then omits the repeat). */
  readonly closed: boolean;
}

/**
 * Order a set of sketch edges into one continuous polyline. Throws `PushFormError('path.discontinuous')`
 * when the edges do not form a single chain (branching, gaps, or several pieces).
 */
export function orderSketchEdgeChain(sketch: Sketch, edgeIds: readonly Id[]): EdgeChain {
  const ids = [...new Set(edgeIds)].filter((id) => sketch.edges.has(id));
  if (!ids.length) throw new PushFormError('path.discontinuous', 'The path has no edges');
  const adj = new Map<Id, { edge: Id; other: Id }[]>();
  const push = (v: Id, edge: Id, other: Id): void => {
    const l = adj.get(v);
    if (l) l.push({ edge, other });
    else adj.set(v, [{ edge, other }]);
  };
  for (const id of ids) {
    const e = sketch.edges.get(id)!;
    push(e.a, id, e.b);
    push(e.b, id, e.a);
  }
  const ends: Id[] = [];
  for (const [v, l] of adj) {
    if (l.length > 2) throw new PushFormError('path.discontinuous', 'The path branches: select a single chain of edges');
    if (l.length === 1) ends.push(v);
  }
  if (ends.length !== 0 && ends.length !== 2) throw new PushFormError('path.discontinuous', 'The path is not continuous');
  const closed = ends.length === 0;
  const start = closed ? (sketch.edges.get(ids[0]!)!.a as Id) : ends[0]!;
  const used = new Set<Id>();
  const vertexIds: Id[] = [start];
  let cur = start;
  for (;;) {
    const next = (adj.get(cur) ?? []).find((x) => !used.has(x.edge));
    if (!next) break;
    used.add(next.edge);
    cur = next.other;
    if (closed && cur === start) break;
    vertexIds.push(cur);
  }
  if (used.size !== ids.length) throw new PushFormError('path.discontinuous', 'The path is not continuous (several pieces)');
  const points = vertexIds.map((v) => {
    const vert = sketch.vertices.get(v);
    if (!vert) throw new PushFormError('path.discontinuous', `Sketch vertex ${v} missing`);
    return vert.p;
  });
  return { vertexIds, points, closed };
}

/** Plane through a point set (first non-collinear triple), or null when all points are collinear. */
export function planeThroughPoints(points: readonly Vec3[]): Plane | null {
  const a = points[0];
  if (!a) return null;
  let dir: Vec3 | null = null;
  for (const p of points) {
    const d = v3sub(p, a);
    if (v3len(d) > MERGE_TOL) {
      dir = d;
      break;
    }
  }
  if (!dir) return null;
  for (const p of points) {
    const n = v3cross(dir, v3sub(p, a));
    if (v3len(n) > MERGE_TOL * v3len(dir)) return planeFromPointNormal(a, n);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// params

export const OffsetParamsSchema = z
  .object({
    /** Face to offset (sketch face or body face/region). */
    faceRef: FaceTargetSchema.optional(),
    /** Alternatively, a chain of connected coplanar sketch edges. */
    edgeIds: z.array(z.number().int().nonnegative()).optional(),
    /** Signed offset: > 0 grows the face (outward), < 0 shrinks it (inward). For an edge chain, > 0 = right of travel. */
    distance: z.number().finite(),
    /** Alt in the tool: keep the raw mitred rings (overlaps allowed), skipping self-intersection cleanup. */
    allowOverlap: z.boolean().default(false),
  })
  .refine((p) => (p.faceRef !== undefined) !== (p.edgeIds !== undefined && p.edgeIds.length > 0), {
    message: 'Provide either faceRef or edgeIds',
  });
export type OffsetParams = z.infer<typeof OffsetParamsSchema>;

export interface OffsetApplyResult {
  /** New sketch edge ids (or imprint edge ids for a body face). */
  edgeIds: number[];
  /** Sketch faces created or updated by the offset. */
  faceIds: number[];
  /** The resulting rings in context-local space (outer first per polygon), for tool feedback. */
  rings: Vec3[][];
}

/** Pure planning: the offset rings (uv) and arc tags for a face target. */
export function planFaceOffset(info: FaceTargetInfo, distance: number, allowOverlap: boolean): OffsetResult {
  return offsetPolygonFull(info.polygon, distance, { arcs: info.arcs, cleanup: !allowOverlap });
}

const toWorld = (basis: PlaneBasis, p: readonly number[]): MVec3 => basisToWorld(basis, p[0] ?? 0, p[1] ?? 0);

/** Apply a planned face offset to the draft. */
function applyFaceOffset(draft: DocumentDraft, info: FaceTargetInfo, plan: OffsetResult): OffsetApplyResult {
  const result: OffsetApplyResult = { edgeIds: [], faceIds: [], rings: [] };
  const path = info.target.path;
  if (info.bodyId !== null && info.faceId !== null) {
    const body = draftBodyAt(draft, path, info.bodyId);
    if (!body?.faces.has(info.faceId)) throw new PushFormError('offset.stale', 'The face changed before Offset could be applied');
    for (const poly of plan.polygons) {
      for (const ring of poly) {
        const w = ring.map((p) => toWorld(info.basis, p));
        result.rings.push(w);
        for (let i = 0; i < w.length; i++) {
          result.edgeIds.push(...addImprintEdge(body, info.faceId, w[i]!, w[(i + 1) % w.length]!));
        }
      }
    }
    return result;
  }
  const g = sketchGraphAt(draft, path);
  const facesBefore = new Set(g.sketch.faces.keys());
  plan.polygons.forEach((poly, pi) => {
    poly.forEach((ring, ri) => {
      const w = ring.map((p) => toWorld(info.basis, p));
      result.rings.push(w);
      const tags = plan.tags[pi]?.[ri] ?? [];
      // one new Curve per source arc run in this ring
      const curveFor = new Map<string | number, Curve>();
      const edgeIdsByCurve = new Map<string | number, Id[]>();
      for (let i = 0; i < w.length; i++) {
        const tag = tags[i] ?? null;
        let curveId: CurveId | null = null;
        if (tag) {
          let c = curveFor.get(tag.key);
          if (!c) {
            const src = info.curves.get(tag.key);
            const center = toWorld(info.basis, tag.center);
            c = {
              id: allocId<CurveId>(draft),
              kind: src?.kind ?? 'arc',
              center,
              normal: src ? [...src.normal] : [...info.plane.n],
              radius: v3dist(center, w[i]!),
              startAngle: src?.startAngle ?? 0,
              endAngle: src?.endAngle ?? 0,
              segments: 0,
              edgeRefs: [],
            };
            curveFor.set(tag.key, c);
            edgeIdsByCurve.set(tag.key, []);
          }
          curveId = c.id;
        }
        const ids = g.addEdge(w[i]!, w[(i + 1) % w.length]!, { curveId });
        for (const id of ids) result.edgeIds.push(id as number);
        if (tag) edgeIdsByCurve.get(tag.key)!.push(...ids);
      }
      for (const [key, c] of curveFor) {
        const ids = edgeIdsByCurve.get(key) ?? [];
        if (!ids.length) continue;
        c.edgeRefs = ids;
        c.segments = ids.length;
        (g.sketch.curves as Map<CurveId, Curve>).set(c.id, c);
      }
    });
  });
  for (const id of g.sketch.faces.keys()) if (!facesBefore.has(id)) result.faceIds.push(id as number);
  for (const f of g.sketch.faces.values()) {
    if (facesBefore.has(f.id) && f.loops.some((l) => l.some((r) => result.edgeIds.includes(r.edgeId as number)))) {
      result.faceIds.push(f.id as number);
    }
  }
  return result;
}

/** Offset a chain of connected coplanar sketch edges (open: parallel polyline; closed: polygon offset). */
function applyEdgeOffset(draft: DocumentDraft, path: readonly number[], edgeIds: readonly Id[], distance: number, allowOverlap: boolean): OffsetApplyResult {
  const g = sketchGraphAt(draft, path);
  const chain = orderSketchEdgeChain(g.sketch, edgeIds);
  const plane = planeThroughPoints(chain.points);
  if (!plane) throw new PushFormError('offset.collinear', 'Offset needs at least two non-collinear connected edges');
  const basis = planeBasis(chain.points[0]!, plane.n);
  const uv = chain.points.map((p): Vec2 => {
    const l = basisToLocal(basis, p);
    return [l[0], l[1]];
  });
  const result: OffsetApplyResult = { edgeIds: [], faceIds: [], rings: [] };
  const facesBefore = new Set(g.sketch.faces.keys());
  const addRing = (ring: readonly (readonly number[])[], closed: boolean): void => {
    const w = ring.map((p) => toWorld(basis, p));
    result.rings.push(w);
    const n = closed ? w.length : w.length - 1;
    for (let i = 0; i < n; i++) {
      for (const id of g.addEdge(w[i]!, w[(i + 1) % w.length]!)) result.edgeIds.push(id as number);
    }
  };
  if (chain.closed) {
    // ring orientation decides the sign convention; normalize so distance > 0 grows the loop
    const ring = signedArea(uv) < 0 ? uv.slice().reverse() : uv;
    const plan = offsetPolygonFull([ring.map((p) => [p[0], p[1]])], distance, { cleanup: !allowOverlap });
    for (const poly of plan.polygons) for (const r of poly) addRing(r, true);
  } else {
    addRing(offsetPolyline(uv, distance), false);
  }
  for (const id of g.sketch.faces.keys()) if (!facesBefore.has(id)) result.faceIds.push(id as number);
  return result;
}

export const sketchOffset = defineCommand({
  id: 'sketch.offset',
  title: 'Offset',
  category: 'edit',
  params: OffsetParamsSchema,
  undoable: true,
  run(ctx, p): OffsetApplyResult {
    const host = hostOf(ctx);
    if (p.faceRef) {
      requireContextPath(host, p.faceRef.path, 'Face');
      const info = resolveFaceTarget(host.doc.state, p.faceRef);
      const plan = planFaceOffset(info, p.distance, p.allowOverlap);
      return host.edit('Offset', (draft) => applyFaceOffset(draft, info, plan));
    }
    const path = host.context.path;
    return host.edit('Offset', (draft) => applyEdgeOffset(draft, path, (p.edgeIds ?? []) as Id[], p.distance, p.allowOverlap));
  },
});

export const offsetCommands: readonly AnyCommand[] = [sketchOffset];

/** Signed distance of a (u, v) point from a polygon's boundary: negative inside, positive outside. */
export function signedDistanceToPolygon(p: Vec2, poly: PolygonsWithHoles, inside: boolean): number {
  let best = Infinity;
  for (const ring of poly) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!;
      const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((p[0] - a[0]!) * dx + (p[1] - a[1]!) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0]! + dx * t - p[0], qy = a[1]! + dy * t - p[1];
      best = Math.min(best, Math.hypot(qx, qy));
    }
  }
  return inside ? -best : best;
}
