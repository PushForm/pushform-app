// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Push/pull pipeline ("Push/pull pipeline"):
 *  1. tool prism = extrude(region polygon, |d| + e + e') translated by -e, in a right-handed frame
 *     aligned with the push direction (mirrored basis for d < 0); its corners on F are F's own
 *     vertices, so faces the tool shares with B coincide exactly;
 *  2. label the tool faces: near cap, far cap, side_i for boundary edge i;
 *  3. out = newBody ? tool : a whole face whose neighbours are all square to it and that passes
 *     nothing of B moves along its normal (the neighbours stretch or shorten); otherwise
 *     d > 0 ? B ∪ tool : B − tool, with B and the tool uploaded around one shared centre;
 *  4. coplanar merge + identity rule while normalizing (a face keeps the id of the B face that gave
 *     it most of its area; the far cap takes F's id when the region was the whole face; everything
 *     else is new);
 *  5. rebuild, simplify, decompose, measure (a preview stops after normalizing, and a moved face
 *     needs not even that: only a commit needs the rest).
 */
import type { Manifold, Mat4, Mesh, SimplePolygon } from 'manifold-3d';
import { AREA_TOL, box3Center, box3FromPositions, box3Union, COPLANAR_TOL, MERGE_TOL, m4fromBasis, v3cross, v3dist, v3dot, v3neg, v3parallel, v3sub, type PlaneBasis, type Vec3 } from '@pushform/core';
import { pointInPolygon, pointOnRing } from '@pushform/geom';
import type { ExtrudeSketchRequest, PolygonsWithHoles, PushPullPreview, PushPullPreviewRequest, PushPullRequest, PushPullResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope, type Scope } from '../context';
import type { CacheEntry } from '../ManifoldCache';
import { manifoldFromSoup, tryManifoldFromSoup, type ReadMesh, type TriangleSoup } from '../meshio';
import { bodyTriangles, getBody } from './bodies';
import { finalizeManifold, previewMesh } from './finalize';
import type { ChooseFaceId, NormalizedFace } from './normalize';

/** Tool face labels. Side faces are `SIDE_BASE + boundary edge index`. */
export const TOOL_NEAR_CAP = 0;
export const TOOL_FAR_CAP = 1;
export const TOOL_SIDE_BASE = 2;

/**
 * Start-cap overlap that removes the coincident-face degeneracy of the boolean where the tool's
 * start cap cannot be made to coincide exactly with F.
 */
const OVERLAP = 4 * COPLANAR_TOL;

type Pt = [number, number];

interface ToolFrame {
  /** World transform of the tool's local frame (z = push direction). */
  matrix: Mat4;
  /** World origin and axes of the tool's local frame. */
  origin: Vec3;
  u: Vec3;
  v: Vec3;
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
  return { matrix: m4fromBasis(basis.origin, U, V, N) as Mat4, origin: basis.origin, u: U, v: V, contours, edges, dir: N };
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

/** How far a point of the extruded prism may lie from the region contour point it came from, for a region reaching `extent`. */
const contourTol = (extent: number): number => Math.max(1e-6 * extent, 1e-9);

/** Assign near-cap / far-cap / side_i labels to the triangles of an extruded prism in its local frame. */
function labelToolFaces(mg: Mesh, edges: Array<[Pt, Pt]>): Uint32Array {
  const P = mg.vertProperties, np = mg.numProp, T = mg.triVerts;
  let extent = 0;
  for (const [p, q] of edges) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(q[0]), Math.abs(q[1]));
  const tol = contourTol(extent);
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
 * Extrude the region into a labelled tool Manifold in its local frame, placed in world space: for
 * a tool that stands alone (a new body, a pulled sketch face), where nothing has to coincide with
 * it exactly. The prism spans local z ∈ [0, height].
 */
function buildStandaloneTool(ctx: KernelContext, scope: Scope, frame: ToolFrame, height: number, runId: number): Manifold {
  const { Manifold, CrossSection, Mesh } = ctx.wasm;
  const cs = scope.track(CrossSection.ofPolygons(frame.contours, 'Positive'));
  if (cs.isEmpty()) throw new KernelError('InvalidInput', 'pushPull region polygon has no area');
  const prism = scope.track(cs.extrude(height));
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

/** World point of the frame's local (x, y) on F's plane. */
function onFace(frame: ToolFrame, x: number, y: number): Vec3 {
  const { origin: o, u, v } = frame;
  return [o[0] + x * u[0] + y * v[0], o[1] + x * u[1] + y * v[1], o[2] + x * u[2] + y * v[2]];
}

/** The region's corners on F, each snapped to the vertex of F it stands on when there is one. */
interface ToolCorners {
  /** Exact local (x, y) of each contour point, and its world position on F. */
  points: Array<{ x: number; y: number; world: Vec3 }>;
  /** Every corner is one of F's own vertices. */
  allOnVertices: boolean;
}

function snapCorners(frame: ToolFrame, faceVerts: readonly Vec3[]): ToolCorners {
  let allOnVertices = faceVerts.length > 0;
  const points = frame.contours.flat().map(([x, y]) => {
    const p = onFace(frame, x, y);
    let best: Vec3 | undefined, bestD = MERGE_TOL;
    for (const q of faceVerts) {
      const d = v3dist(p, q);
      if (d <= bestD) {
        bestD = d;
        best = q;
      }
    }
    if (!best) allOnVertices = false;
    return { x, y, world: best ?? p };
  });
  return { points, allOnVertices };
}

/** The distinct vertex positions of face `faceId` in a body mesh. */
function faceVertices(mesh: ReadMesh, faceId: number): Vec3[] {
  const seen = new Set<number>();
  const out: Vec3[] = [];
  for (let t = 0; t < mesh.faceId.length; t++) {
    if (mesh.faceId[t] !== faceId) continue;
    for (let k = 0; k < 3; k++) {
      const i = mesh.tris[t * 3 + k]!;
      if (seen.has(i)) continue;
      seen.add(i);
      out.push([mesh.verts[i * 3]!, mesh.verts[i * 3 + 1]!, mesh.verts[i * 3 + 2]!]);
    }
  }
  return out;
}

/**
 * Extrude the region into a labelled tool prism, as a triangle soup in world space spanning local
 * z ∈ [-overlapNear, height + overlapFar]. Each corner is built from its exact position on F
 * (`corners`) moved along the push direction, so an edge the tool shares with the solid is the
 * solid's own edge rather than a rounded copy of it.
 */
function buildToolSoup(
  ctx: KernelContext,
  scope: Scope,
  frame: ToolFrame,
  corners: ToolCorners,
  height: number,
  overlapNear: number,
  overlapFar: number,
): TriangleSoup {
  const cs = scope.track(ctx.wasm.CrossSection.ofPolygons(frame.contours, 'Positive'));
  if (cs.isEmpty()) throw new KernelError('InvalidInput', 'pushPull region polygon has no area');
  const prism = scope.track(scope.track(cs.extrude(height + overlapNear + overlapFar)).translate(0, 0, -overlapNear));
  const mg = prism.getMesh();
  const faceId = labelToolFaces(mg, frame.edges);
  const P = mg.vertProperties, np = mg.numProp;
  let extent = 0;
  for (const c of corners.points) extent = Math.max(extent, Math.abs(c.x), Math.abs(c.y));
  const tol = contourTol(extent);
  const mid = (height + overlapFar - overlapNear) / 2;
  const near = overlapNear > 0 ? -overlapNear : 0;
  const d = frame.dir;
  const verts = new Float64Array(mg.numVert * 3);
  for (let i = 0; i < mg.numVert; i++) {
    const x = P[i * np]!, y = P[i * np + 1]!;
    let base: Vec3 | undefined, bestD = tol;
    for (const c of corners.points) {
      const dd = Math.hypot(c.x - x, c.y - y);
      if (dd <= bestD) {
        bestD = dd;
        base = c.world;
      }
    }
    base ??= onFace(frame, x, y);
    const z = P[i * np + 2]! > mid ? height + overlapFar : near;
    verts[i * 3] = base[0] + z * d[0];
    verts[i * 3 + 1] = base[1] + z * d[1];
    verts[i * 3 + 2] = base[2] + z * d[2];
  }
  // weld: every edge shared by index, as Manifold requires of an input mesh
  const remap = new Uint32Array(mg.numVert);
  for (let i = 0; i < remap.length; i++) remap[i] = i;
  if (mg.mergeFromVert !== undefined && mg.mergeToVert !== undefined) {
    for (let i = 0; i < mg.mergeFromVert.length; i++) remap[mg.mergeFromVert[i]!] = mg.mergeToVert[i]!;
  }
  const tris = new Uint32Array(mg.triVerts.length);
  for (let i = 0; i < tris.length; i++) tris[i] = remap[mg.triVerts[i]!]!;
  return { verts, tris, faceId };
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

interface Stretch {
  /** Every face around F is square to it, so a tool's sides would lie on them. */
  square: boolean;
  /** Vertex positions of the solid with F moved, or null when moving F would not give the boolean's result. */
  verts: Float64Array | null;
}

/**
 * A whole face pushed or pulled with every face around it square to it is moved rather than cut:
 * its vertices move along its normal and the faces around it stretch or shorten with it. Every
 * face and edge stays as it was, and no tool face has to coincide with the solid's faces, which a
 * boolean would round apart. Moving is not used, and `verts` is null, when a face around F is
 * not square to it (within what keeps that face flat), when a face around F would fold over or
 * vanish, or when F would pass any other part of the solid.
 */
function stretchFace(ctx: KernelContext, scope: Scope, body: CacheEntry, mesh: ReadMesh, req: PushPullRequest | PushPullPreviewRequest, frame: ToolFrame, height: number): Stretch {
  const none: Stretch = { square: false, verts: null };
  if (req.mode !== 'merge' || !req.region.regionIsWholeFace) return none;
  const F = req.region.faceId, n = req.region.basis.n, d = req.distance;
  const { verts, tris, faceId } = mesh;
  const numTri = faceId.length;
  const moves = new Uint8Array(verts.length / 3);
  let any = false;
  for (let t = 0; t < numTri; t++) {
    if (faceId[t] !== F) continue;
    for (let k = 0; k < 3; k++) moves[tris[t * 3 + k]!] = 1;
    any = true;
  }
  if (!any) return none;
  const at = (i: number, move: boolean): Vec3 => {
    const s = move && moves[i] ? d : 0;
    return [verts[i * 3]! + s * n[0], verts[i * 3 + 1]! + s * n[1], verts[i * 3 + 2]! + s * n[2]];
  };
  const normal = (a: number, b: number, c: number, move: boolean): Vec3 => {
    const p = at(a, move);
    return v3cross(v3sub(at(b, move), p), v3sub(at(c, move), p));
  };
  // Faces around F, with their area-weighted normals; none of their triangles may fold over or vanish.
  const around = new Map<number, Vec3>();
  let folds = false;
  for (let t = 0; t < numTri; t++) {
    const id = faceId[t]!;
    if (id === F) continue;
    const [a, b, c] = [tris[t * 3]!, tris[t * 3 + 1]!, tris[t * 3 + 2]!];
    if (!moves[a] && !moves[b] && !moves[c]) continue;
    const before = normal(a, b, c, false), after = normal(a, b, c, true);
    if (v3dot(before, after) <= 0 || Math.hypot(...after) <= 2 * AREA_TOL) folds = true;
    const sum = around.get(id) ?? [0, 0, 0];
    around.set(id, [sum[0] + before[0], sum[1] + before[1], sum[2] + before[2]]);
  }
  // Square: moving F keeps each face around it flat within the coplanarity tolerance.
  for (const sum of around.values()) {
    const len = Math.hypot(...sum);
    if (len === 0 || Math.abs(d) * Math.abs(v3dot(sum, n)) / len > COPLANAR_TOL / 2) return none;
  }
  if (folds) return { square: true, verts: null };
  // No other vertex of the solid where F passes.
  const { origin: o, u, v, dir } = frame;
  for (let i = 0; i < moves.length; i++) {
    if (moves[i]) continue;
    const w: Vec3 = [verts[i * 3]! - o[0], verts[i * 3 + 1]! - o[1], verts[i * 3 + 2]! - o[2]];
    const z = v3dot(w, dir);
    if (z < -MERGE_TOL || z > height + MERGE_TOL) continue;
    const xy: [number, number] = [v3dot(w, u), v3dot(w, v)];
    if (pointInPolygon(xy, frame.contours) || frame.contours.some((ring) => pointOnRing(xy, ring, MERGE_TOL))) return { square: true, verts: null };
  }
  // No other face of the solid across where F passes: a slightly smaller prism there holds none of
  // the solid (pulling out) or only solid (pushing in).
  if (height > 2 * OVERLAP) {
    const cs = scope.track(scope.track(ctx.wasm.CrossSection.ofPolygons(frame.contours, 'Positive')).offset(-OVERLAP, 'Miter'));
    if (!cs.isEmpty()) {
      const probe = scope.track(scope.track(scope.track(cs.extrude(height - 2 * OVERLAP)).translate(0, 0, OVERLAP)).transform(frame.matrix));
      const clash = scope.track(d > 0 ? body.manifold.intersect(probe) : probe.subtract(body.manifold));
      if (clash.volume() > COPLANAR_TOL * probe.surfaceArea()) return { square: true, verts: null };
    }
  }
  const moved = new Float64Array(verts);
  for (let i = 0; i < moves.length; i++) {
    if (!moves[i]) continue;
    for (let k = 0; k < 3; k++) moved[i * 3 + k] = verts[i * 3 + k]! + d * n[k]!;
  }
  return { square: true, verts: moved };
}

/**
 * B ∪ tool (pulling out) or B − tool (pushing in). B and the tool are uploaded around one shared
 * centre, so the corners they share round the same way in both Manifolds and the faces they share
 * coincide exactly. Pulling a whole face whose corners are all its own vertices and whose
 * neighbours are square to it (`square`), the tool starts exactly on the face: its sides then meet
 * the solid's sides only along their shared edges and leave no vertices behind on them. Otherwise
 * it starts inside the solid by OVERLAP.
 */
function cut(
  ctx: KernelContext,
  scope: Scope,
  body: CacheEntry,
  mesh: ReadMesh,
  req: PushPullRequest | PushPullPreviewRequest,
  frame: ToolFrame,
  corners: ToolCorners,
  height: number,
  square: boolean,
  toolRunId: number,
): Manifold {
  const n = req.region.basis.n;
  const farOffset = v3dot(n, req.region.basis.origin) + req.distance;
  const overlapFar = reachesOpposingFace(mesh, n, farOffset) ? OVERLAP : 0;
  const overlapNear = req.distance > 0 && req.region.regionIsWholeFace && square && corners.allOnVertices ? 0 : OVERLAP;
  const soup = buildToolSoup(ctx, scope, frame, corners, height, overlapNear, overlapFar);
  const center = box3Center(box3Union(box3FromPositions(mesh.verts), box3FromPositions(soup.verts)));
  const solid = scope.track(manifoldFromSoup(ctx.wasm, mesh, body.runId, center));
  const tool = scope.track(manifoldFromSoup(ctx.wasm, soup, toolRunId, center));
  return scope.track(req.distance > 0 ? solid.add(tool) : solid.subtract(tool));
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
    // Origins come largest first: the body face that gave this face most of its area keeps its id,
    // so a sliver of a neighbouring face never takes the id of the face it lies on.
    const fromBody = origins.find((o) => o.runId === plan.bodyRunId);
    if (fromBody !== undefined) return fromBody.faceId;
    if (plan.farCapId !== undefined && origins.some((o) => o.runId === plan.toolRunId && o.faceId === TOOL_FAR_CAP)) {
      return plan.farCapId;
    }
    return undefined;
  };
}


/**
 * Push/pull a region of a cached body's face; `mode: 'newBody'` extrudes a standalone solid instead.
 * With `preview` set, stops once the result can be drawn. A moved face is the solid's own triangles
 * at new positions, so it is drawn without building a solid; every check on whether F can move still
 * runs first. The triangles are copied because the worker transfers a result's buffers away.
 */
export function pushPull(ctx: KernelContext, req: PushPullRequest | PushPullPreviewRequest): PushPullResult | PushPullPreview {
  if (!Number.isFinite(req.distance) || Math.abs(req.distance) <= COPLANAR_TOL) {
    throw new KernelError('InvalidInput', 'pushPull.distance must be a non-zero finite number');
  }
  const body = getBody(ctx, req.body);
  const mesh = bodyTriangles(body);
  const frame = toolFrame(req.region.basis, req.region.polygon, req.distance);
  const corners = snapCorners(frame, faceVertices(mesh, req.region.faceId));
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
    let out: Manifold;
    let moved = false;
    if (req.mode === 'newBody') {
      out = buildStandaloneTool(ctx, scope, frame, height, toolRunId);
    } else {
      const stretch = stretchFace(ctx, scope, body, mesh, req, frame, height);
      if (req.preview && stretch.verts) {
        return { preview: true, mesh: { verts: stretch.verts, tris: mesh.tris.slice(), faceId: mesh.faceId.slice(), runId: 0 } };
      }
      const solid = stretch.verts ? tryManifoldFromSoup(ctx.wasm, { verts: stretch.verts, tris: mesh.tris, faceId: mesh.faceId }, body.runId).manifold : undefined;
      moved = solid !== undefined;
      out = solid ? scope.track(solid) : cut(ctx, scope, body, mesh, req, frame, corners, height, stretch.square, toolRunId);
    }
    if (req.preview) return { preview: true, mesh: previewMesh(out) };
    const fin = finalizeManifold(ctx, out, { nextFaceId: req.nextFaceId, chooseId: chooseIdFor(plan) });
    return {
      components: fin.components,
      sideFaceForBoundaryEdge: sideFaceMap(fin.faces, toolRunId),
      nextFaceId: fin.nextFaceId,
      bodyRunId: body.runId,
      toolRunId,
      ...(moved ? { moved: true } : {}),
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
    const tool = buildStandaloneTool(ctx, scope, frame, plan.height, toolRunId);
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
