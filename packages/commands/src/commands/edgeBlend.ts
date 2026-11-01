// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id, MeshData, SurfaceId, Vec2, Vec3 } from '@pushform/core';
import {
  basisToLocal,
  EDGE_BLEND_MIN_END_ANGLE,
  EDGE_BLEND_MIN_FACE_ANGLE,
  formatLength,
  MERGE_TOL,
  meshSignedVolume,
  PushFormError,
  AREA_TOL,
  v3add,
  v3addScaled,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3normalize,
  v3scale,
  v3sub,
} from '@pushform/core';
import { pointInPolygon, signedArea, triangulatePolygon } from '@pushform/geom';
import type { EdgeBlendRequest, EdgeBlendResult, KernelClient, KernelComponent, ToolSoup } from '@pushform/kernel';
import type { Body, DocumentDraft, DocumentState, EdgeKey, EdgeRecord, EntityContainer, FaceRecord, KernelFaceOrigin } from '@pushform/model';
import { allocId, applyKernelResult, containerAt } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import { draftContainerAt, requireContextPath } from './context';

/**
 * Fillet and Chamfer: round or bevel picked hard edges of one solid.
 *
 * Planning (pure, from the document state) turns every picked edge into a closed tool prism: the
 * cross-section between the two faces beside the edge (a wedge minus the fillet circle, or the
 * chamfer triangle) swept along the edge. A convex edge's prism is cut from the solid, a concave
 * edge's prism is added. Where two picked edges meet, both prisms end on the mitre plane between
 * them and share its vertices; a prism that ends at an unpicked corner ends on the third face
 * there. A chamfer may also bevel three picked edges that meet at a corner of three faces: each of
 * their prisms ends on the third face as at an unpicked corner, and the union of the overlapping
 * prisms makes the chamfer planes cut into each other there. The kernel runs `body − cut + add` in
 * one op (`edgeBlend`), and the fillet faces of every chain of picked edges become one smooth
 * surface with soft, smooth edges between them.
 */

export type EdgeBlendKind = 'fillet' | 'chamfer';

/** Default number of segments a full circle of fillet faces would have (the Circle tool's default). */
export const DEFAULT_BLEND_SEGMENTS = 24;
/** Outward padding of a cut prism beyond the faces it cuts, as a fraction of the setback. */
const PAD_FRACTION = 0.25;
/** Setback lines are tested for fitting on a face with this fraction trimmed off each end. */
const END_TRIM = 0.01;

const pathSchema = z.array(z.number().int().nonnegative()).default([]);
const isEdgeBlendResult = (v: unknown): v is EdgeBlendResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components) && typeof (v as { toolRunId?: unknown }).toolRunId === 'number';

export const EdgeBlendParamsSchema = z.object({
  /** Edit context holding the solid. */
  path: pathSchema,
  bodyId: z.number().int().nonnegative(),
  /** Edge keys of the solid's hard edges to round or bevel. */
  edges: z.array(z.string()).min(1),
  /** Fillet radius or chamfer distance (meters, in the context's coordinates). */
  size: z.number().finite().positive(),
  /** Fillet only: segments a full circle of fillet faces would have. */
  segments: z.number().int().min(3).max(999).default(DEFAULT_BLEND_SEGMENTS),
  /** A kernel result already computed for exactly these params (the tool's matching preview). */
  precomputed: z.custom<EdgeBlendResult>(isEdgeBlendResult).optional(),
});
export type EdgeBlendParams = z.input<typeof EdgeBlendParamsSchema>;

export interface EdgeBlendApplyResult {
  bodyId: number;
  /** Faces created by the operation (the fillet or chamfer faces). */
  faceIds: number[];
}

/** A hard edge: neither soft, smooth nor hidden. Only these are offered to Fillet and Chamfer. */
export const isHardEdge = (e: EdgeRecord): boolean => !e.soft && !e.smooth && !e.hidden;

/**
 * The edges picked together with `key`: every hard edge of the same curve (a circle's or arc's
 * segments) when the edge belongs to one, else the edge alone. Empty when the edge is not hard.
 */
export function blendEdgeGroup(body: Body, key: EdgeKey): EdgeKey[] {
  const e = body.edges.get(key);
  if (!e || !isHardEdge(e)) return [];
  if (e.curveId === null) return [key];
  const out: EdgeKey[] = [];
  for (const o of body.edges.values()) if (o.curveId === e.curveId && isHardEdge(o)) out.push(o.key);
  return out.length ? out : [key];
}

// ---------------------------------------------------------------------------------------------
// Planning

export interface EdgeBlendPlan {
  readonly kind: EdgeBlendKind;
  readonly path: readonly Id[];
  readonly body: Body;
  readonly request: Omit<EdgeBlendRequest, 'type'>;
  /** Prism face label → surface group, for the fillet/chamfer faces only. */
  readonly blendFaces: ReadonlyMap<number, number>;
  /** Groups whose faces become one smooth surface. */
  readonly smoothGroups: ReadonlySet<number>;
}

const fail = (code: string, message: string): never => {
  throw new PushFormError(`edgeblend.${code}`, message);
};

interface FaceSide {
  face: FaceRecord;
  n: Vec3;
  /** Unit direction in the face, perpendicular to the edge, pointing into the face. */
  inward: Vec3;
}

interface EdgeInfo {
  rec: EdgeRecord;
  /** Endpoints in chain order. */
  v0: Vec3;
  v1: Vec3;
  d: Vec3;
  a: FaceSide;
  b: FaceSide;
  convex: boolean;
  /** Distance from the edge to where the fillet or chamfer meets each face. */
  setback: number;
  /** Fillet: interior angle of the arc (radians); 0 for a chamfer. */
  sweep: number;
  /** Vertex ids (indices into the vertex list) of the endpoints, in chain order. */
  i0: number;
  i1: number;
}

const distToLine = (p: Vec3, o: Vec3, d: Vec3): number => {
  const w = v3sub(p, o);
  return v3len(v3sub(w, v3scale(d, v3dot(w, d))));
};

/** The side of `faceId` along the straight edge p0→p1: its normal and the inward direction. */
function faceSide(body: Body, faceId: FaceLocalId, p0: Vec3, p1: Vec3): FaceSide | undefined {
  const face = body.faces.get(faceId);
  if (!face) return undefined;
  const len = v3dist(p0, p1);
  if (len <= MERGE_TOL) return undefined;
  const d = v3scale(v3sub(p1, p0), 1 / len);
  for (const loop of face.loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      if (distToLine(a, p0, d) > MERGE_TOL || distToLine(b, p0, d) > MERGE_TOL) continue;
      const ta = v3dot(v3sub(a, p0), d), tb = v3dot(v3sub(b, p0), d);
      const overlap = Math.min(Math.max(ta, tb), len) - Math.max(Math.min(ta, tb), 0);
      if (overlap <= MERGE_TOL) continue;
      // loops run CCW about the normal (holes CW), so the face lies to the left of each segment
      const t = v3normalize(v3sub(b, a));
      return { face, n: face.plane.n, inward: v3normalize(v3cross(face.plane.n, t)) };
    }
  }
  return undefined;
}

/** Whether a body edge is convex (the solid lies inside both face planes there). */
function edgeIsConvex(body: Body, rec: EdgeRecord): boolean | undefined {
  const p0 = rec.polyline[0], p1 = rec.polyline[rec.polyline.length - 1];
  if (!p0 || !p1) return undefined;
  const a = faceSide(body, rec.faceA, p0, p1);
  const fb = body.faces.get(rec.faceB);
  if (!a || !fb) return undefined;
  return v3dot(a.inward, fb.plane.n) < 0;
}

/** Faces of the body with a loop vertex at `v`. */
function facesAt(body: Body, v: Vec3): Set<FaceLocalId> {
  const out = new Set<FaceLocalId>();
  for (const [fid, f] of body.faces) {
    if (f.loops.some((loop) => loop.some((p) => v3dist(p, v) <= MERGE_TOL))) out.add(fid);
  }
  return out;
}

/** Point `q` moved along `d` onto the plane through `o` with normal `n`. */
function projectAlong(q: Vec3, d: Vec3, o: Vec3, n: Vec3): Vec3 {
  return v3addScaled(q, d, v3dot(n, v3sub(o, q)) / v3dot(n, d));
}

interface Profile {
  /** Cross-section points (perpendicular plane through the reference point). */
  points: Vec3[];
  /** Index of the point where the blend meets face A / face B. */
  ta: number;
  tb: number;
  /** Profile edge indices (i → i+1) that are fillet or chamfer faces. */
  blendEdges: Set<number>;
}

/** Arc segments for a fillet sweeping `sweep` radians with `segments` per full circle. */
const arcSegments = (sweep: number, segments: number): number => Math.max(1, Math.round((segments * sweep) / (2 * Math.PI)));

/**
 * Cross-section of the tool prism at `p` on the edge line. Convex: [T_A, pads outside both faces,
 * T_B, arc or chamfer back to T_A], removed from the solid. Concave: [T_A, P, T_B, arc or chamfer
 * back to T_A], added to it.
 */
function profileAt(e: EdgeInfo, p: Vec3, kind: EdgeBlendKind, size: number, segments: number): Profile {
  const { a, b, setback: s } = e;
  const tA = v3addScaled(p, a.inward, s);
  const tB = v3addScaled(p, b.inward, s);
  const points: Vec3[] = [tA];
  if (e.convex) {
    const m = s * PAD_FRACTION;
    points.push(v3addScaled(tA, a.n, m), v3addScaled(p, v3add(a.n, b.n), m), v3addScaled(tB, b.n, m));
  } else {
    points.push(p);
  }
  const tb = points.length;
  points.push(tB);
  const first = tb;
  if (kind === 'fillet') {
    const sigma = e.convex ? -1 : 1;
    const c = v3addScaled(tA, a.n, sigma * size);
    const v0 = v3sub(tB, c), v1 = v3sub(tA, c);
    const phi = e.sweep;
    const k = arcSegments(phi, segments);
    const sinPhi = Math.sin(phi);
    for (let i = 1; i < k; i++) {
      const t = i / k;
      const w0 = Math.sin((1 - t) * phi) / sinPhi, w1 = Math.sin(t * phi) / sinPhi;
      points.push(v3add(c, v3add(v3scale(v0, w0), v3scale(v1, w1))));
    }
  }
  const blendEdges = new Set<number>();
  for (let i = first; i < points.length; i++) blendEdges.add(i);
  return { points, ta: 0, tb, blendEdges };
}

/** Earcut of a cross-section, as indices into its points. */
function triangulateSection(points: readonly Vec3[], p: Vec3, u: Vec3, v: Vec3): number[] {
  const pts2: Vec2[] = points.map((q) => {
    const w = v3sub(q, p);
    return [v3dot(w, u), v3dot(w, v)];
  });
  const tri = triangulatePolygon([pts2.map((q) => [q[0], q[1]])]);
  const index = new Map<string, number>(pts2.map((q, i) => [`${q[0]},${q[1]}`, i]));
  const out: number[] = [];
  for (const k of tri.indices) {
    const i = index.get(`${tri.coords[k * 2]},${tri.coords[k * 2 + 1]}`);
    if (i === undefined) fail('internal', 'The fillet cross-section could not be triangulated');
    out.push(i!);
  }
  if (out.length !== (points.length - 2) * 3) fail('internal', 'The fillet cross-section could not be triangulated');
  // earcut winds every triangle CCW; wind them like the ring so caps and sides agree
  if (signedArea(pts2) < 0) {
    for (let t = 0; t < out.length; t += 3) [out[t + 1], out[t + 2]] = [out[t + 2]!, out[t + 1]!];
  }
  return out;
}

/** Closed prism between two sections with matching vertex order; winding fixed by signed volume. */
function prismSoup(s0: readonly Vec3[], s1: readonly Vec3[], cap: readonly number[], labelBase: number): ToolSoup {
  const n = s0.length;
  const verts = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    verts.set(s0[i]!, i * 3);
    verts.set(s1[i]!, (n + i) * 3);
  }
  const tris: number[] = [], faceId: number[] = [];
  for (let t = 0; t + 2 < cap.length; t += 3) {
    tris.push(cap[t]!, cap[t + 2]!, cap[t + 1]!);
    faceId.push(labelBase);
    tris.push(n + cap[t]!, n + cap[t + 1]!, n + cap[t + 2]!);
    faceId.push(labelBase + 1);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(i, j, n + j, i, n + j, n + i);
    faceId.push(labelBase + 2 + i, labelBase + 2 + i);
  }
  const soup = { verts, tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId) };
  const volume = meshSignedVolume(soup as MeshData);
  if (Math.abs(volume) <= AREA_TOL * AREA_TOL) fail('internal', 'A fillet tool prism has no volume');
  if (volume < 0) {
    for (let t = 0; t < soup.tris.length; t += 3) {
      const tmp = soup.tris[t + 1]!;
      soup.tris[t + 1] = soup.tris[t + 2]!;
      soup.tris[t + 2] = tmp;
    }
  }
  return soup;
}

type Seg2 = readonly [Vec2, Vec2];

function segSegDist(p: Seg2, q: Seg2): number {
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const [a, b] = p, [c, d] = q;
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const ptSeg = (pt: Vec2, s0: Vec2, s1: Vec2): number => {
    const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((pt[0] - s0[0]) * dx + (pt[1] - s0[1]) * dy) / l2)) : 0;
    return Math.hypot(pt[0] - (s0[0] + t * dx), pt[1] - (s0[1] + t * dy));
  };
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

const to2 = (face: FaceRecord, p: Vec3): Vec2 => {
  const l = basisToLocal(face.basis, p);
  return [l[0], l[1]];
};

/** Whether the segment p→q (trimmed slightly at both ends) lies strictly inside the face. */
function segmentFitsFace(face: FaceRecord, p: Vec3, q: Vec3): boolean {
  const a = to2(face, v3addScaled(p, v3sub(q, p), END_TRIM));
  const b = to2(face, v3addScaled(q, v3sub(p, q), END_TRIM));
  const poly = face.loops.map((loop) => loop.map((x) => [...to2(face, x)]));
  if (!pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], poly)) return false;
  for (const loop of poly) {
    for (let i = 0; i < loop.length; i++) {
      const c = loop[i]!, d = loop[(i + 1) % loop.length]!;
      if (segSegDist([a, b], [[c[0]!, c[1]!], [d[0]!, d[1]!]]) <= MERGE_TOL) return false;
    }
  }
  return true;
}

/** Separating-axis overlap test of two convex quads in 2D (touching counts as apart). */
function quadsOverlap(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const axis: Vec2 = [b[1] - a[1], a[0] - b[0]];
      const len = Math.hypot(axis[0], axis[1]);
      if (len <= 0) continue;
      const proj = (pts: readonly Vec2[]): [number, number] => {
        let lo = Infinity, hi = -Infinity;
        for (const x of pts) {
          const v = (x[0] * axis[0] + x[1] * axis[1]) / len;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        return [lo, hi];
      };
      const [l1, h1] = proj(p), [l2, h2] = proj(q);
      if (h1 <= l2 + MERGE_TOL || h2 <= l1 + MERGE_TOL) return false;
    }
  }
  return true;
}

/**
 * Resolve picked edges into tool prisms. Throws `PushFormError('edgeblend.*')` with a message for
 * the user when the operation is refused; the document is never touched.
 */
export function planEdgeBlend(state: DocumentState, kind: EdgeBlendKind, params: z.output<typeof EdgeBlendParamsSchema>): EdgeBlendPlan {
  const title = kind === 'fillet' ? 'Fillet' : 'Chamfer';
  const what = kind === 'fillet' ? 'radius' : 'distance';
  const path = params.path as unknown as readonly Id[];
  let container: EntityContainer;
  try {
    container = containerAt(state, path);
  } catch (e) {
    return fail('target', e instanceof Error ? e.message : String(e));
  }
  const body = container.bodies.get(params.bodyId as Id);
  if (!body) return fail('target', `${title}: solid ${params.bodyId} not found`);
  if (!body.valid) fail('notSolid', `${title} works on solids only.`);
  const size = params.size;
  if (size <= MERGE_TOL) fail('tooSmall', `The ${what} is too small.`);
  const fmt = (m: number): string => formatLength(m, state.meta.units);

  // --- edges and their frames --------------------------------------------------------------
  const vertices: Vec3[] = [];
  const vertexId = (p: Vec3): number => {
    const i = vertices.findIndex((v) => v3dist(v, p) <= MERGE_TOL);
    if (i >= 0) return i;
    vertices.push(p);
    return vertices.length - 1;
  };
  const edges: EdgeInfo[] = [];
  for (const key of new Set(params.edges)) {
    const rec = body.edges.get(key as EdgeKey);
    if (!rec) fail('target', `${title}: an edge is no longer part of the solid.`);
    if (!isHardEdge(rec!)) fail('notHard', `${title} works on hard edges only; soft, smooth and hidden edges are not rounded.`);
    const v0 = rec!.polyline[0]!, v1 = rec!.polyline[rec!.polyline.length - 1]!;
    const a = faceSide(body, rec!.faceA, v0, v1), b = faceSide(body, rec!.faceB, v0, v1);
    if (!a || !b) return fail('geometry', `${title}: an edge does not lie on its faces.`);
    const cosAlpha = Math.max(-1, Math.min(1, v3dot(a.inward, b.inward)));
    const alpha = Math.acos(cosAlpha);
    if (alpha < EDGE_BLEND_MIN_FACE_ANGLE || alpha > Math.PI - EDGE_BLEND_MIN_FACE_ANGLE) {
      fail('geometry', `${title}: the faces beside an edge are almost flat or folded shut.`);
    }
    const setback = kind === 'fillet' ? size / Math.tan(alpha / 2) : size;
    edges.push({
      rec: rec!,
      v0,
      v1,
      d: v3normalize(v3sub(v1, v0)),
      a,
      b,
      convex: v3dot(a.inward, b.n) < 0,
      setback,
      sweep: kind === 'fillet' ? Math.PI - alpha : 0,
      i0: vertexId(v0),
      i1: vertexId(v1),
    });
  }

  // --- chains: picked edges joined end to end ----------------------------------------------
  const incident = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const v of [e.i0, e.i1]) (incident.get(v) ?? incident.set(v, []).get(v)!).push(i);
  });
  // Chamfer corners: three picked edges meeting where three faces meet. Each edge ends freely on
  // the third face there and the chamfer planes cut into each other; no mitre chain runs through.
  const corners = new Set<number>();
  for (const [v, list] of incident) {
    if (list.length <= 2) continue;
    if (kind === 'fillet') fail('corner', `${title} cannot round a corner where three or more picked edges meet.`);
    if (list.length !== 3 || facesAt(body, vertices[v]!).size !== 3) {
      fail('corner', `${title} can only bevel picked edges that meet three at a corner where three faces meet.`);
    }
    if (list.some((i) => edges[i]!.convex !== edges[list[0]!]!.convex)) {
      fail('corner', `${title} cannot bevel a corner where outside and inside picked edges meet.`);
    }
    corners.add(v);
  }
  const reverse = (e: EdgeInfo): void => {
    [e.v0, e.v1] = [e.v1, e.v0];
    [e.i0, e.i1] = [e.i1, e.i0];
    e.d = v3scale(e.d, -1);
  };
  const chains: { edges: EdgeInfo[]; closed: boolean }[] = [];
  const used = new Set<number>();
  const walk = (start: number, from: number): void => {
    const chain: EdgeInfo[] = [];
    let cur = start;
    let at = from;
    for (;;) {
      used.add(cur);
      const e = edges[cur]!;
      if (e.i0 !== at) reverse(e);
      chain.push(e);
      at = e.i1;
      const next = corners.has(at) ? undefined : (incident.get(at) ?? []).find((j) => j !== cur && !used.has(j));
      if (next === undefined) break;
      cur = next;
    }
    const closed = chain.length > 1 && chain[chain.length - 1]!.i1 === chain[0]!.i0 && !corners.has(chain[0]!.i0);
    chains.push({ edges: chain, closed });
  };
  const chainEnd = (v: number): boolean => corners.has(v) || (incident.get(v) ?? []).length === 1;
  edges.forEach((e, i) => {
    if (used.has(i)) return;
    if (chainEnd(e.i0)) walk(i, e.i0);
    else if (chainEnd(e.i1)) walk(i, e.i1);
  });
  edges.forEach((e, i) => {
    if (!used.has(i)) walk(i, e.i0); // closed loops
  });

  // --- end planes -----------------------------------------------------------------------------
  interface End {
    origin: Vec3;
    normal: Vec3;
    /** Distance the cap is moved past the plane (away from the edge) so a cut clears the face. */
    extend: number;
  }
  const minEndCos = Math.sin(EDGE_BLEND_MIN_END_ANGLE);
  const freeEnd = (e: EdgeInfo, v: Vec3): End => {
    const others = [...facesAt(body, v)].filter((f) => f !== e.rec.faceA && f !== e.rec.faceB);
    if (others.length !== 1) fail('corner', `${title} can only end an edge at a corner where three faces meet.`);
    const end = body.faces.get(others[0]!)!;
    if (Math.abs(v3dot(end.plane.n, e.d)) < minEndCos) fail('corner', `${title}: an edge meets the face at its end at too shallow an angle.`);
    let extend = 0;
    if (e.convex) {
      // past an all-convex corner the space beyond the end face is empty, so the cut may overshoot it
      const convexWith = (f: FaceLocalId): boolean =>
        [...body.edges.values()].some(
          (r) =>
            ((r.faceA === f && r.faceB === end.id) || (r.faceB === f && r.faceA === end.id)) &&
            r.polyline.some((p) => v3dist(p, v) <= MERGE_TOL) &&
            edgeIsConvex(body, r) === true,
        );
      if (convexWith(e.rec.faceA) && convexWith(e.rec.faceB)) extend = e.setback * PAD_FRACTION;
    }
    return { origin: v, normal: end.plane.n, extend };
  };

  // --- prisms -------------------------------------------------------------------------------
  const cut: ToolSoup[] = [];
  const add: ToolSoup[] = [];
  const blendFaces = new Map<number, number>();
  const smoothGroups = new Set<number>();
  let labelBase = 0;
  let group = 0;
  /** Per picked edge and face beside it: the strip of that face the blend replaces. */
  const strips: { face: FaceLocalId; quad: Vec3[]; edge: EdgeInfo }[] = [];

  for (const chain of chains) {
    const n = chain.edges.length;
    const joint = (i: number): Vec3 | null => {
      // mitre normal at the end of edge i (between i and i+1), or null at a free end
      const e = chain.edges[i]!;
      const next = i + 1 < n ? chain.edges[i + 1] : chain.closed ? chain.edges[0] : undefined;
      if (!next) return null;
      const shared = [e.rec.faceA, e.rec.faceB].filter((f) => f === next.rec.faceA || f === next.rec.faceB);
      if (shared.length !== 1) fail('corner', `${title}: picked edges that meet must share exactly one face.`);
      if (e.convex !== next.convex) fail('corner', `${title} cannot continue round a corner from an outside edge to an inside edge.`);
      if (facesAt(body, e.v1).size !== 3) fail('corner', `${title} can only join picked edges at a corner where three faces meet.`);
      const m = v3add(e.d, next.d);
      if (v3len(m) < minEndCos) fail('corner', `${title}: picked edges fold back on each other.`);
      return v3normalize(m);
    };
    const ends: { start: End; end: End }[] = chain.edges.map((e, i) => {
      const startMitre = i > 0 ? joint(i - 1) : chain.closed ? joint(n - 1) : null;
      const endMitre = joint(i);
      return {
        start: startMitre ? { origin: e.v0, normal: startMitre, extend: 0 } : freeEnd(e, e.v0),
        end: endMitre ? { origin: e.v1, normal: endMitre, extend: 0 } : freeEnd(e, e.v1),
      };
    });
    const allOneCurve = chain.edges.every((e) => e.rec.curveId !== null && e.rec.curveId === chain.edges[0]!.rec.curveId);
    if (kind === 'fillet' || allOneCurve) smoothGroups.add(group);

    let previousEnd: Vec3[] | null = null;
    let firstStart: Vec3[] | null = null;
    const sections: { s0: Vec3[]; s1: Vec3[]; profile: Profile; e: EdgeInfo }[] = [];
    chain.edges.forEach((e, i) => {
      const { start, end } = ends[i]!;
      const prof0 = profileAt(e, e.v0, kind, size, params.segments);
      const prof1 = profileAt(e, e.v1, kind, size, params.segments);
      let s0 = prof0.points.map((q) => projectAlong(q, e.d, start.origin, start.normal));
      const s1 = prof1.points.map((q) => projectAlong(q, e.d, end.origin, end.normal));
      // fit checks on the unextended prism: the blend's boundary lines must lie on the faces
      if (!segmentFitsFace(e.a.face, s0[prof0.ta]!, s1[prof0.ta]!) || !segmentFitsFace(e.b.face, s0[prof0.tb]!, s1[prof0.tb]!)) {
        fail('tooLarge', `The ${what} ${fmt(size)} is too large for the picked edges: the ${kind} does not fit on the faces beside an edge.`);
      }
      strips.push({ face: e.a.face.id, quad: [e.v0, e.v1, s1[prof0.ta]!, s0[prof0.ta]!], edge: e });
      strips.push({ face: e.b.face.id, quad: [e.v0, e.v1, s1[prof0.tb]!, s0[prof0.tb]!], edge: e });
      // vertices shared with the previous prism's mitre are taken from it exactly
      const snap = (pts: Vec3[], ref: readonly Vec3[] | null): Vec3[] =>
        ref ? pts.map((q) => ref.find((r) => v3dist(r, q) <= MERGE_TOL) ?? q) : pts;
      s0 = snap(s0, previousEnd);
      if (i === 0) firstStart = s0;
      let s1f = s1;
      if (chain.closed && i === n - 1) s1f = snap(s1, firstStart);
      previousEnd = s1f;
      sections.push({ s0, s1: s1f, profile: prof0, e });
      if (start.extend > 0) s0 = s0.map((q) => v3addScaled(q, e.d, -start.extend));
      const s1x = end.extend > 0 ? s1f.map((q) => v3addScaled(q, e.d, end.extend)) : s1f;
      const u = e.a.inward;
      const vdir = v3normalize(v3cross(e.d, u));
      const cap = triangulateSection(prof0.points, e.v0, u, vdir);
      const soup = prismSoup(s0, s1x, cap, labelBase);
      for (const i2 of prof0.blendEdges) blendFaces.set(labelBase + 2 + i2, group);
      labelBase += prof0.points.length + 2;
      (e.convex ? cut : add).push(soup);
    });
    group++;
  }

  // --- blends on one face must not run into each other --------------------------------------
  const quads = strips;
  for (let i = 0; i < quads.length; i++) {
    for (let j = i + 1; j < quads.length; j++) {
      const p = quads[i]!, q = quads[j]!;
      if (p.face !== q.face || p.edge === q.edge) continue;
      const adjacent = p.edge.i0 === q.edge.i0 || p.edge.i0 === q.edge.i1 || p.edge.i1 === q.edge.i0 || p.edge.i1 === q.edge.i1;
      if (adjacent) continue;
      const face = body.faces.get(p.face)!;
      if (quadsOverlap(p.quad.map((x) => to2(face, x)), q.quad.map((x) => to2(face, x)))) {
        fail('tooLarge', `The ${what} ${fmt(size)} is too large: the ${kind}s of two picked edges would run into each other.`);
      }
    }
  }

  return {
    kind,
    path,
    body,
    request: { body: { bodyId: body.id, version: body.version }, cut, add, nextFaceId: body.nextFaceId },
    blendFaces,
    smoothGroups,
  };
}

/** Run the plan on the kernel (uploading the body first when needed). */
export async function runEdgeBlendKernel(kernel: KernelClient, plan: EdgeBlendPlan, preview = false): Promise<EdgeBlendResult> {
  await kernel.ensureBody(plan.body.id, plan.body.version, plan.body.mesh);
  return kernel.edgeBlend(preview ? { ...plan.request, preview: true } : plan.request);
}

/** Refuse a kernel result that is not exactly one solid (the tools broke the solid apart). */
export function checkEdgeBlendResult(plan: EdgeBlendPlan, result: EdgeBlendResult): KernelComponent {
  const what = plan.kind === 'fillet' ? 'radius' : 'distance';
  const first = result.components[0];
  if (!first || result.components.length !== 1) {
    fail('tooLarge', `The ${what} is too large: the ${plan.kind} would break the solid apart.`);
  }
  return first!;
}

// ---------------------------------------------------------------------------------------------
// Apply

/** Apply a kernel result for `plan` in a transaction draft: reconcile, then mark the blend surfaces. */
export function applyEdgeBlendResult(draft: DocumentDraft, plan: EdgeBlendPlan, result: EdgeBlendResult): EdgeBlendApplyResult {
  const container = draftContainerAt(draft, plan.path);
  const current = container.bodies.get(plan.body.id);
  if (!current || current.version !== plan.body.version) {
    fail('stale', `The solid changed before ${plan.kind === 'fillet' ? 'Fillet' : 'Chamfer'} could be applied`);
  }
  const first = checkEdgeBlendResult(plan, result);
  const faceOrigin = first.faceOrigin as unknown as Map<FaceLocalId, KernelFaceOrigin[]>;
  const updated = applyKernelResult(draft, plan.body.id, {
    mesh: { verts: first.mesh.verts, tris: first.mesh.tris, faceId: first.mesh.faceId },
    faceOrigin,
    selfRunId: result.bodyRunId,
    props: first.props,
  });
  updated.nextFaceId = Math.max(updated.nextFaceId, result.nextFaceId);

  const groups = new Map<number, FaceLocalId[]>();
  const created: number[] = [];
  for (const fid of updated.faces.keys()) {
    const origins = first.faceOrigin.get(fid) ?? [];
    if (origins.some((o) => o.runId === result.bodyRunId)) continue;
    const o = origins.find((x) => x.runId === result.toolRunId && plan.blendFaces.has(x.faceId));
    if (!o) continue;
    created.push(fid);
    const g = plan.blendFaces.get(o.faceId)!;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(fid);
  }
  for (const [g, faceIds] of groups) {
    if (!plan.smoothGroups.has(g) || faceIds.length < 2) continue;
    const members = new Set(faceIds);
    const sid = allocId<SurfaceId>(draft);
    updated.surfaces.set(sid, { id: sid, faceIds, curveId: null as CurveId | null });
    for (const fid of faceIds) {
      const f = updated.faces.get(fid);
      if (f) f.surfaceId = sid;
    }
    for (const e of updated.edges.values()) {
      if (members.has(e.faceA) && members.has(e.faceB)) {
        e.soft = true;
        e.smooth = true;
      }
    }
  }
  return { bodyId: updated.id, faceIds: created };
}

async function runEdgeBlend(kind: EdgeBlendKind, ctx: Parameters<typeof hostOf>[0], p: z.output<typeof EdgeBlendParamsSchema>): Promise<EdgeBlendApplyResult> {
  const host = hostOf(ctx);
  requireContextPath(host, p.path, 'Solid');
  const plan = planEdgeBlend(host.doc.state, kind, p);
  const result = p.precomputed ?? (await runEdgeBlendKernel(kernelOf(ctx), plan));
  checkEdgeBlendResult(plan, result);
  const label = kind === 'fillet' ? 'Fillet' : 'Chamfer';
  return host.transact(label, () => host.edit(label, (draft) => applyEdgeBlendResult(draft, plan, result)));
}

/** Fillet: round the given hard edges of a solid with `size` as radius (one undo step "Fillet"). */
export const filletApply = defineCommand({
  id: 'fillet.apply',
  title: 'Fillet',
  category: 'edit',
  params: EdgeBlendParamsSchema,
  undoable: false,
  run: (ctx, p): Promise<EdgeBlendApplyResult> => runEdgeBlend('fillet', ctx, p),
});

/** Chamfer: bevel the given hard edges of a solid, `size` back from the edge on both faces (one undo step "Chamfer"). */
export const chamferApply = defineCommand({
  id: 'chamfer.apply',
  title: 'Chamfer',
  category: 'edit',
  params: EdgeBlendParamsSchema,
  undoable: false,
  run: (ctx, p): Promise<EdgeBlendApplyResult> => runEdgeBlend('chamfer', ctx, p),
});

export const edgeBlendCommands: readonly AnyCommand[] = [filletApply, chamferApply];
