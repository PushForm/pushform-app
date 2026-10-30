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
import { allocId, type DocumentDraft, type Draft } from '../Document';

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

function boundaryEdges(mesh: MeshData, weldTol = LENGTH_TOL): { canon: Int32Array; edges: BoundaryEdge[] } {
  const canon = weldVertices(mesh.verts, weldTol);
  const n = mesh.verts.length / 3;
  const t = mesh.tris;
  const faceOfDirected = new Map<number, number>();
  const triCount = t.length / 3;
  for (let i = 0; i < triCount; i++) {
    const f = mesh.faceId[i]!;
    for (let k = 0; k < 3; k++) {
      const u = canon[t[i * 3 + k]!]!, v = canon[t[i * 3 + ((k + 1) % 3)]!]!;
      if (u !== v) faceOfDirected.set(u * n + v, f);
    }
  }
  const edges: BoundaryEdge[] = [];
  for (let i = 0; i < triCount; i++) {
    const f = mesh.faceId[i]!;
    for (let k = 0; k < 3; k++) {
      const u = canon[t[i * 3 + k]!]!, v = canon[t[i * 3 + ((k + 1) % 3)]!]!;
      if (u === v) continue;
      const g = faceOfDirected.get(v * n + u);
      if (g === undefined) edges.push({ u, v, face: f, other: -1 });
      else if (g !== f) edges.push({ u, v, face: f, other: g });
    }
  }
  return { canon, edges };
}

const vert = (mesh: MeshData, i: number): Vec3 => [mesh.verts[i * 3]!, mesh.verts[i * 3 + 1]!, mesh.verts[i * 3 + 2]!];

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
  const planes = facePlanesFromMesh(mesh);
  const { edges } = boundaryEdges(mesh, weldTol);
  const byFace = new Map<number, BoundaryEdge[]>();
  for (const e of edges) {
    const l = byFace.get(e.face);
    if (l) l.push(e);
    else byFace.set(e.face, [e]);
  }
  const faces = new Map<FaceLocalId, FaceRecord>();
  let maxId = -1;
  for (const [fid, plane] of planes) {
    maxId = Math.max(maxId, fid);
    const basis = planeBasis(planeOrigin(plane), plane.n);
    const loops = chainLoops(mesh, byFace.get(fid) ?? [], basis);
    faces.set(fid as FaceLocalId, {
      id: fid as FaceLocalId,
      plane,
      basis,
      loops,
      frontMaterialId: null,
      backMaterialId: null,
      uv: UV_AUTO,
      tagId,
      hidden: false,
      surfaceId: null,
    });
  }
  return { faces, nextFaceId: maxId + 1 };
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
  const { edges } = boundaryEdges(mesh, weldTol);
  const byPair = new Map<string, BoundaryEdge[]>();
  for (const e of edges) {
    if (e.other < 0 || e.face > e.other) continue; // keep the orientation of the lower face id
    const key = `${e.face}:${e.other}`;
    const l = byPair.get(key);
    if (l) l.push(e);
    else byPair.set(key, [e]);
  }
  const out = new Map<EdgeKey, EdgeRecord>();
  for (const [, list] of byPair) {
    const faceA = list[0]!.face as FaceLocalId, faceB = list[0]!.other as FaceLocalId;
    // dedupe identical directed edges (can occur with welded duplicates)
    const seenKey = new Set<string>();
    const uniq: BoundaryEdge[] = [];
    for (const e of list) {
      const k = `${e.u},${e.v}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
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
    runs.forEach((polyline, k) => {
      const key = makeEdgeKey(faceA, faceB, k);
      out.set(key, { key, faceA, faceB, polyline, soft: false, smooth: false, hidden: false, tagId, curveId: null });
    });
  }
  return out;
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
  const byPair = new Map<string, EdgeRecord[]>();
  for (const e of oldEdges.values()) {
    const k = `${e.faceA}:${e.faceB}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e);
  }
  let carried = 0;
  for (const e of newEdges.values()) {
    const cands = byPair.get(`${e.faceA}:${e.faceB}`);
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
