// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id, MVec3, Plane, PlaneBasis, TagId, Vec2, Vec3 } from '@pushform/core';
import {
  COPLANAR_TOL,
  MERGE_TOL,
  PushFormError,
  basisToLocal,
  basisToWorld,
  planeBasis,
  planeFromPointNormal,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3sub,
} from '@pushform/core';
import { offsetPolygonFull, offsetPolylineFull, pointInPolygon, signedArea } from '@pushform/geom';
import type { OffsetArc, OffsetResult, PolygonsWithHoles } from '@pushform/geom';
import { addImprintEdge, allocId, computeRegions, containerAt, facePolygonUv, sketchFaceLoops, sketchFacePolygonUv, uvRebaseSides } from '@pushform/model';
import type { Body, Curve, DocumentDraft, DocumentState, EntityContainer, FaceRecord, Region, Sketch } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { activeDrawTagOpts, hostOf } from '../host/services';
import { contextFrame, draftBodyAt, requireContextPath, sketchGraphAt, type ContextFrame } from './context';
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
  /** Arc tag per ring edge (null for straight edges), parallel to `polygon`. */
  readonly arcs: (OffsetArc | null)[][];
  /** Source curves by tag key, for copying curve metadata onto the offset edges. */
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
  const curves = new Map<string | number, Curve>();
  return {
    target,
    plane: face.plane,
    basis: face.basis,
    polygon,
    loops,
    arcs: bodyFaceArcs(body, face, polygon, region, curves),
    curves,
    bodyId: body.id,
    faceId,
    sketchFaceId: null,
  };
}

/**
 * Arc tags of a body face region's boundary: loop edges through their edge record, imprint edges
 * through the imprint graph, both pointing at a circle or arc in `body.curves` (collected into `curves`).
 */
function bodyFaceArcs(body: Body, face: FaceRecord, polygon: PolygonsWithHoles, region: Region | undefined, curves: Map<string | number, Curve>): (OffsetArc | null)[][] {
  const contours = !region || region.wholeFace ? null : [region.outer, ...region.holes];
  const imprint = body.imprints.get(face.id);
  const arcOf = (curveId: CurveId | null | undefined): OffsetArc | null => {
    const c = curveId !== null && curveId !== undefined ? body.curves.get(curveId) : undefined;
    if (!c || (c.kind !== 'arc' && c.kind !== 'circle')) return null;
    curves.set(c.id as number, c);
    const l = basisToLocal(face.basis, c.center);
    return { key: c.id as number, center: [l[0], l[1]], radius: c.radius };
  };
  return polygon.map((ring, ri) => {
    const refs = contours?.[ri];
    if (contours && refs?.length !== ring.length) return ring.map(() => null);
    return ring.map((_, i): OffsetArc | null => {
      const ref = refs?.[i] ?? { kind: 'loop' as const, loop: ri, edge: i, forward: true };
      if (ref.kind === 'imprint') return arcOf(imprint?.edges.get(ref.edgeId)?.curveId);
      const loop = face.loops[ref.loop];
      const a = loop?.[ref.edge], b = loop?.[(ref.edge + 1) % (loop?.length ?? 1)];
      return a && b ? arcOf(edgeRecordCurve(body, face.id, a, b)) : null;
    });
  });
}

/** Curve of the body edge between face `fid` and a neighbour whose polyline holds both `a` and `b`. */
function edgeRecordCurve(body: Body, fid: FaceLocalId, a: Vec3, b: Vec3): CurveId | null {
  const has = (poly: readonly Vec3[], p: Vec3): boolean => poly.some((q) => v3dist(q, p) <= MERGE_TOL);
  for (const e of body.edges.values()) {
    if (e.faceA !== fid && e.faceB !== fid) continue;
    if (has(e.polyline, a) && has(e.polyline, b)) return e.curveId;
  }
  return null;
}

/**
 * The scale a frame applies within a plane, when it scales the plane evenly (a similarity), else
 * null: circles in the plane stay circles only in the first case.
 */
function inPlaneScale(frame: ContextFrame, basis: PlaneBasis): number | null {
  const u = frame.toWorldDir(basis.u), v = frame.toWorldDir(basis.v);
  const su = v3len(u), sv = v3len(v);
  if (!(su > 0) || !(sv > 0)) return null;
  if (Math.abs(su - sv) > 1e-9 * su || Math.abs(v3dot(u, v)) > 1e-9 * su * sv) return null;
  return su;
}

/**
 * `resolveFaceTarget` with plane, basis, loops and polygon in world space (an orthonormal basis on
 * the world plane), so distances measured on the polygon are model distances inside scaled
 * contexts too. Arcs keep their tags while the context scales the face's plane evenly. Tools use
 * this to turn cursor (world) positions into offset distances and to draw previews; the command
 * plans the offset with it.
 */
export function resolveFaceTargetWorld(state: DocumentState, target: FaceTarget): FaceTargetInfo {
  const info = resolveFaceTarget(state, target);
  const frame = contextFrame(state, target.path as unknown as readonly Id[]);
  if (frame.identity) return info;
  const plane = frame.toWorldPlane(info.plane);
  const origin = frame.toWorld(info.basis.origin);
  const u = v3normalizeSafe(frame.toWorldDir(info.basis.u));
  const basis: PlaneBasis = { origin, u, v: v3normalizeSafe(v3cross(plane.n, u)), n: plane.n };
  const loops = info.loops.map((loop) => loop.map((p) => frame.toWorld(p)));
  const polygon = loops.map((loop) =>
    loop.map((p): [number, number] => {
      const l = basisToLocal(basis, p);
      return [l[0], l[1]];
    }),
  );
  const scale = inPlaneScale(frame, info.basis);
  const arcs = info.arcs.map((ring) =>
    ring.map((a) => {
      if (!a || scale === null) return null;
      const c = frame.toWorld(basisToWorld(info.basis, a.center[0], a.center[1]));
      const l = basisToLocal(basis, c);
      return { key: a.key, center: [l[0], l[1]] as [number, number], radius: a.radius * scale };
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
  /** Edge `i` runs from vertex `i` to vertex `i + 1` (the last one back to the first on a closed chain). */
  readonly edgeIds: Id[];
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
    if (l.length > 2) throw new PushFormError('path.discontinuous', 'The path branches: select a single chain of edges', { reason: 'branches' });
    if (l.length === 1) ends.push(v);
  }
  if (ends.length !== 0 && ends.length !== 2) throw new PushFormError('path.discontinuous', 'The path is not continuous', { reason: 'gaps' });
  const closed = ends.length === 0;
  const start = closed ? (sketch.edges.get(ids[0]!)!.a as Id) : ends[0]!;
  const used = new Set<Id>();
  const vertexIds: Id[] = [start];
  const chainEdges: Id[] = [];
  let cur = start;
  for (;;) {
    const next = (adj.get(cur) ?? []).find((x) => !used.has(x.edge));
    if (!next) break;
    used.add(next.edge);
    chainEdges.push(next.edge);
    cur = next.other;
    if (closed && cur === start) break;
    vertexIds.push(cur);
  }
  if (used.size !== ids.length) throw new PushFormError('path.discontinuous', 'The path is not continuous (several pieces)', { reason: 'gaps' });
  const points = vertexIds.map((v) => {
    const vert = sketch.vertices.get(v);
    if (!vert) throw new PushFormError('path.discontinuous', `Sketch vertex ${v} missing`);
    return vert.p;
  });
  return { vertexIds, edgeIds: chainEdges, points, closed };
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

/**
 * The plane an edge chain is offset in: through its points when they span one; for a chain on one
 * line, the plane through that line closest to level (upright for a vertical line). Throws
 * `PushFormError('offset.notPlanar')` when the points do not lie in one plane.
 */
export function chainPlane(points: readonly Vec3[]): Plane {
  const plane = planeThroughPoints(points);
  if (plane) {
    for (const p of points) {
      if (Math.abs(v3dot(plane.n, p) + plane.d) > COPLANAR_TOL) throw new PushFormError('offset.notPlanar', 'The selected edges do not lie in one plane');
    }
    return plane;
  }
  const a = points[0], b = points.find((p) => a && v3dist(p, a) > MERGE_TOL);
  if (!a || !b) throw new PushFormError('offset.collinear', 'The selected edges have no length');
  const dir = v3sub(b, a);
  const l = v3len(dir);
  const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  // the world up made perpendicular to the line; a vertical line takes the plane facing +y
  const up: Vec3 = Math.abs(d[2]) < 1 - 1e-9 ? [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]] : [0, 1, 0];
  return planeFromPointNormal(a, up);
}

/** Why a set of sketch edges cannot be offset as a chain (branching, gaps, not in one plane), or null. */
export function edgeChainProblem(sketch: Sketch, edgeIds: readonly Id[], toWorld: (p: Vec3) => Vec3 = (p) => p): string | null {
  try {
    chainPlane(orderSketchEdgeChain(sketch, edgeIds).points.map(toWorld));
    return null;
  } catch (e) {
    const reason = e instanceof PushFormError ? (e.details as { reason?: string } | undefined)?.reason : undefined;
    if (reason === 'branches') return 'The selected edges branch';
    if (reason === 'gaps') return 'The selected edges have gaps';
    return e instanceof Error ? e.message : String(e);
  }
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

/** An offset arc run, with its center in context-local coordinates. */
interface PlannedArc {
  readonly key: string | number;
  readonly center: Vec3;
}
/** An offset ring (or open polyline) in context-local coordinates, with the arc tag of each edge. */
export interface PlannedRing {
  readonly points: Vec3[];
  readonly tags: (PlannedArc | null)[];
  readonly closed: boolean;
}

/** Plan rings in a world basis → context-local rings. */
function localRings(polygons: readonly PolygonsWithHoles[], tags: readonly (OffsetArc | null)[][][], basis: PlaneBasis, frame: ContextFrame): PlannedRing[][] {
  const local = (p: readonly number[]): MVec3 => {
    const w = basisToWorld(basis, p[0] ?? 0, p[1] ?? 0);
    return frame.identity ? w : frame.toLocal(w);
  };
  return polygons.map((poly, pi) =>
    poly.map((ring, ri) => ({
      points: ring.map(local),
      tags: ring.map((_, i) => {
        const t = tags[pi]?.[ri]?.[i] ?? null;
        return t ? { key: t.key, center: local(t.center) } : null;
      }),
      closed: true,
    })),
  );
}

const vanished = (): PushFormError => new PushFormError('offset.vanished', 'Nothing is left of the face at this distance');

/** Every ring point and edge midpoint lies inside the face polygon or on its boundary. */
function ringsOnFace(face: FaceRecord, rings: readonly PlannedRing[]): boolean {
  const poly = facePolygonUv(face);
  const onFace = (p: Vec3): boolean => {
    const l = basisToLocal(face.basis, p);
    const uv: Vec2 = [l[0], l[1]];
    return pointInPolygon(uv, poly) || Math.abs(signedDistanceToPolygon(uv, poly, false)) <= MERGE_TOL;
  };
  for (const r of rings) {
    const n = r.points.length;
    for (let i = 0; i < n; i++) {
      const a = r.points[i]!, b = r.points[(i + 1) % n]!;
      if (!onFace(a) || !onFace([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])) return false;
    }
  }
  return true;
}

/** Tags for new sketch geometry: the active tag for edges and for faces that take nothing from an existing face. */
type DrawTags = { tagId?: TagId; faceTagId?: TagId };

/**
 * Add planned rings: imprint edges on a body face, or sketch edges (in context-local space) whose
 * faces form automatically. Each arc run of a ring gets its own Curve record, copied from its source.
 */
function addRings(
  draft: DocumentDraft,
  path: readonly number[],
  rings: readonly PlannedRing[],
  curves: ReadonlyMap<string | number, Curve>,
  normal: Vec3,
  on: { body: ReturnType<typeof draftBodyAt>; faceId: FaceLocalId } | null,
  tags: DrawTags,
  result: OffsetApplyResult,
): void {
  const g = on ? null : sketchGraphAt(draft, path);
  for (const ring of rings) {
    const w = ring.points;
    result.rings.push(w);
    const curveFor = new Map<string | number, Curve>();
    const idsByCurve = new Map<string | number, Id[]>();
    const n = ring.closed ? w.length : w.length - 1;
    for (let i = 0; i < n; i++) {
      const tag = ring.tags[i] ?? null;
      let curveId: CurveId | null = null;
      if (tag) {
        let c = curveFor.get(tag.key);
        if (!c) {
          const src = curves.get(tag.key);
          c = {
            id: allocId<CurveId>(draft),
            kind: src?.kind ?? 'arc',
            center: tag.center,
            normal: src ? [...src.normal] : [...normal],
            radius: v3dist(tag.center, w[i]!),
            startAngle: src?.startAngle ?? 0,
            endAngle: src?.endAngle ?? 0,
            segments: 0,
            edgeRefs: [],
          };
          curveFor.set(tag.key, c);
          idsByCurve.set(tag.key, []);
        }
        curveId = c.id;
      }
      const a = w[i]!, b = w[(i + 1) % w.length]!;
      const ids: number[] = on ? addImprintEdge(on.body!, on.faceId, a, b, { curveId }) : g!.addEdge(a, b, { curveId, ...tags }).map((id) => id as number);
      result.edgeIds.push(...ids);
      if (tag) idsByCurve.get(tag.key)!.push(...(ids as Id[]));
    }
    for (const [key, c] of curveFor) {
      const ids = idsByCurve.get(key) ?? [];
      if (!ids.length) continue;
      c.edgeRefs = ids;
      c.segments = ids.length;
      const store = on ? on.body!.curves : g!.sketch.curves;
      (store as Map<CurveId, Curve>).set(c.id, c);
    }
  }
}

/** Apply a planned face offset to the draft. */
function applyFaceOffset(draft: DocumentDraft, info: FaceTargetInfo, planned: readonly PlannedRing[][], inward: boolean, tags: DrawTags): OffsetApplyResult {
  const result: OffsetApplyResult = { edgeIds: [], faceIds: [], rings: [] };
  const path = info.target.path;
  const rings = planned.flat();
  if (info.bodyId !== null && info.faceId !== null) {
    const body = draftBodyAt(draft, path, info.bodyId);
    if (!body?.faces.has(info.faceId)) throw new PushFormError('offset.stale', 'The face changed before Offset could be applied');
    addRings(draft, path, rings, info.curves, info.plane.n, { body, faceId: info.faceId }, tags, result);
    return result;
  }
  const g = sketchGraphAt(draft, path);
  const facesBefore = new Set(g.sketch.faces.keys());
  addRings(draft, path, rings, info.curves, info.plane.n, null, tags, result);
  const created = [...g.sketch.faces.keys()].filter((id) => !facesBefore.has(id));
  // the faces inside an inward offset continue the original: they take its material and tag
  const original = info.sketchFaceId !== null ? g.sketch.faces.get(info.sketchFaceId) : undefined;
  if (inward && original) {
    for (const id of created) {
      const f = g.sketch.faces.get(id)!;
      const flipped = v3dot(f.plane.n, original.plane.n) < 0;
      f.frontMaterialId = flipped ? original.backMaterialId : original.frontMaterialId;
      f.backMaterialId = flipped ? original.frontMaterialId : original.backMaterialId;
      f.tagId = original.tagId;
      const sides = flipped && original.uvBack ? { uv: original.uvBack, uvBack: original.uv } : original;
      const r = uvRebaseSides(sides, original.basis, f.basis, null, null);
      f.uv = r.uv;
      if (r.uvBack) f.uvBack = r.uvBack;
      else delete f.uvBack;
    }
  }
  result.faceIds.push(...(created as number[]));
  for (const f of g.sketch.faces.values()) {
    if (facesBefore.has(f.id) && f.loops.some((l) => l.some((r) => result.edgeIds.includes(r.edgeId as number)))) {
      result.faceIds.push(f.id as number);
    }
  }
  return result;
}

/**
 * Plan the offset of a chain of connected coplanar sketch edges in world space (open: a parallel
 * polyline; closed: a polygon offset), returned in context-local coordinates.
 */
export function planEdgeOffset(sketch: Sketch, frame: ContextFrame, edgeIds: readonly Id[], distance: number, allowOverlap: boolean): { rings: PlannedRing[]; curves: Map<string | number, Curve>; normal: Vec3 } {
  const chain = orderSketchEdgeChain(sketch, edgeIds);
  const world = chain.points.map((p) => frame.toWorld(p));
  const plane = chainPlane(world);
  const basis = planeBasis(world[0]!, plane.n);
  const uv = world.map((p): Vec2 => {
    const l = basisToLocal(basis, p);
    return [l[0], l[1]];
  });
  // arc tags of the chain's edges, in the world basis
  const scale = frame.identity ? 1 : inPlaneScale(frame, planeBasis(chain.points[0]!, frame.toLocalNormal(plane.n)));
  const curves = new Map<string | number, Curve>();
  const arcs = chain.edgeIds.map((id): OffsetArc | null => {
    const e = sketch.edges.get(id);
    const c = e?.curveId !== null && e?.curveId !== undefined ? sketch.curves.get(e.curveId) : undefined;
    if (!c || (c.kind !== 'arc' && c.kind !== 'circle') || scale === null) return null;
    curves.set(c.id as number, c);
    const l = basisToLocal(basis, frame.toWorld(c.center));
    return { key: c.id as number, center: [l[0], l[1]], radius: c.radius * scale };
  });
  if (!chain.closed) {
    const r = offsetPolylineFull(uv, distance, { arcs: [arcs.slice(0, uv.length - 1)] });
    return { rings: localRings([[r.points.map((p) => [p[0], p[1]])]], [[r.tags]], basis, frame).map((p) => p.map((ring) => ({ ...ring, closed: false })))[0]!, curves, normal: plane.n };
  }
  // ring orientation decides the sign convention; normalize so distance > 0 grows the loop
  const ccw = signedArea(uv) >= 0;
  const ring = ccw ? uv : uv.slice().reverse();
  const n = uv.length;
  const ringArcs = ccw ? arcs : arcs.map((_, j) => arcs[(2 * n - 2 - j) % n] ?? null);
  const plan = offsetPolygonFull([ring.map((p) => [p[0], p[1]])], distance, { arcs: [ringArcs], cleanup: !allowOverlap });
  if (!plan.polygons.length) throw new PushFormError('offset.vanished', 'Nothing is left of the loop at this distance');
  return { rings: localRings(plan.polygons, plan.tags, basis, frame).flat(), curves, normal: plane.n };
}

export const sketchOffset = defineCommand({
  id: 'sketch.offset',
  title: 'Offset',
  category: 'edit',
  params: OffsetParamsSchema,
  undoable: true,
  run(ctx, p): OffsetApplyResult {
    const host = hostOf(ctx);
    const tags = activeDrawTagOpts(ctx);
    if (Math.abs(p.distance) <= MERGE_TOL) throw new PushFormError('offset.zero', 'An offset of zero changes nothing');
    const state = host.doc.state;
    if (p.faceRef) {
      requireContextPath(host, p.faceRef.path, 'Face');
      const frame = contextFrame(state, p.faceRef.path as unknown as readonly Id[]);
      const info = resolveFaceTarget(state, p.faceRef);
      // the distance is a model distance: plan on the face as it is in the model, then map back
      const world = frame.identity ? info : resolveFaceTargetWorld(state, p.faceRef);
      const plan = planFaceOffset(world, p.distance, p.allowOverlap);
      if (!plan.polygons.length) throw vanished();
      const planned = localRings(plan.polygons, plan.tags, world.basis, frame);
      if (info.bodyId !== null && info.faceId !== null) {
        const face = rootContainerOf(state, p.faceRef.path).bodies.get(info.bodyId)?.faces.get(info.faceId);
        if (face && !ringsOnFace(face, planned.flat())) throw new PushFormError('offset.offFace', 'The offset would go past the edges of the face');
      }
      return host.edit('Offset', (draft) => applyFaceOffset(draft, info, planned, p.distance < 0, tags));
    }
    const path = host.context.path;
    const frame = contextFrame(state, path);
    const sketch = rootContainerOf(state, path).sketch;
    const plan = planEdgeOffset(sketch, frame, (p.edgeIds ?? []) as Id[], p.distance, p.allowOverlap);
    return host.edit('Offset', (draft) => {
      const result: OffsetApplyResult = { edgeIds: [], faceIds: [], rings: [] };
      const g = sketchGraphAt(draft, path);
      const facesBefore = new Set(g.sketch.faces.keys());
      addRings(draft, path, plan.rings, plan.curves, frame.toLocalNormal(plan.normal), null, tags, result);
      for (const id of g.sketch.faces.keys()) if (!facesBefore.has(id)) result.faceIds.push(id as number);
      return result;
    });
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
