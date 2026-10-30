// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Push/pull pipeline ("Push/pull pipeline"):
 *  1. tool prism = extrude(region polygon, |d| + e + e') translated by -e, in a right-handed frame
 *     aligned with the push direction (mirrored basis for d < 0);
 *  2. label the tool faces: near cap, far cap, side_i for boundary edge i;
 *  3. out = newBody ? tool : d > 0 ? B ∪ tool : B − tool;
 *  4. coplanar merge + identity rule while normalizing (prefer the oldest B face id; the far cap takes
 *     F's id when the region was the whole face; everything else is new);
 *  5. rebuild, simplify, decompose, measure.
 */
import type { Manifold, Mat4, Mesh, SimplePolygon } from 'manifold-3d';
import { COPLANAR_TOL, MERGE_TOL, m4fromBasis, v3dot, v3neg, v3parallel, type PlaneBasis, type Vec3 } from '@pushform/core';
import type { ExtrudeSketchRequest, PolygonsWithHoles, PushPullRequest, PushPullResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope, type Scope } from '../context';
import type { ReadMesh } from '../meshio';
import { bodyTriangles, getBody } from './bodies';
import { finalizeManifold } from './finalize';
import type { ChooseFaceId, NormalizedFace } from './normalize';

/** Tool face labels. Side faces are `SIDE_BASE + boundary edge index`. */
export const TOOL_NEAR_CAP = 0;
export const TOOL_FAR_CAP = 1;
export const TOOL_SIDE_BASE = 2;

/** Start-cap overlap that removes the coincident-face degeneracy of the boolean. */
const OVERLAP = 4 * COPLANAR_TOL;

type Pt = [number, number];

interface ToolFrame {
  /** World transform of the tool's local frame (z = push direction). */
  matrix: Mat4;
  /** Region contours in the local frame (oriented: outer CCW, holes CW). */
  contours: SimplePolygon[];
  /** Region boundary edges (input order, flattened over contours) in the local frame. */
  edges: Array<[Pt, Pt]>;
  /** Unit extrusion direction in world space. */
  dir: Vec3;
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Build the local frame for the tool. For d < 0 the basis is mirrored (u and v swapped, normal
 * negated) so the transform stays right-handed and the polygon coordinates are swapped to match.
 */
function toolFrame(basis: PlaneBasis, polygon: PolygonsWithHoles, distance: number): ToolFrame {
  const pull = distance > 0;
  const U = pull ? basis.u : basis.v;
  const V = pull ? basis.v : basis.u;
  const N = pull ? basis.n : v3neg(basis.n);
  const local = polygon.map((contour) =>
    contour.map((p): Pt => (pull ? [p[0] ?? 0, p[1] ?? 0] : [p[1] ?? 0, p[0] ?? 0])),
  );
  const edges: Array<[Pt, Pt]> = [];
  for (const contour of local) {
    for (let i = 0; i < contour.length; i++) edges.push([contour[i]!, contour[(i + 1) % contour.length]!]);
  }
  const contours = local
    .filter((c) => c.length >= 3)
    .map((c, i) => {
      const wantCCW = i === 0;
      return (signedArea(c) > 0) === wantCCW ? c : [...c].reverse();
    });
  return { matrix: m4fromBasis(basis.origin, U, V, N) as Mat4, contours, edges, dir: N };
}

/** Overlap length between the segment (a,b) and edge (p,q) when they are collinear, else 0. */
function collinearOverlap(a: Pt, b: Pt, [p, q]: [Pt, Pt], tol: number): number {
  const ex = q[0] - p[0], ey = q[1] - p[1];
  const len = Math.hypot(ex, ey);
  if (len === 0) return 0;
  const ux = ex / len, uy = ey / len;
  const dist = (r: Pt): number => Math.abs((r[0] - p[0]) * uy - (r[1] - p[1]) * ux);
  if (dist(a) > tol || dist(b) > tol) return 0;
  const ta = (a[0] - p[0]) * ux + (a[1] - p[1]) * uy;
  const tb = (b[0] - p[0]) * ux + (b[1] - p[1]) * uy;
  return Math.min(Math.max(ta, tb), len) - Math.max(Math.min(ta, tb), 0);
}

/** Assign near-cap / far-cap / side_i labels to the triangles of an extruded prism in its local frame. */
function labelToolFaces(mg: Mesh, edges: Array<[Pt, Pt]>): Uint32Array {
  const P = mg.vertProperties, np = mg.numProp, T = mg.triVerts;
  let extent = 0;
  for (const [p, q] of edges) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(q[0]), Math.abs(q[1]));
  const tol = Math.max(1e-6 * extent, 1e-9);
  const faceID = new Uint32Array(mg.numTri);
  for (let t = 0; t < mg.numTri; t++) {
    const v = [T[t * 3]! * np, T[t * 3 + 1]! * np, T[t * 3 + 2]! * np];
    const z = v.map((i) => P[i + 2]!);
    const e1 = [P[v[1]!]! - P[v[0]!]!, P[v[1]! + 1]! - P[v[0]! + 1]!, z[1]! - z[0]!];
    const e2 = [P[v[2]!]! - P[v[0]!]!, P[v[2]! + 1]! - P[v[0]! + 1]!, z[2]! - z[0]!];
    const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    if (Math.abs(nz) > Math.hypot(nx, ny)) {
      faceID[t] = nz > 0 ? TOOL_FAR_CAP : TOOL_NEAR_CAP;
      continue;
    }
    // Side: the two corners at the same height span the base edge.
    const k = Math.abs(z[0]! - z[1]!) <= Math.abs(z[1]! - z[2]!) && Math.abs(z[0]! - z[1]!) <= Math.abs(z[0]! - z[2]!) ? [0, 1] : Math.abs(z[1]! - z[2]!) <= Math.abs(z[0]! - z[2]!) ? [1, 2] : [0, 2];
    const a: Pt = [P[v[k[0]!]!]!, P[v[k[0]!]! + 1]!];
    const b: Pt = [P[v[k[1]!]!]!, P[v[k[1]!]! + 1]!];
    let best = -1, bestOverlap = 0;
    edges.forEach((edge, i) => {
      const o = collinearOverlap(a, b, edge, tol);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = i;
      }
    });
    faceID[t] = TOOL_SIDE_BASE + (best >= 0 ? best : edges.length);
  }
  return faceID;
}

/**
 * Extrude the region into a labelled tool Manifold in world space.
 * The prism spans local z ∈ [-overlapNear, |d| + overlapFar].
 */
function buildTool(
  ctx: KernelContext,
  scope: Scope,
  frame: ToolFrame,
  height: number,
  overlapNear: number,
  overlapFar: number,
  runId: number,
): Manifold {
  const { Manifold, CrossSection, Mesh } = ctx.wasm;
  const cs = scope.track(CrossSection.ofPolygons(frame.contours, 'Positive'));
  if (cs.isEmpty()) throw new KernelError('InvalidInput', 'pushPull region polygon has no area');
  const prism = scope.track(scope.track(cs.extrude(height + overlapNear + overlapFar)).translate(0, 0, -overlapNear));
  const mg = prism.getMesh();
  const labelled = new Mesh({
    numProp: 3,
    vertProperties: mg.vertProperties,
    triVerts: mg.triVerts,
    faceID: labelToolFaces(mg, frame.edges),
    runIndex: new Uint32Array([0, mg.triVerts.length]),
    runOriginalID: new Uint32Array([runId]),
    ...(mg.mergeFromVert !== undefined && mg.mergeToVert !== undefined
      ? { mergeFromVert: mg.mergeFromVert, mergeToVert: mg.mergeToVert }
      : {}),
  });
  const local = scope.track(new Manifold(labelled));
  return scope.track(local.transform(frame.matrix));
}

/**
 * True when a body face anti-parallel to F lies within MERGE_TOL of the far-end plane, i.e. the tool
 * exits (push) or enters (pull) the solid through it; the tool is then extended by `OVERLAP` so the
 * boolean does not leave a coincident skin.
 */
function reachesOpposingFace(body: ReadMesh, n: Vec3, farOffset: number): boolean {
  const { verts, tris } = body;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]! * 3, b = tris[t + 1]! * 3, c = tris[t + 2]! * 3;
    const e1: Vec3 = [verts[b]! - verts[a]!, verts[b + 1]! - verts[a + 1]!, verts[b + 2]! - verts[a + 2]!];
    const e2: Vec3 = [verts[c]! - verts[a]!, verts[c + 1]! - verts[a + 1]!, verts[c + 2]! - verts[a + 2]!];
    const fn: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (v3dot(fn, n) >= 0 || !v3parallel(fn, n, 1e-6)) continue;
    const offset = n[0] * verts[a]! + n[1] * verts[a + 1]! + n[2] * verts[a + 2]!;
    if (Math.abs(offset - farOffset) <= MERGE_TOL) return true;
  }
  return false;
}

/** Side faces keyed by their final id -> region boundary edge index. */
function sideFaceMap(faces: NormalizedFace[], toolRunId: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const face of faces) {
    const side = face.origins.find((o) => o.runId === toolRunId && o.faceId >= TOOL_SIDE_BASE);
    if (side !== undefined) out[face.id] = side.faceId - TOOL_SIDE_BASE;
  }
  return out;
}

interface PushPullPlan {
  frame: ToolFrame;
  height: number;
  bodyRunId: number;
  toolRunId: number;
  /** Face id the far cap inherits, if any. */
  farCapId: number | undefined;
}

function chooseIdFor(plan: PushPullPlan): ChooseFaceId {
  return (origins) => {
    const fromBody = origins.filter((o) => o.runId === plan.bodyRunId);
    if (fromBody.length > 0) return fromBody.reduce((m, o) => Math.min(m, o.faceId), fromBody[0]!.faceId);
    if (plan.farCapId !== undefined && origins.some((o) => o.runId === plan.toolRunId && o.faceId === TOOL_FAR_CAP)) {
      return plan.farCapId;
    }
    return undefined;
  };
}


/** Push/pull a region of a cached body's face; `mode: 'newBody'` extrudes a standalone solid instead. */
export function pushPull(ctx: KernelContext, req: PushPullRequest): PushPullResult {
  if (!Number.isFinite(req.distance) || Math.abs(req.distance) <= COPLANAR_TOL) {
    throw new KernelError('InvalidInput', 'pushPull.distance must be a non-zero finite number');
  }
  const body = getBody(ctx, req.body);
  const frame = toolFrame(req.region.basis, req.region.polygon, req.distance);
  const height = Math.abs(req.distance);
  const toolRunId = ctx.wasm.Manifold.reserveIDs(1);
  const plan: PushPullPlan = {
    frame,
    height,
    bodyRunId: body.runId,
    toolRunId,
    farCapId: req.region.regionIsWholeFace ? req.region.faceId : undefined,
  };
  return withScope((scope) => {
    let tool: Manifold;
    let out: Manifold;
    if (req.mode === 'newBody') {
      tool = buildTool(ctx, scope, frame, height, 0, 0, toolRunId);
      out = tool;
    } else {
      const n = req.region.basis.n;
      const farOffset = v3dot(n, req.region.basis.origin) + req.distance;
      const overlapFar = reachesOpposingFace(bodyTriangles(body), n, farOffset) ? OVERLAP : 0;
      tool = buildTool(ctx, scope, frame, height, OVERLAP, overlapFar, toolRunId);
      out = scope.track(req.distance > 0 ? body.manifold.add(tool) : body.manifold.subtract(tool));
    }
    const fin = finalizeManifold(ctx, out, { nextFaceId: req.nextFaceId, chooseId: chooseIdFor(plan) });
    return {
      components: fin.components,
      sideFaceForBoundaryEdge: sideFaceMap(fin.faces, toolRunId),
      nextFaceId: fin.nextFaceId,
      bodyRunId: body.runId,
      toolRunId,
    };
  });
}

/** Extrude a sketch face (sheet polygon) into a new solid: the `newBody` path without a source body. */
export function extrudeSketch(ctx: KernelContext, req: ExtrudeSketchRequest): PushPullResult {
  if (!Number.isFinite(req.distance) || Math.abs(req.distance) <= COPLANAR_TOL) {
    throw new KernelError('InvalidInput', 'extrudeSketch.distance must be a non-zero finite number');
  }
  const frame = toolFrame(req.basis, req.polygon, req.distance);
  const toolRunId = ctx.wasm.Manifold.reserveIDs(1);
  const plan: PushPullPlan = { frame, height: Math.abs(req.distance), bodyRunId: 0, toolRunId, farCapId: undefined };
  return withScope((scope) => {
    const tool = buildTool(ctx, scope, frame, plan.height, 0, 0, toolRunId);
    const fin = finalizeManifold(ctx, tool, { nextFaceId: req.nextFaceId, chooseId: chooseIdFor(plan) });
    return {
      components: fin.components,
      sideFaceForBoundaryEdge: sideFaceMap(fin.faces, toolRunId),
      nextFaceId: fin.nextFaceId,
      bodyRunId: 0,
      toolRunId,
    };
  });
}
