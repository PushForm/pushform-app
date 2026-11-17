// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, Id, MaterialId, MeshData, Plane, TagId, Vec3 } from '@pushform/core';
import {
  basisToLocal,
  LENGTH_TOL,
  MERGE_TOL,
  meshSignedVolume,
  planeBasis,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3sub,
} from '@pushform/core';
import { facePlanesFromMesh, groupCoplanarFaces, signedArea, weldVertices } from '@pushform/geom';
import { makeEdgeKey, type Body, type BodyProps, type EdgeKey, type EdgeRecord, type FaceRecord } from '../entities/body';
import { UV_AUTO } from '../entities/attrs';
import type { EntityContainer } from '../entities/definition';
import { allocId, registerFreshRecordTable, sealGeometry, type DocumentDraft, type Draft } from '../Document';

export interface BodyFromMeshOptions {
  tagId?: TagId;
  materialId?: MaterialId | null;
  /** Insert the body into this (draft) container and its `order`. */
  container?: Draft<EntityContainer>;
  /** Recompute `faceId` by coplanar grouping instead of trusting the mesh's array. Default false. */
  regroupFaces?: boolean;
  weldTol?: number;
}

/** Create a Body from a mesh: face records from faceId groups, derived edges, cached props. */
export function bodyFromMesh(draft: DocumentDraft, mesh: MeshData, opts: BodyFromMeshOptions = {}): Body {
  const tagId = opts.tagId ?? draft.defaultTagId;
  const m: MeshData = opts.regroupFaces
    ? { verts: mesh.verts, tris: mesh.tris, faceId: groupCoplanarFaces(mesh, { weldTol: opts.weldTol ?? LENGTH_TOL }).faceId }
    : mesh;
  const { faces, nextFaceId } = buildFaceRecords(m, tagId, opts.weldTol);
  const edges = deriveEdges(m, tagId, opts.weldTol);
  registerFreshRecordTable(faces);
  registerFreshRecordTable(edges);
  const id = allocId<Id>(draft);
  const body: Body = {
    id,
    version: 0,
    mesh: m,
    faces,
    nextFaceId,
    edges,
    imprints: new Map(),
    curves: new Map(),
    surfaces: new Map(),
    materialId: opts.materialId ?? null,
    props: computeBodyProps(m),
    valid: true,
    tagId,
    hidden: false,
    locked: false,
    castShadows: true,
    receiveShadows: true,
    attributes: {},
  };
  if (opts.container) {
    // cast: Body vs WritableDraft<Body> only differ in tuple mutability
    (opts.container.bodies as unknown as Map<Id, Body>).set(id, body);
    opts.container.order.push(id);
  }
  return body;
}

export function computeBodyProps(mesh: MeshData): BodyProps {
  let area = 0;
  const p = mesh.verts, t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
    const e1: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    area += v3len(v3cross(e1, e2)) / 2;
  }
  return { volume: meshSignedVolume(mesh), area };
}

// ---------------------------------------------------------------------------------------------
// Mesh boundary analysis

/** A directed triangle edge on the boundary of a faceId group, with the face across it. */
interface BoundaryEdge {
  u: number;
  v: number;
  face: number;
  /** Face across the edge, or -1 for an open (non-manifold) edge. */
  other: number;
}

/**
 * Face of the triangle that last used each directed vertex pair: an open-addressing table, because this is the
 * hottest lookup of a body rebuild.
 */
class DirectedEdgeFaces {
  private readonly us: Int32Array;
  private readonly vs: Int32Array;
  private readonly faces: Float64Array;
  private readonly mask: number;
  constructor(entries: number) {
    let capacity = 16;
    while (capacity < entries * 2) capacity *= 2;
    this.us = new Int32Array(capacity).fill(-1);
    this.vs = new Int32Array(capacity);
    this.faces = new Float64Array(capacity);
    this.mask = capacity - 1;
  }
  private slot(u: number, v: number): number {
    let i = Math.imul(u, 0x9e3779b1) ^ Math.imul(v, 0x85ebca6b);
    i = (i ^ (i >>> 15)) & this.mask;
    while (this.us[i] !== -1 && (this.us[i] !== u || this.vs[i] !== v)) i = (i + 1) & this.mask;
    return i;
  }
  set(u: number, v: number, face: number): void {
    const i = this.slot(u, v);
    this.us[i] = u;
    this.vs[i] = v;
    this.faces[i] = face;
  }
  /** The face stored for (u, v), or -1 when none is. */
  get(u: number, v: number): number {
    const i = this.slot(u, v);
    return this.us[i] === -1 ? -1 : this.faces[i]!;
  }
}

/**
 * Directed triangle edges where the face changes, on welded vertices. A triangle with two corners welded together
 * has no area and is skipped: its two remaining edges would cancel the neighbouring triangle's edge between them,
 * losing that edge from its face's loop (a kernel sliver beside a fillet does this).
 */
function boundaryEdges(mesh: MeshData, weldTol = LENGTH_TOL): { canon: Int32Array; edges: BoundaryEdge[] } {
  const canon = weldVertices(mesh.verts, weldTol);
  const t = mesh.tris;
  const triCount = t.length / 3;
  const directed = new DirectedEdgeFaces(triCount * 3);
  const collapsed = (i: number): boolean => {
    const a = canon[t[i * 3]!]!, b = canon[t[i * 3 + 1]!]!, c = canon[t[i * 3 + 2]!]!;
    return a === b || b === c || a === c;
  };
  for (let i = 0; i < triCount; i++) {
    if (collapsed(i)) continue;
    const f = mesh.faceId[i]!;
    for (let k = 0; k < 3; k++) {
      const u = canon[t[i * 3 + k]!]!, v = canon[t[i * 3 + ((k + 1) % 3)]!]!;
      if (u !== v) directed.set(u, v, f);
    }
  }
  const edges: BoundaryEdge[] = [];
  for (let i = 0; i < triCount; i++) {
    if (collapsed(i)) continue;
    const f = mesh.faceId[i]!;
    for (let k = 0; k < 3; k++) {
      const u = canon[t[i * 3 + k]!]!, v = canon[t[i * 3 + ((k + 1) % 3)]!]!;
      if (u === v) continue;
      const g = directed.get(v, u);
      if (g === -1) edges.push({ u, v, face: f, other: -1 });
      else if (g !== f) edges.push({ u, v, face: f, other: g });
    }
  }
  return { canon, edges };
}

const vert = (mesh: MeshData, i: number): Vec3 => [mesh.verts[i * 3]!, mesh.verts[i * 3 + 1]!, mesh.verts[i * 3 + 2]!];

/** The boundary edges between two faces (`a` < `b`), oriented for face `a`, with the records built from them. */
interface FacePairEdges {
  a: number;
  b: number;
  list: BoundaryEdge[];
  /** Pristine records; set once the pair has been built, and never mutated. */
  records: EdgeRecord[] | null;
}

/**
 * Everything a rebuild derives from a mesh before building records. It is pure in its inputs: `(mesh, tagId, weldTol)`
 * with their exact values determine every record, which is what makes reusing records from an analysis safe.
 */
export interface MeshAnalysis {
  mesh: MeshData;
  tagId: TagId;
  weldTol: number;
  /** Boundary edges of each face, in mesh triangle order. */
  byFace: Map<number, BoundaryEdge[]>;
  /** Triangle indices of each face, in mesh order. */
  trisOf: Map<number, number[]>;
  /** Face pairs in first-seen order, as deriving edges visits them. */
  pairs: FacePairEdges[];
  pairIndex: Map<number, Map<number, FacePairEdges>>;
  /** Pristine face records of this mesh; set when the faces are built, and never mutated. */
  faces: Map<FaceLocalId, FaceRecord>;
}

function analyzeMesh(mesh: MeshData, tagId: TagId, weldTol: number): MeshAnalysis {
  const { edges } = boundaryEdges(mesh, weldTol);
  const byFace = new Map<number, BoundaryEdge[]>();
  const trisOf = new Map<number, number[]>();
  const pairs: FacePairEdges[] = [];
  const pairIndex = new Map<number, Map<number, FacePairEdges>>();
  for (let i = 0; i < mesh.faceId.length; i++) {
    const f = mesh.faceId[i]!;
    const list = trisOf.get(f);
    if (list) list.push(i);
    else trisOf.set(f, [i]);
  }
  for (const e of edges) {
    const list = byFace.get(e.face);
    if (list) list.push(e);
    else byFace.set(e.face, [e]);
    if (e.other < 0 || e.face > e.other) continue; // keep the orientation of the lower face id
    let forA = pairIndex.get(e.face);
    if (!forA) pairIndex.set(e.face, (forA = new Map()));
    let pair = forA.get(e.other);
    if (!pair) {
      pair = { a: e.face, b: e.other, list: [], records: null };
      forA.set(e.other, pair);
      pairs.push(pair);
    }
    pair.list.push(e);
  }
  return { mesh, tagId, weldTol, byFace, trisOf, pairs, pairIndex, faces: new Map() };
}

/** Exact equality: distinguishes 0 from -0, and NaN is never equal, which only costs a rebuild of that record. */
function sameNumber(a: number, b: number): boolean {
  return a === b && (a !== 0 || 1 / a === 1 / b);
}

function sameVertex(a: Float64Array, i: number, b: Float64Array, j: number): boolean {
  return sameNumber(a[i * 3]!, b[j * 3]!) && sameNumber(a[i * 3 + 1]!, b[j * 3 + 1]!) && sameNumber(a[i * 3 + 2]!, b[j * 3 + 2]!);
}

/**
 * True when a face's record can be taken from `prior`: its triangles (in order, with exact corner positions) and its
 * boundary edges (in order, with exact welded endpoints and the same face across) are identical. A face record is a
 * pure function of exactly those: the plane sums over the face's corners in triangle order, and the loops follow the
 * boundary edges. Comparing welded endpoints by position also compares their identity, because welding gives two
 * vertices one id exactly when they round to the same grid cell, so equal positions always share an id.
 */
function sameFaceInput(prior: MeshAnalysis, cur: MeshAnalysis, fid: number): boolean {
  const before = prior.trisOf.get(fid), now = cur.trisOf.get(fid);
  if (!before || !now || before.length !== now.length) return false;
  const pm = prior.mesh, cm = cur.mesh;
  for (let i = 0; i < now.length; i++) {
    for (let k = 0; k < 3; k++) {
      if (!sameVertex(pm.verts, pm.tris[before[i]! * 3 + k]!, cm.verts, cm.tris[now[i]! * 3 + k]!)) return false;
    }
  }
  const be = prior.byFace.get(fid) ?? NO_EDGES, ne = cur.byFace.get(fid) ?? NO_EDGES;
  if (be.length !== ne.length) return false;
  for (let i = 0; i < ne.length; i++) {
    const p = be[i]!, q = ne[i]!;
    if (p.other !== q.other || !sameVertex(pm.verts, p.u, cm.verts, q.u) || !sameVertex(pm.verts, p.v, cm.verts, q.v)) return false;
  }
  return true;
}
const NO_EDGES: BoundaryEdge[] = [];

/** True when a face pair's runs can be taken from `prior`: same directed edges, in order, with exact welded endpoints. */
function samePairInput(before: FacePairEdges, pm: MeshData, now: FacePairEdges, cm: MeshData): boolean {
  if (before.list.length !== now.list.length) return false;
  for (let i = 0; i < now.list.length; i++) {
    const p = before.list[i]!, q = now.list[i]!;
    if (!sameVertex(pm.verts, p.u, cm.verts, q.u) || !sameVertex(pm.verts, p.v, cm.verts, q.v)) return false;
  }
  return true;
}

function collinear(a: Vec3, b: Vec3, c: Vec3, tol: number): boolean {
  const ab = v3sub(b, a), bc = v3sub(c, b);
  const l1 = v3len(ab), l2 = v3len(bc);
  if (l1 === 0 || l2 === 0) return true;
  return v3len(v3cross(ab, bc)) / (l1 * l2) <= tol && v3dot(ab, bc) > 0;
}

/**
 * Face records for every faceId group: plane (area-weighted), basis (plane-anchored at the
 * point nearest the world origin, via `planeBasis`), loops chained from the boundary edges with
 * collinear vertices dropped where the neighbouring face does not change.
 */
export function buildFaceRecords(
  mesh: MeshData,
  tagId: TagId,
  weldTol = LENGTH_TOL,
): { faces: Map<FaceLocalId, FaceRecord>; nextFaceId: number } {
  return buildFaces(analyzeMesh(mesh, tagId, weldTol), null);
}

/** One face record from its plane and boundary edges. */
function buildFace(a: MeshAnalysis, fid: FaceLocalId, plane: Plane): FaceRecord {
  const basis = planeBasis(planeOrigin(plane), plane.n);
  const loops = chainLoops(a.mesh, a.byFace.get(fid) ?? [], basis);
  return {
    id: fid,
    plane: sealGeometry(plane),
    basis: sealGeometry(basis),
    loops: sealGeometry(loops),
    frontMaterialId: null,
    backMaterialId: null,
    uv: UV_AUTO,
    tagId: a.tagId,
    hidden: false,
    surfaceId: null,
  };
}

/** Faces of an analysis, reusing `prior`'s record for every face whose input is identical. */
function buildFaces(a: MeshAnalysis, prior: MeshAnalysis | null): { faces: Map<FaceLocalId, FaceRecord>; nextFaceId: number } {
  const planes = facePlanesFromMesh(a.mesh);
  const faces = new Map<FaceLocalId, FaceRecord>();
  let maxId = -1;
  for (const [fid, plane] of planes) {
    maxId = Math.max(maxId, fid);
    const id = fid as FaceLocalId;
    const reused = prior && sameFaceInput(prior, a, fid) ? prior.faces.get(id) : undefined;
    faces.set(id, reused ?? buildFace(a, id, plane));
  }
  a.faces = faces;
  return { faces, nextFaceId: maxId + 1 };
}

/** Face and edge records of a mesh, with the analysis a later rebuild can reuse. */
export interface FaceLayerBuild {
  faces: Map<FaceLocalId, FaceRecord>;
  edges: Map<EdgeKey, EdgeRecord>;
  nextFaceId: number;
  analysis: MeshAnalysis;
}

/**
 * Face and edge records of `mesh`, equal to a full rebuild. With a `prior` analysis of an earlier mesh (same tag and
 * weld tolerance), faces and face pairs whose inputs are identical reuse the records already derived. Faces returned
 * are shared with the analysis: copy them before changing them.
 */
export function buildFaceLayer(mesh: MeshData, tagId: TagId, prior: MeshAnalysis | null, weldTol = LENGTH_TOL): FaceLayerBuild {
  const analysis = analyzeMesh(mesh, tagId, weldTol);
  const usable = prior && prior.tagId === tagId && prior.weldTol === weldTol ? prior : null;
  const { faces, nextFaceId } = buildFaces(analysis, usable);
  const edges = buildEdges(analysis, usable);
  if (usable && VERIFY_REUSED_REBUILDS) assertEqualsFullRebuild(mesh, tagId, weldTol, faces, edges, nextFaceId);
  return { faces, edges, nextFaceId, analysis };
}

/**
 * Test runs set this to compare every reuse with a full rebuild, so each existing test that edits a body also checks
 * that reuse changes nothing. Read through `globalThis` because browsers have no `process`.
 */
const VERIFY_REUSED_REBUILDS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PUSHFORM_VERIFY_REUSED_REBUILDS === '1';

/** Throws unless reused records are exactly what a full rebuild produces, including the order of the tables. */
function assertEqualsFullRebuild(mesh: MeshData, tagId: TagId, weldTol: number, faces: Map<FaceLocalId, FaceRecord>, edges: Map<EdgeKey, EdgeRecord>, nextFaceId: number): void {
  const full = analyzeMesh(mesh, tagId, weldTol);
  const expected = buildFaces(full, null);
  const expectedEdges = buildEdges(full, null);
  const same = expected.nextFaceId === nextFaceId && exactlyEqual([...expected.faces], [...faces]) && exactlyEqual([...expectedEdges], [...edges]);
  if (!same) throw new Error('Reusing face or edge records produced a different result from a full rebuild');
}

/** Structural equality with `Object.is` on numbers, comparing own keys of objects. */
function exactlyEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b);
  const keysA = Object.keys(a), keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => exactlyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * The analysis of the mesh most recently rebuilt by `reconcileBody`. One slot is enough: the case worth the memory is
 * consecutive edits to the same body, and a miss only means a full rebuild.
 */
let lastAnalysis: MeshAnalysis | null = null;

export function rememberAnalysis(analysis: MeshAnalysis): void {
  lastAnalysis = analysis;
}

export function analysisOf(mesh: MeshData): MeshAnalysis | null {
  return lastAnalysis?.mesh === mesh ? lastAnalysis : null;
}

/** Point of the plane nearest the world origin: a stable basis origin across mesh edits. */
export function planeOrigin(plane: Plane): Vec3 {
  return [-plane.n[0] * plane.d, -plane.n[1] * plane.d, -plane.n[2] * plane.d];
}

function chainLoops(mesh: MeshData, edges: BoundaryEdge[], basis: ReturnType<typeof planeBasis>): Vec3[][] {
  const outAt = new Map<number, BoundaryEdge[]>();
  for (const e of edges) {
    const l = outAt.get(e.u);
    if (l) l.push(e);
    else outAt.set(e.u, [e]);
  }
  const used = new Set<BoundaryEdge>();
  const rings: { pts: Vec3[]; area: number }[] = [];
  for (const start of edges) {
    if (used.has(start)) continue;
    const ring: BoundaryEdge[] = [];
    let cur: BoundaryEdge | undefined = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      ring.push(cur);
      const next: BoundaryEdge | undefined = (outAt.get(cur.v) ?? []).find((e) => !used.has(e));
      cur = next;
    }
    if (ring.length < 3) continue;
    // drop vertices in the middle of a straight run with the same neighbour on both sides
    const kept: Vec3[] = [];
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i + ring.length - 1) % ring.length]!, e = ring[i]!;
      const p = vert(mesh, prev.u), q = vert(mesh, e.u), r = vert(mesh, e.v);
      if (prev.other === e.other && collinear(p, q, r, 1e-9)) continue;
      kept.push(q);
    }
    if (kept.length < 3) continue;
    const uv = kept.map((p) => {
      const l = basisToLocal(basis, p);
      return [l[0], l[1]];
    });
    rings.push({ pts: kept, area: signedArea(uv) });
  }
  rings.sort((a, b) => b.area - a.area);
  return rings.map((r) => r.pts);
}

// ---------------------------------------------------------------------------------------------
// Derived edges

/**
 * Edge records: triangle edges where faceId differs, grouped by face pair and chained into maximal
 * collinear runs. Keys `${minFace}:${maxFace}:${k}` with k in a deterministic geometric order.
 */
export function deriveEdges(mesh: MeshData, tagId: TagId, weldTol = LENGTH_TOL): Map<EdgeKey, EdgeRecord> {
  return buildEdges(analyzeMesh(mesh, tagId, weldTol), null);
}

/** Edge records of an analysis, reusing `prior`'s runs for every face pair whose input is identical. */
function buildEdges(a: MeshAnalysis, prior: MeshAnalysis | null): Map<EdgeKey, EdgeRecord> {
  const out = new Map<EdgeKey, EdgeRecord>();
  for (const pair of a.pairs) {
    const before = prior?.pairIndex.get(pair.a)?.get(pair.b);
    pair.records = before?.records && prior && samePairInput(before, prior.mesh, pair, a.mesh) ? before.records : deriveEdgesOfPair(a.mesh, pair, a.tagId);
    // copies: callers set edge flags on these
    for (const e of pair.records) out.set(e.key, { key: e.key, faceA: e.faceA, faceB: e.faceB, polyline: e.polyline, soft: false, smooth: false, hidden: false, tagId: e.tagId, curveId: null });
  }
  return out;
}

/** The runs of one face pair, in the deterministic order of their keys. */
function deriveEdgesOfPair(mesh: MeshData, pair: FacePairEdges, tagId: TagId): EdgeRecord[] {
  const n = mesh.verts.length / 3;
  // dedupe identical directed edges (can occur with welded duplicates)
  const seen = new Set<number>();
  const uniq: BoundaryEdge[] = [];
  for (const e of pair.list) {
    const k = e.u * n + e.v;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  const outAt = new Map<number, BoundaryEdge[]>(), inAt = new Map<number, BoundaryEdge[]>();
  for (const e of uniq) {
    (outAt.get(e.u) ?? outAt.set(e.u, []).get(e.u)!).push(e);
    (inAt.get(e.v) ?? inAt.set(e.v, []).get(e.v)!).push(e);
  }
  const used = new Set<BoundaryEdge>();
  const runs: Vec3[][] = [];
  const continues = (a: BoundaryEdge, b: BoundaryEdge): boolean =>
    a.v === b.u && (outAt.get(a.v)?.length ?? 0) === 1 && (inAt.get(a.v)?.length ?? 0) === 1 &&
    collinear(vert(mesh, a.u), vert(mesh, a.v), vert(mesh, b.v), 1e-9);
  for (const e of uniq) {
    if (used.has(e)) continue;
    used.add(e);
    const run: BoundaryEdge[] = [e];
    // extend forward
    for (;;) {
      const last = run[run.length - 1]!;
      const next = (outAt.get(last.v) ?? []).find((x) => !used.has(x) && continues(last, x));
      if (!next) break;
      used.add(next);
      run.push(next);
    }
    // extend backward
    for (;;) {
      const first = run[0]!;
      const prev = (inAt.get(first.u) ?? []).find((x) => !used.has(x) && continues(x, first));
      if (!prev) break;
      used.add(prev);
      run.unshift(prev);
    }
    runs.push([vert(mesh, run[0]!.u), ...run.map((x) => vert(mesh, x.v))]);
  }
  runs.sort((a, b) => cmpVec(minPoint(a), minPoint(b)));
  const faceA = pair.a as FaceLocalId, faceB = pair.b as FaceLocalId;
  return runs.map((polyline, k) => {
    const key = makeEdgeKey(faceA, faceB, k);
    return { key, faceA, faceB, polyline: sealGeometry(polyline), soft: false, smooth: false, hidden: false, tagId, curveId: null };
  });
}

function minPoint(poly: Vec3[]): Vec3 {
  let m = poly[0]!;
  for (const p of poly) if (cmpVec(p, m) < 0) m = p;
  return m;
}
function cmpVec(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Carry soft/smooth/hidden/tag/curve from old edges to new ones: same face pair, collinear, and
 * the old run covers ≥ 50% of the new run's length (best match wins). Returns the carried count.
 */
export function carryEdgeProps(
  oldEdges: ReadonlyMap<EdgeKey, EdgeRecord>,
  newEdges: Map<EdgeKey, EdgeRecord>,
  tol = MERGE_TOL,
  minOverlap = 0.5,
): number {
  const byPair = new Map<number, Map<number, EdgeRecord[]>>();
  for (const e of oldEdges.values()) {
    let forA = byPair.get(e.faceA);
    if (!forA) byPair.set(e.faceA, (forA = new Map()));
    const cands = forA.get(e.faceB);
    if (cands) cands.push(e);
    else forA.set(e.faceB, [e]);
  }
  let carried = 0;
  for (const e of newEdges.values()) {
    const cands = byPair.get(e.faceA)?.get(e.faceB);
    if (!cands) continue;
    let best: EdgeRecord | null = null, bestOverlap = minOverlap;
    for (const c of cands) {
      const o = overlapRatio(e.polyline, c.polyline, tol);
      if (o >= bestOverlap) {
        bestOverlap = o;
        best = c;
      }
    }
    if (best) {
      e.soft = best.soft;
      e.smooth = best.smooth;
      e.hidden = best.hidden;
      e.tagId = best.tagId;
      e.curveId = best.curveId;
      carried++;
    }
  }
  return carried;
}

/** Fraction of `target` (a collinear run) covered by `other` when both lie on the same line. */
export function overlapRatio(target: Vec3[], other: Vec3[], tol: number): number {
  const a = target[0]!, b = target[target.length - 1]!;
  const d = v3sub(b, a);
  const len = v3len(d);
  if (len === 0) return 0;
  const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const params: number[] = [];
  for (const p of [other[0]!, other[other.length - 1]!]) {
    const r = v3sub(p, a);
    const t = v3dot(r, dir);
    const off = v3dist(r, [dir[0] * t, dir[1] * t, dir[2] * t]);
    if (off > tol) return 0;
    params.push(t / len);
  }
  const lo = Math.max(0, Math.min(params[0]!, params[1]!));
  const hi = Math.min(1, Math.max(params[0]!, params[1]!));
  return Math.max(0, hi - lo);
}
