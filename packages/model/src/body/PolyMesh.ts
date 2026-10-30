// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * PolyMesh: the n-gon polygon layer of a Body as an editable, index-shared vertex soup, and the
 * autofold pipeline: displace vertices, split faces that are no
 * longer planar into coplanar pieces, merge vertices that landed on each other, re-triangulate.
 *
 * The kernel validates the resulting triangle mesh (`autofold` op); this file never decides whether
 * the solid is acceptable.
 */
import type { EntityRef } from '../entities/common';
import type { Body } from '../entities/body';
import type { FaceLocalId, Mat4, MMat4, MeshData, Vec3 } from '@pushform/core';
import {
  AREA_TOL,
  COPLANAR_TOL,
  MERGE_TOL,
  m4transformPoint,
  planeBasis,
  v3add,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3normalize,
  v3scale,
  v3sub,
} from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';

/** One n-gon of the polygon layer: loops of vertex indices, outer first (CCW about `normal`). */
export interface PolyMeshFace {
  faceId: FaceLocalId;
  loops: number[][];
  /** Outward unit normal of the face as it was built (before any displacement). */
  normal: Vec3;
}

export interface PolyMesh {
  verts: Vec3[];
  faces: PolyMeshFace[];
  /** First free face id; folded pieces are numbered from here. */
  nextFaceId: number;
}

export interface FoldResult {
  /** Welded triangle mesh with one face id per triangle, ready for the kernel's `autofold`. */
  mesh: MeshData;
  /** Every face id in `mesh` (new fold pieces and surviving faces alike) -> the face it came from. */
  faceOrigin: Map<FaceLocalId, FaceLocalId>;
  nextFaceId: number;
}

export interface FoldOptions {
  /**
   * Vertex indices that were displaced. A non-planar face is fanned from one of these; when
   * omitted, the vertex farthest from the face's best-fit plane is used.
   */
  moved?: ReadonlySet<number> | Iterable<number>;
}

// ---------------------------------------------------------------------------------------------
// Vertex welding

/** Hash grid used to merge positions within `tol` (cells of size `tol`, 27-neighbourhood search). */
class VertexWelder {
  private readonly cells = new Map<string, number[]>();
  readonly positions: Vec3[] = [];

  constructor(private readonly tol: number) {}

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** Index of an existing vertex within `tol` of `p`, or -1. */
  find(p: Vec3): number {
    const s = 1 / this.tol;
    const cx = Math.floor(p[0] * s), cy = Math.floor(p[1] * s), cz = Math.floor(p[2] * s);
    let best = -1, bestD = this.tol;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
          if (list === undefined) continue;
          for (const i of list) {
            const d = v3dist(this.positions[i]!, p);
            if (d <= bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }

  /** Index for `p`, reusing a vertex within `tol` when one exists. */
  add(p: Vec3): number {
    const existing = this.find(p);
    if (existing >= 0) return existing;
    const i = this.positions.length;
    this.positions.push([p[0], p[1], p[2]]);
    const s = 1 / this.tol;
    const k = this.key(Math.floor(p[0] * s), Math.floor(p[1] * s), Math.floor(p[2] * s));
    const list = this.cells.get(k);
    if (list === undefined) this.cells.set(k, [i]);
    else list.push(i);
    return i;
  }
}

// ---------------------------------------------------------------------------------------------
// Construction and editing

/** Build the polygon layer from the body's FaceRecords, welding loop positions within `MERGE_TOL`. */
export function polyMeshFromBody(body: Body, tol = MERGE_TOL): PolyMesh {
  const welder = new VertexWelder(tol);
  const faces: PolyMeshFace[] = [];
  for (const face of body.faces.values()) {
    const loops = face.loops.map((loop) => loop.map((p) => welder.add(p)));
    faces.push({ faceId: face.id, loops, normal: [face.plane.n[0], face.plane.n[1], face.plane.n[2]] });
  }
  return { verts: welder.positions, faces, nextFaceId: body.nextFaceId };
}

/** Copy of `poly` with the given vertices at new positions (index -> absolute position). */
export function movedPolyMesh(poly: PolyMesh, displacements: ReadonlyMap<number, Vec3>): PolyMesh {
  const verts = poly.verts.map((p, i) => {
    const q = displacements.get(i);
    return q === undefined ? p : ([q[0], q[1], q[2]] as Vec3);
  });
  return { verts, faces: poly.faces, nextFaceId: poly.nextFaceId };
}

/** Copy of `poly` with the given vertices transformed by a column-major 4x4 matrix. */
export function transformVertices(poly: PolyMesh, indices: Iterable<number>, matrix: Mat4 | MMat4): PolyMesh {
  const moved = new Map<number, Vec3>();
  for (const i of indices) {
    const p = poly.verts[i];
    if (p !== undefined) moved.set(i, m4transformPoint(matrix, p));
  }
  return movedPolyMesh(poly, moved);
}

/** Index of the vertex within `tol` of `position`, or -1. */
export function polyVertexAt(poly: PolyMesh, position: Vec3, tol = MERGE_TOL): number {
  let best = -1, bestD = tol;
  for (let i = 0; i < poly.verts.length; i++) {
    const d = v3dist(poly.verts[i]!, position);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Vertex indices a sub-entity Move drags: an edge (every point of its polyline: both ends plus
 * interior kinks / T-junction vertices), a face (every vertex of all its loops; the region is
 * ignored), or a raw vertex position. Other ref kinds yield no vertices. Sorted, de-duplicated.
 */
export function polyVerticesForRef(body: Body, poly: PolyMesh, ref: EntityRef | Vec3, tol = MERGE_TOL): number[] {
  const out = new Set<number>();
  const addPos = (p: Vec3): void => {
    const i = polyVertexAt(poly, p, tol);
    if (i >= 0) out.add(i);
  };
  if (Array.isArray(ref)) {
    addPos(ref as Vec3);
  } else {
    const r = ref as EntityRef;
    if (r.kind === 'edge') {
      const edge = body.edges.get(r.edgeKey);
      if (edge !== undefined) for (const p of edge.polyline) addPos(p);
    } else if (r.kind === 'face') {
      for (const face of poly.faces) {
        if (face.faceId !== r.faceId) continue;
        for (const loop of face.loops) for (const i of loop) out.add(i);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// Fold + triangulate

/** Newell normal (unnormalized; its length is twice the loop's area) and the loop's centroid. */
function loopNewell(verts: readonly Vec3[], loop: readonly number[]): { n: Vec3; c: Vec3 } {
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = verts[loop[i]!]!, q = verts[loop[(i + 1) % loop.length]!]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const k = loop.length > 0 ? 1 / loop.length : 0;
  return { n: [nx, ny, nz], c: [cx * k, cy * k, cz * k] };
}

/** Max distance of the face's vertices from its best-fit (Newell) plane, with that plane's normal. */
function planarity(verts: readonly Vec3[], loops: readonly (readonly number[])[]): { maxDist: number; normal: Vec3; origin: Vec3 } {
  const { n, c } = loopNewell(verts, loops[0] ?? []);
  const len = v3len(n);
  if (len === 0) return { maxDist: 0, normal: [0, 0, 0], origin: c };
  const normal = v3scale(n, 1 / len);
  let maxDist = 0;
  for (const loop of loops) {
    for (const i of loop) maxDist = Math.max(maxDist, Math.abs(v3dot(v3sub(verts[i]!, c), normal)));
  }
  return { maxDist, normal, origin: c };
}

/** Remove consecutive repeats (including the closing pair) from a loop of indices. */
function dedupeLoop(loop: readonly number[]): number[] {
  const out: number[] = [];
  for (const i of loop) if (out[out.length - 1] !== i) out.push(i);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

function isConvexLoop(verts: readonly Vec3[], loop: readonly number[], normal: Vec3): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = verts[loop[i]!]!, b = verts[loop[(i + 1) % n]!]!, c = verts[loop[(i + 2) % n]!]!;
    if (v3dot(v3cross(v3sub(b, a), v3sub(c, b)), normal) < -AREA_TOL) return false;
  }
  return true;
}

/**
 * Split a non-planar face into planar triangles: a fan from `apex` when the (projected) outer loop
 * is convex and has no holes, else an earcut of the loops projected onto the face's fit plane.
 * Returns index triples following the loop orientation.
 */
function splitNonPlanar(verts: readonly Vec3[], face: PolyMeshFace, apex: number, fitNormal: Vec3, origin: Vec3): number[][] {
  const outer = face.loops[0]!;
  if (face.loops.length === 1 && isConvexLoop(verts, outer, fitNormal)) {
    const k = outer.indexOf(apex);
    const start = k >= 0 ? k : 0;
    const n = outer.length;
    const tris: number[][] = [];
    for (let j = 1; j + 1 < n; j++) tris.push([outer[start]!, outer[(start + j) % n]!, outer[(start + j + 1) % n]!]);
    return tris;
  }
  const basis = planeBasis(origin, fitNormal);
  const rings = face.loops.map((loop) => loop.map((i) => verts[i]!));
  const tri = triangulatePlanarFace(rings, basis);
  // Map triangulation vertices (possibly reordered per ring) back to poly indices by position.
  const indexOf = (k: number): number => {
    const p: Vec3 = [tri.positions[k * 3]!, tri.positions[k * 3 + 1]!, tri.positions[k * 3 + 2]!];
    for (const loop of face.loops) for (const i of loop) if (v3dist(verts[i]!, p) === 0) return i;
    return -1;
  };
  const tris: number[][] = [];
  for (let t = 0; t + 2 < tri.indices.length; t += 3) {
    const a = indexOf(tri.indices[t]!), b = indexOf(tri.indices[t + 1]!), c = indexOf(tri.indices[t + 2]!);
    if (a < 0 || b < 0 || c < 0) continue;
    tris.push([a, b, c]);
  }
  return tris;
}

/** Group planar triangles into coplanar, edge-adjacent pieces and return each piece's boundary loop. */
function piecesFromTriangles(verts: readonly Vec3[], tris: readonly (readonly number[])[]): number[][] {
  const normals = tris.map((t) => {
    const n = v3cross(v3sub(verts[t[1]!]!, verts[t[0]!]!), v3sub(verts[t[2]!]!, verts[t[0]!]!));
    const l = v3len(n);
    return l > 0 ? v3scale(n, 1 / l) : ([0, 0, 0] as Vec3);
  });
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const byEdge = new Map<string, number[]>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t[k]!, t[(k + 1) % 3]!);
      const l = byEdge.get(key);
      if (l === undefined) byEdge.set(key, [i]);
      else l.push(i);
    }
  });
  const coplanar = (i: number, j: number): boolean => {
    if (v3dot(normals[i]!, normals[j]!) < 1 - 1e-9) return false;
    const o = verts[tris[i]![0]!]!;
    for (const v of tris[j]!) if (Math.abs(v3dot(v3sub(verts[v]!, o), normals[i]!)) > COPLANAR_TOL) return false;
    return true;
  };
  const group = new Int32Array(tris.length).fill(-1);
  const groups: number[][] = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (group[seed] !== -1) continue;
    const g = groups.length;
    const members: number[] = [];
    groups.push(members);
    const stack = [seed];
    group[seed] = g;
    while (stack.length > 0) {
      const i = stack.pop()!;
      members.push(i);
      const t = tris[i]!;
      for (let k = 0; k < 3; k++) {
        for (const j of byEdge.get(edgeKey(t[k]!, t[(k + 1) % 3]!)) ?? []) {
          if (group[j] !== -1 || !coplanar(seed, j)) continue;
          group[j] = g;
          stack.push(j);
        }
      }
    }
  }
  // Boundary loop of each group: directed edges used once, chained.
  const loops: number[][] = [];
  for (const members of groups) {
    const directed = new Set<string>();
    for (const i of members) {
      const t = tris[i]!;
      for (let k = 0; k < 3; k++) directed.add(`${t[k]}>${t[(k + 1) % 3]}`);
    }
    const next = new Map<number, number>();
    for (const key of directed) {
      const [a, b] = key.split('>').map(Number) as [number, number];
      if (!directed.has(`${b}>${a}`)) next.set(a, b);
    }
    if (next.size < 3) continue;
    const start = next.keys().next().value!;
    const loop = [start];
    let cur = next.get(start)!;
    while (cur !== start && loop.length <= next.size) {
      loop.push(cur);
      cur = next.get(cur)!;
      if (cur === undefined) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Autofold: weld vertices that landed within `MERGE_TOL` of each other, drop degenerate faces,
 * split every face whose vertices left their common plane into coplanar pieces (fold edges fan out
 * from a moved vertex; the original id stays on the largest piece), then earcut every face in its
 * own plane with outward CCW winding. The triangle mesh shares vertices by index (welded).
 */
export function foldAndTriangulate(poly: PolyMesh, opts: FoldOptions = {}): FoldResult {
  const movedSet = opts.moved === undefined ? undefined : opts.moved instanceof Set ? opts.moved : new Set(opts.moved);

  // 1. Weld.
  const welder = new VertexWelder(MERGE_TOL);
  const remap = poly.verts.map((p) => welder.add(p));
  const verts = welder.positions;
  const moved = new Set<number>();
  if (movedSet !== undefined) for (const i of movedSet) if (remap[i] !== undefined) moved.add(remap[i]!);

  // 2. Remap loops, drop degenerate loops/faces.
  interface Pending {
    faceId: FaceLocalId;
    origin: FaceLocalId;
    loops: number[][];
    normal: Vec3;
  }
  const pending: Pending[] = [];
  for (const face of poly.faces) {
    const [outer, ...holes] = face.loops.map((loop) => dedupeLoop(loop.map((i) => remap[i]!)));
    if (outer === undefined || new Set(outer).size < 3) continue;
    if (v3len(loopNewell(verts, outer).n) / 2 <= AREA_TOL) continue;
    const loops = [outer, ...holes.filter((h) => new Set(h).size >= 3)];
    pending.push({ faceId: face.faceId, origin: face.faceId, loops, normal: face.normal });
  }

  // 3. Fold non-planar faces.
  let nextFaceId = poly.nextFaceId;
  const planarFaces: Pending[] = [];
  for (const face of pending) {
    const fit = planarity(verts, face.loops);
    if (fit.maxDist <= COPLANAR_TOL) {
      planarFaces.push(face);
      continue;
    }
    // Apex: a moved vertex of the face (the one farthest from the fit plane), else the farthest vertex.
    let apex = -1, apexDist = -1, farthest = -1, farthestDist = -1;
    for (const loop of face.loops) {
      for (const i of loop) {
        const d = Math.abs(v3dot(v3sub(verts[i]!, fit.origin), fit.normal));
        if (d > farthestDist) {
          farthestDist = d;
          farthest = i;
        }
        if (moved.has(i) && d > apexDist) {
          apexDist = d;
          apex = i;
        }
      }
    }
    if (apex < 0) apex = farthest;
    const tris = splitNonPlanar(verts, { faceId: face.faceId, loops: face.loops, normal: face.normal }, apex, fit.normal, fit.origin);
    const pieces = piecesFromTriangles(verts, tris)
      .map((loop) => ({ loop, area: v3len(loopNewell(verts, loop).n) / 2 }))
      .filter((p) => p.area > AREA_TOL)
      .sort((a, b) => b.area - a.area);
    pieces.forEach((piece, k) => {
      const id = k === 0 ? face.faceId : (nextFaceId++ as FaceLocalId);
      planarFaces.push({ faceId: id, origin: face.origin, loops: [piece.loop], normal: face.normal });
    });
  }

  // 4. Triangulate every planar face in its own basis, CCW about the loop's (outward) normal.
  const tris: number[] = [];
  const faceIds: number[] = [];
  const faceOrigin = new Map<FaceLocalId, FaceLocalId>();
  for (const face of planarFaces) {
    const { n, c } = loopNewell(verts, face.loops[0]!);
    const len = v3len(n);
    if (len / 2 <= AREA_TOL) continue;
    let normal = v3scale(n, 1 / len);
    // The loop order carries the outward orientation; only a fully inverted loop disagrees with the
    // original normal, in which case the original wins so neighbours stay consistently oriented.
    const flip = v3dot(normal, face.normal) < 0 && v3len(face.normal) > 0;
    if (flip) normal = v3scale(normal, -1);
    const basis = planeBasis(c, normal);
    const rings = face.loops.map((loop) => loop.map((i) => verts[i]!));
    const tri = triangulatePlanarFace(rings, basis);
    const lookup = new Map<string, number>();
    for (const loop of face.loops) for (const i of loop) lookup.set(verts[i]!.join(','), i);
    const indexOf = (k: number): number =>
      lookup.get(`${tri.positions[k * 3]},${tri.positions[k * 3 + 1]},${tri.positions[k * 3 + 2]}`) ?? -1;
    let count = 0;
    for (let t = 0; t + 2 < tri.indices.length; t += 3) {
      const a = indexOf(tri.indices[t]!), b = indexOf(tri.indices[t + 1]!), d = indexOf(tri.indices[t + 2]!);
      if (a < 0 || b < 0 || d < 0 || a === b || b === d || a === d) continue;
      tris.push(a, b, d);
      faceIds.push(face.faceId);
      count++;
    }
    if (count > 0) faceOrigin.set(face.faceId, face.origin);
  }

  // 5. Compact unused vertices.
  const used = new Int32Array(verts.length).fill(-1);
  let n = 0;
  for (const i of tris) if (used[i] === -1) used[i] = n++;
  const outVerts = new Float64Array(n * 3);
  for (let i = 0; i < verts.length; i++) {
    const o = used[i]!;
    if (o === -1) continue;
    const p = verts[i]!;
    outVerts[o * 3] = p[0];
    outVerts[o * 3 + 1] = p[1];
    outVerts[o * 3 + 2] = p[2];
  }
  const mesh: MeshData = {
    verts: outVerts,
    tris: Uint32Array.from(tris, (i) => used[i]!),
    faceId: Uint32Array.from(faceIds),
  };
  return { mesh, faceOrigin, nextFaceId };
}

/** Convenience: the world position of a vertex (copy). */
export function polyVertex(poly: PolyMesh, i: number): Vec3 {
  const p = poly.verts[i];
  if (p === undefined) throw new RangeError(`PolyMesh has no vertex ${i}`);
  return [p[0], p[1], p[2]];
}

/** Translate every vertex in `indices` by `delta` (the common Move-tool case). */
export function translateVertices(poly: PolyMesh, indices: Iterable<number>, delta: Vec3): PolyMesh {
  const moved = new Map<number, Vec3>();
  for (const i of indices) {
    const p = poly.verts[i];
    if (p !== undefined) moved.set(i, v3add(p, delta));
  }
  return movedPolyMesh(poly, moved);
}

/** Unit normal of a face's current outer loop (Newell), or the stored normal when degenerate. */
export function polyFaceNormal(poly: PolyMesh, face: PolyMeshFace): Vec3 {
  const { n } = loopNewell(poly.verts, face.loops[0] ?? []);
  return v3len(n) > 0 ? v3normalize(n) : face.normal;
}
