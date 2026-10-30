// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { basisToLocal, MERGE_TOL, planeBasis, PushFormError, v3cross, v3dist, v3len, v3normalize, v3sub } from '@pushform/core';
import type { CurveId, FaceLocalId, Id, MVec3, Vec3 } from '@pushform/core';
import { tessellateCurve } from '@pushform/geom';
import { addImprintEdge, allocId, FaceFinder, findFaceContainingPoints, removeImprintEdge, sketchFaceEdgeIds } from '@pushform/model';
import type { Body, Curve, CurveKind, DocumentDraft, Draft, SketchFace, SketchGraph } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import { asDraftBody, currentFrame, draftContainerAt, sketchGraphAt, type ContextFrame } from './context';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const idSchema = z.number().int().nonnegative();

/** Geometric description of a curve as the tools compute it (centre/normal/radius/angles may be absent for freehand). */
export const CurveSpecSchema = z.object({
  kind: z.enum(['circle', 'arc', 'polygon', 'freehand']),
  center: vec3.optional(),
  normal: vec3.optional(),
  radius: z.number().nonnegative().optional(),
  startAngle: z.number().optional(),
  endAngle: z.number().optional(),
  segments: z.number().int().positive(),
});
export type CurveSpec = z.infer<typeof CurveSpecSchema>;

export const AddCurveParamsSchema = z.object({
  /** Polyline vertices (first point not repeated for closed curves). */
  points: z.array(vec3).min(2),
  closed: z.boolean(),
  curve: CurveSpecSchema,
  /**
   * Pie: close the curve back through this point with two plain edges (end → closeTo → start)
   * that do not belong to the curve, so a face forms.
   */
  closeTo: vec3.optional(),
});
export type AddCurveParams = z.infer<typeof AddCurveParamsSchema>;

/** Readonly-friendly shape of `sketch.addCurve` params for callers (tools) that hold `Vec3`s. */
export interface AddCurveInput {
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  readonly curve: {
    readonly kind: CurveKind;
    readonly center?: Vec3 | undefined;
    readonly normal?: Vec3 | undefined;
    readonly radius?: number | undefined;
    readonly startAngle?: number | undefined;
    readonly endAngle?: number | undefined;
    readonly segments: number;
  };
  readonly closeTo?: Vec3 | undefined;
}

export interface AddCurveResult {
  readonly curveId: number;
  /** Sketch edge ids, or imprint edge ids when routed onto a body face. */
  readonly edgeIds: number[];
  readonly routed: 'sketch' | 'imprint';
  /** Body / face the curve was imprinted on (imprint routing only). */
  readonly bodyId?: number;
  readonly faceId?: number;
}

/** Plain points for a polyline of a curve record (`segments + 1` points for arcs, `segments` otherwise). */
export function curvePoints(c: Pick<Curve, 'kind' | 'center' | 'normal' | 'radius' | 'startAngle' | 'endAngle' | 'segments'>): Vec3[] {
  if (c.kind === 'freehand') throw new PushFormError('curve.freehand', 'A freehand curve cannot be re-tessellated');
  return tessellateCurve({
    kind: c.kind,
    center: c.center,
    normal: c.normal,
    radius: c.radius,
    startAngle: c.startAngle,
    endAngle: c.endAngle,
    segments: c.segments,
  });
}

/** World-space curve params (as tools compute them) → context-local. */
export function localizeCurveParams(frame: ContextFrame, p: AddCurveParams): AddCurveParams {
  if (frame.identity) return p;
  const points = p.points.map((q): [number, number, number] => frame.toLocal(q));
  const curve = { ...p.curve };
  if (curve.center) {
    const center = frame.toLocal(curve.center);
    curve.center = center;
    // radius in the local frame (exact for rigid contexts; the first point's distance under scale)
    if (curve.radius !== undefined && points[0]) curve.radius = v3dist(center, points[0]);
  }
  if (curve.normal) curve.normal = frame.toLocalNormal(curve.normal);
  const out: AddCurveParams = { ...p, points, curve };
  if (p.closeTo) out.closeTo = frame.toLocal(p.closeTo);
  return out;
}

/** Normal of a best-fit plane through points (Newell), or +Z when degenerate. */
function polylineNormal(points: readonly Vec3[]): MVec3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (Math.hypot(nx, ny, nz) < 1e-12 && points.length >= 2) {
    const d = v3sub(points[1]!, points[0]!);
    const n = v3cross(d, Math.abs(d[2]) < 0.9 * v3len(d) ? [0, 0, 1] : [1, 0, 0]);
    return v3len(n) > 0 ? v3normalize(n) : [0, 0, 1];
  }
  return Math.hypot(nx, ny, nz) > 0 ? v3normalize([nx, ny, nz]) : [0, 0, 1];
}

function centroid(points: readonly Vec3[]): MVec3 {
  const c: [number, number, number] = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = Math.max(1, points.length);
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** Mutable copy of a curve record (tuples cloned) so it can be stored in a draft map. */
function toDraftCurve(c: Curve): Draft<Curve> {
  return {
    ...c,
    center: [c.center[0], c.center[1], c.center[2]],
    normal: [c.normal[0], c.normal[1], c.normal[2]],
    edgeRefs: [...c.edgeRefs],
  };
}

function curveRecord(id: CurveId, spec: CurveSpec, points: readonly Vec3[], edgeRefs: Curve['edgeRefs']): Draft<Curve> {
  const center = spec.center ?? centroid(points);
  const normal = spec.normal ?? polylineNormal(points);
  return {
    id,
    kind: spec.kind,
    center: [center[0], center[1], center[2]],
    normal: [normal[0], normal[1], normal[2]],
    radius: spec.radius ?? 0,
    startAngle: spec.startAngle ?? 0,
    endAngle: spec.endAngle ?? 0,
    segments: spec.segments,
    edgeRefs,
  };
}

/** Segments (a, b) of a polyline, closing when asked and dropping a repeated last point. */
function polylineSegments(points: readonly Vec3[], closed: boolean): [Vec3, Vec3][] {
  const pts = [...points];
  if (closed && pts.length > 2 && v3dist(pts[0]!, pts[pts.length - 1]!) <= MERGE_TOL) pts.pop();
  const n = pts.length;
  const count = closed && n > 2 ? n : n - 1;
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    if (v3dist(a, b) > MERGE_TOL) out.push([a, b]);
  }
  return out;
}

/**
 * Add a tessellated curve, routed like `sketch.addEdge`: when every point lies on one body face the
 * segments become imprint edges of that face carrying the curve id (the Curve record lives in
 * `body.curves`), otherwise they are sketch edges with the record in `sketch.curves`. The face
 * finder runs once over all new edges, so a closed curve forms a face.
 */
export function addCurveToDraft(draft: DocumentDraft, p: AddCurveParams, path: readonly number[] = []): AddCurveResult {
  const container = draftContainerAt(draft, path);
  const points = p.points as Vec3[];
  const segments = polylineSegments(points, p.closed);
  if (!segments.length) throw new PushFormError('curve.degenerate', 'Curve has no length');
  const extra: [Vec3, Vec3][] = [];
  if (p.closeTo && !p.closed) {
    const c = p.closeTo as Vec3;
    const first = segments[0]![0], last = segments[segments.length - 1]![1];
    if (v3dist(last, c) > MERGE_TOL) extra.push([last, c]);
    if (v3dist(c, first) > MERGE_TOL) extra.push([c, first]);
  }
  const allPoints = extra.length ? [...points, p.closeTo as Vec3] : points;
  const loc = findFaceContainingPoints(container, allPoints);
  const curveId = allocId<CurveId>(draft);

  if (loc) {
    const body = container.bodies.get(loc.bodyId);
    if (body) {
      const ids: number[] = [];
      const db = asDraftBody(body);
      for (const [a, b] of segments) {
        ids.push(...addImprintEdge(db, loc.faceId, a, b, { curveId }));
      }
      for (const [a, b] of extra) addImprintEdge(db, loc.faceId, a, b, {});
      if (!ids.length) throw new PushFormError('curve.degenerate', 'Curve has no length');
      body.curves.set(curveId, curveRecord(curveId, p.curve, points, ids.map((id) => id as Id)) as Curve);
      return { curveId, edgeIds: ids, routed: 'imprint', bodyId: loc.bodyId, faceId: loc.faceId };
    }
  }

  const g = sketchGraphAt(draft, path);
  const ids: Id[] = [];
  for (const [a, b] of segments) {
    for (const id of g.addEdge(a, b, { curveId, findFaces: false })) {
      const e = g.sketch.edges.get(id);
      if (e && e.curveId === null) e.curveId = curveId;
      ids.push(id);
    }
  }
  const extraIds: Id[] = [];
  for (const [a, b] of extra) extraIds.push(...g.addEdge(a, b, { findFaces: false }));
  g.sketch.curves.set(curveId, curveRecord(curveId, p.curve, points, [...ids]));
  FaceFinder.onEdgesAdded(g, [...ids, ...extraIds]);
  return { curveId, edgeIds: ids.map((id) => id as number), routed: 'sketch' };
}

export const addCurve = defineCommand({
  id: 'sketch.addCurve',
  title: 'Curve',
  category: 'draw',
  params: AddCurveParamsSchema,
  undoable: true,
  run(ctx, p): AddCurveResult {
    const host = hostOf(ctx);
    const frame = currentFrame(host);
    return host.edit('Curve', (draft) => addCurveToDraft(draft, localizeCurveParams(frame, p), frame.path));
  },
});

// ------------------------------------------------------------------------------- lookup

interface CurveHome {
  readonly curve: Curve;
  /** Body holding an imprinted curve, or null for a sketch curve. */
  readonly body: Draft<Body> | null;
  readonly faceId: FaceLocalId | null;
}

/** Find a curve record in the context's sketch or on any of its bodies (imprint curves). */
function findCurve(draft: DocumentDraft, path: readonly number[], curveId: CurveId): CurveHome | null {
  const container = draftContainerAt(draft, path);
  const sc = container.sketch.curves.get(curveId);
  if (sc) return { curve: sc as Curve, body: null, faceId: null };
  for (const body of container.bodies.values()) {
    const c = body.curves.get(curveId);
    if (!c) continue;
    let faceId: FaceLocalId | null = null;
    for (const [fid, g] of body.imprints) {
      for (const e of g.edges.values()) if (e.curveId === curveId) faceId = fid;
    }
    return { curve: c, body: asDraftBody(body), faceId };
  }
  return null;
}

/** Faces bounded by the curve's sketch edges (to carry materials across a re-tessellation). */
function facesOfCurve(g: SketchGraph, curve: Curve): SketchFace[] {
  const ids = new Set(curve.edgeRefs.filter((r): r is Id => typeof r === 'number'));
  const out: SketchFace[] = [];
  for (const f of g.sketch.faces.values()) {
    for (const id of sketchFaceEdgeIds(f)) {
      if (ids.has(id)) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

/**
 * Replace the edges of a circle/arc/polygon curve with a fresh tessellation of `next`. Sketch faces
 * bounded by the old edges are deleted with them and re-found from the new edges (materials of a
 * single bounded face are carried over). Imprint curves are rebuilt on their face.
 */
function retessellate(draft: DocumentDraft, path: readonly number[], home: CurveHome, next: Curve): number[] {
  const points = curvePoints(next);
  const closed = next.kind !== 'arc';
  const segments = polylineSegments(points, closed);
  if (home.body) {
    const body = home.body;
    if (home.faceId === null) throw new PushFormError('curve.notFound', 'Curve edges are not imprinted on a face');
    for (const ref of [...home.curve.edgeRefs]) if (typeof ref === 'number') removeImprintEdge(body, home.faceId, ref);
    const ids: number[] = [];
    for (const [a, b] of segments) {
      ids.push(...addImprintEdge(body, home.faceId, a, b, { curveId: next.id }));
    }
    body.curves.set(next.id, toDraftCurve({ ...next, edgeRefs: ids.map((id) => id as Id) }));
    return ids;
  }
  const g = sketchGraphAt(draft, path);
  const faces = facesOfCurve(g, home.curve);
  const material = faces.length === 1 ? { front: faces[0]!.frontMaterialId, back: faces[0]!.backMaterialId } : null;
  const before = new Set(g.sketch.faces.keys());
  // copy: removeEdge splices the record's edgeRefs while we walk them
  for (const ref of [...home.curve.edgeRefs]) if (typeof ref === 'number') g.removeEdge(ref);
  const ids: Id[] = [];
  for (const [a, b] of segments) {
    for (const id of g.addEdge(a, b, { curveId: next.id, findFaces: false })) {
      const e = g.sketch.edges.get(id);
      if (e && e.curveId === null) e.curveId = next.id;
      ids.push(id);
    }
  }
  g.sketch.curves.set(next.id, toDraftCurve({ ...next, edgeRefs: [...ids] }));
  FaceFinder.onEdgesAdded(g, ids);
  if (material) {
    for (const [fid, f] of g.sketch.faces) {
      if (before.has(fid)) continue;
      f.frontMaterialId = material.front;
      f.backMaterialId = material.back;
    }
  }
  return ids.map((id) => id as number);
}

function requireCurve(draft: DocumentDraft, path: readonly number[], curveId: number): CurveHome {
  const home = findCurve(draft, path, curveId as CurveId);
  if (!home) throw new PushFormError('curve.notFound', `Curve ${curveId} not found`);
  return home;
}

export const setCurveSegments = defineCommand({
  id: 'sketch.setCurveSegments',
  title: 'Curve Segments',
  category: 'edit',
  params: z.object({ curveId: idSchema, segments: z.number().int().positive() }),
  undoable: true,
  run(ctx, p): number[] {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Curve Segments', (draft) => {
      const home = requireCurve(draft, path, p.curveId);
      const min = home.curve.kind === 'arc' ? 1 : 3;
      return retessellate(draft, path, home, { ...home.curve, segments: Math.max(min, p.segments) });
    });
  },
});

export const setCurveRadius = defineCommand({
  id: 'sketch.setCurveRadius',
  title: 'Curve Radius',
  category: 'edit',
  params: z.object({ curveId: idSchema, radius: z.number().positive() }),
  undoable: true,
  run(ctx, p): number[] {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Curve Radius', (draft) => {
      const home = requireCurve(draft, path, p.curveId);
      return retessellate(draft, path, home, { ...home.curve, radius: p.radius });
    });
  },
});

/** Explode Curve: the edges stay, the curve record goes (they no longer select / infer as one). */
export const explodeCurve = defineCommand({
  id: 'sketch.explodeCurve',
  title: 'Explode Curve',
  category: 'edit',
  params: z.object({ curveId: idSchema }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Explode Curve', (draft) => {
      const home = requireCurve(draft, path, p.curveId);
      const id = home.curve.id;
      let n = 0;
      if (home.body) {
        for (const g of home.body.imprints.values()) {
          for (const e of g.edges.values()) {
            if (e.curveId === id) {
              e.curveId = null;
              n++;
            }
          }
        }
        for (const e of home.body.edges.values()) {
          if (e.curveId === id) {
            e.curveId = null;
            n++;
          }
        }
        home.body.curves.delete(id);
      } else {
        const sketch = draftContainerAt(draft, path).sketch;
        for (const e of sketch.edges.values()) {
          if (e.curveId === id) {
            e.curveId = null;
            n++;
          }
        }
        sketch.curves.delete(id);
      }
      return n;
    });
  },
});

/** Order edges into one chain (each edge sharing a vertex with the next). Returns null when they do not form a single chain. */
export function chainEdges(
  edges: readonly { id: Id; a: Id; b: Id }[],
): { ordered: Id[]; vertices: Id[]; closed: boolean } | null {
  if (!edges.length) return null;
  const byVertex = new Map<Id, { id: Id; a: Id; b: Id }[]>();
  for (const e of edges) {
    for (const v of [e.a, e.b]) {
      const l = byVertex.get(v);
      if (l) l.push(e);
      else byVertex.set(v, [e]);
    }
  }
  for (const l of byVertex.values()) if (l.length > 2) return null;
  const ends = [...byVertex.entries()].filter(([, l]) => l.length === 1).map(([v]) => v);
  if (ends.length !== 0 && ends.length !== 2) return null;
  const closed = ends.length === 0;
  let v = closed ? edges[0]!.a : ends[0]!;
  const used = new Set<Id>();
  const ordered: Id[] = [];
  const vertices: Id[] = [v];
  for (;;) {
    const next = (byVertex.get(v) ?? []).find((e) => !used.has(e.id));
    if (!next) break;
    used.add(next.id);
    ordered.push(next.id);
    v = next.a === v ? next.b : next.a;
    vertices.push(v);
  }
  if (ordered.length !== edges.length) return null;
  return { ordered, vertices, closed };
}

/** Weld Edges: make one freehand curve from connected sketch edges (existing curve membership is replaced). */
export const weld = defineCommand({
  id: 'sketch.weld',
  title: 'Weld Edges',
  category: 'edit',
  params: z.object({ edgeIds: z.array(idSchema).min(1) }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const path = host.context.path;
    return host.edit('Weld Edges', (draft) => {
      const g = sketchGraphAt(draft, path);
      const edges = p.edgeIds.map((id) => g.sketch.edges.get(id as Id)).filter((e) => e !== undefined);
      if (edges.length !== p.edgeIds.length) throw new PushFormError('curve.notFound', 'Some edges no longer exist');
      const chain = chainEdges(edges);
      if (!chain) throw new PushFormError('curve.notChain', 'Edges must form one connected chain to be welded');
      const curveId = allocId<CurveId>(draft);
      const points = chain.vertices.map((v) => g.pos(v));
      for (const id of chain.ordered) {
        const e = g.edge(id);
        if (e.curveId !== null) {
          const old = g.sketch.curves.get(e.curveId);
          if (old) {
            old.edgeRefs = old.edgeRefs.filter((r) => r !== id);
            if (!old.edgeRefs.length) g.sketch.curves.delete(old.id);
          }
        }
        e.curveId = curveId;
      }
      g.sketch.curves.set(
        curveId,
        curveRecord(curveId, { kind: 'freehand', segments: chain.ordered.length }, points, [...chain.ordered]),
      );
      return curveId;
    });
  },
});

// ------------------------------------------------------------------------------- fillet

export interface FilletResult {
  readonly curveId: number;
  readonly edgeIds: number[];
}

/**
 * Corner fillet (2-Point Arc double-click): the two sketch edges meeting at `vertex` are trimmed
 * back by the tangent length and joined by an arc of `radius` tangent to both. Faces bounded by
 * the corner are re-found from the new edges.
 */
export const fillet = defineCommand({
  id: 'sketch.fillet',
  title: 'Fillet Corner',
  category: 'draw',
  params: z.object({ vertex: vec3, radius: z.number().positive(), segments: z.number().int().positive().default(12) }),
  undoable: true,
  run(ctx, p): FilletResult {
    const host = hostOf(ctx);
    const frame = currentFrame(host);
    return host.edit('Fillet', (draft) => {
      const g = sketchGraphAt(draft, frame.path);
      const v = g.findVertex(frame.toLocal(p.vertex));
      if (v === undefined) throw new PushFormError('fillet.noVertex', 'No vertex at that point');
      const incident = [...g.sketch.edges.values()].filter((e) => e.a === v || e.b === v);
      if (incident.length !== 2) throw new PushFormError('fillet.notCorner', 'A corner needs exactly two edges');
      const [e1, e2] = incident as [typeof incident[0], typeof incident[0]];
      const V = g.pos(v);
      const X1 = g.pos(e1.a === v ? e1.b : e1.a), X2 = g.pos(e2.a === v ? e2.b : e2.a);
      const d1 = v3normalize(v3sub(X1, V)), d2 = v3normalize(v3sub(X2, V));
      const cosA = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]));
      const angle = Math.acos(cosA); // interior angle at the corner
      if (angle < 1e-6 || Math.PI - angle < 1e-6) throw new PushFormError('fillet.collinear', 'Edges at the corner are collinear');
      const half = angle / 2;
      const t = p.radius / Math.tan(half); // tangent length along each edge
      if (t > v3dist(V, X1) - MERGE_TOL || t > v3dist(V, X2) - MERGE_TOL) {
        throw new PushFormError('fillet.tooLarge', 'Radius is too large for the corner');
      }
      const P1: Vec3 = [V[0] + d1[0] * t, V[1] + d1[1] * t, V[2] + d1[2] * t];
      const P2: Vec3 = [V[0] + d2[0] * t, V[1] + d2[1] * t, V[2] + d2[2] * t];
      const bis = v3normalize([d1[0] + d2[0], d1[1] + d2[1], d1[2] + d2[2]]);
      const cd = p.radius / Math.sin(half);
      const center: MVec3 = [V[0] + bis[0] * cd, V[1] + bis[1] * cd, V[2] + bis[2] * cd];
      // arc from P1 to P2 around center, sweeping through the corner side (the short way)
      let normal = v3normalize(v3cross(v3sub(P1, center), v3sub(P2, center)));
      if (v3len(normal) === 0) normal = polylineNormal([V, X1, X2]);
      const sweep = Math.PI - angle;
      const startAngle = angleInPlane(center, normal, P1);
      const spec: CurveSpec = {
        kind: 'arc',
        center,
        normal,
        radius: p.radius,
        startAngle,
        endAngle: startAngle + sweep,
        segments: p.segments,
      };
      const faces = [...g.facesUsingEdge(e1.id), ...g.facesUsingEdge(e2.id)];
      const material = faces.length ? { front: faces[0]!.frontMaterialId, back: faces[0]!.backMaterialId } : null;
      const before = new Set(g.sketch.faces.keys());
      g.removeEdge(e1.id);
      g.removeEdge(e2.id);
      const ids: Id[] = [];
      ids.push(...g.addEdge(X1, P1, { findFaces: false }));
      const curveId = allocId<CurveId>(draft);
      const arcPts = curvePoints({ kind: 'arc', center, normal, radius: p.radius, startAngle, endAngle: startAngle + sweep, segments: p.segments });
      const curveIds: Id[] = [];
      for (const [a, b] of polylineSegments(arcPts, false)) {
        for (const id of g.addEdge(a, b, { curveId, findFaces: false })) {
          const e = g.sketch.edges.get(id);
          if (e && e.curveId === null) e.curveId = curveId;
          curveIds.push(id);
        }
      }
      ids.push(...curveIds);
      ids.push(...g.addEdge(P2, X2, { findFaces: false }));
      g.sketch.curves.set(curveId, curveRecord(curveId, spec, arcPts, [...curveIds]));
      FaceFinder.onEdgesAdded(g, ids);
      if (material) {
        for (const [fid, f] of g.sketch.faces) {
          if (before.has(fid)) continue;
          f.frontMaterialId = material.front;
          f.backMaterialId = material.back;
        }
      }
      return { curveId, edgeIds: curveIds.map((id) => id as number) };
    });
  },
});

/** Angle of `p` about `center` in the plane basis of `normal` (matches `@pushform/geom` curves). */
export function angleInPlane(center: Vec3, normal: Vec3, p: Vec3): number {
  const l = basisToLocal(planeBasis(center, normal), p);
  return Math.atan2(l[1], l[0]);
}

export const curveCommands: readonly AnyCommand[] = [addCurve, setCurveSegments, setCurveRadius, explodeCurve, weld, fillet];

export type { CurveKind };
