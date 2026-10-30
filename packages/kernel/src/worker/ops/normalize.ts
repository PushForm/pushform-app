// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Normalize invariant: group triangles into faces by coplanarity AND edge adjacency, then assign
 * face ids. Non-adjacent coplanar groups stay separate faces.
 */
import { AREA_TOL, COPLANAR_TOL } from '@pushform/core';
import type { FaceOrigin, FaceOriginRef, MeshWire } from '../../protocol';
import type { ReadMesh } from '../meshio';

export interface CoplanarGroups {
  /** Group index per triangle. */
  groupOf: Int32Array;
  /** Triangle indices per group, largest seed triangle first. */
  groups: number[][];
}

/** Per-triangle unit normal, plane offset (n·p) and area. */
interface TriPlanes {
  normals: Float64Array;
  offsets: Float64Array;
  areas: Float64Array;
}

function trianglePlanes(verts: Float64Array, tris: Uint32Array): TriPlanes {
  const n = tris.length / 3;
  const normals = new Float64Array(n * 3), offsets = new Float64Array(n), areas = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const a = tris[t * 3]! * 3, b = tris[t * 3 + 1]! * 3, c = tris[t * 3 + 2]! * 3;
    const ax = verts[a]!, ay = verts[a + 1]!, az = verts[a + 2]!;
    const e1x = verts[b]! - ax, e1y = verts[b + 1]! - ay, e1z = verts[b + 2]! - az;
    const e2x = verts[c]! - ax, e2y = verts[c + 1]! - ay, e2z = verts[c + 2]! - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    areas[t] = l / 2;
    if (l > 0) {
      normals[t * 3] = nx / l;
      normals[t * 3 + 1] = ny / l;
      normals[t * 3 + 2] = nz / l;
      offsets[t] = (nx * ax + ny * ay + nz * az) / l;
    }
  }
  return { normals, offsets, areas };
}

/** For each triangle, the triangles sharing one of its edges. */
function triangleNeighbors(tris: Uint32Array, numVerts: number): number[][] {
  const n = tris.length / 3;
  const byEdge = new Map<number, number[]>();
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k]!, b = tris[t * 3 + ((k + 1) % 3)]!;
      const key = Math.min(a, b) * numVerts + Math.max(a, b);
      const list = byEdge.get(key);
      if (list === undefined) byEdge.set(key, [t]);
      else {
        for (const u of list) {
          neighbors[t]!.push(u);
          neighbors[u]!.push(t);
        }
        list.push(t);
      }
    }
  }
  return neighbors;
}

/**
 * Region-grow faces: seeds are taken in order of decreasing area so every group's reference plane
 * comes from its most reliable triangle; a neighbor joins when all its vertices lie within
 * `COPLANAR_TOL` of that plane and (unless degenerate) its normal agrees in sign.
 */
export function groupCoplanar(verts: Float64Array, tris: Uint32Array, tol = COPLANAR_TOL): CoplanarGroups {
  const n = tris.length / 3;
  const { normals, offsets, areas } = trianglePlanes(verts, tris);
  const neighbors = triangleNeighbors(tris, verts.length / 3);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => areas[b]! - areas[a]!);
  const groupOf = new Int32Array(n).fill(-1);
  const groups: number[][] = [];

  const fits = (t: number, nx: number, ny: number, nz: number, d: number): boolean => {
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k]! * 3;
      if (Math.abs(nx * verts[v]! + ny * verts[v + 1]! + nz * verts[v + 2]! - d) > tol) return false;
    }
    if (areas[t]! <= AREA_TOL) return true;
    return nx * normals[t * 3]! + ny * normals[t * 3 + 1]! + nz * normals[t * 3 + 2]! > 0;
  };

  for (const seed of order) {
    if (groupOf[seed] !== -1) continue;
    const g = groups.length;
    const members: number[] = [];
    groups.push(members);
    const nx = normals[seed * 3]!, ny = normals[seed * 3 + 1]!, nz = normals[seed * 3 + 2]!, d = offsets[seed]!;
    const stack = [seed];
    groupOf[seed] = g;
    while (stack.length > 0) {
      const t = stack.pop()!;
      members.push(t);
      for (const u of neighbors[t]!) {
        if (groupOf[u] !== -1 || !fits(u, nx, ny, nz, d)) continue;
        groupOf[u] = g;
        stack.push(u);
      }
    }
  }
  return { groupOf, groups };
}

/** An origin with the total triangle area it contributed to a group. */
export interface WeightedOrigin extends FaceOriginRef {
  area: number;
}

/**
 * Picks the face id a coplanar group keeps, given its origins sorted by contributed area
 * (largest first). Return `undefined` to allocate a fresh id.
 */
export type ChooseFaceId = (origins: WeightedOrigin[]) => number | undefined;

/** Keep the dominant origin's face id when it comes from one of `runIds`. */
export const keepIdsFromRuns =
  (runIds: ReadonlySet<number>): ChooseFaceId =>
  (origins) => {
    const own = origins.filter((o) => runIds.has(o.runId));
    return own.length > 0 ? own.reduce((min, o) => (o.faceId < min ? o.faceId : min), own[0]!.faceId) : undefined;
  };

export const allNewIds: ChooseFaceId = () => undefined;

export interface NormalizedFace {
  id: number;
  origins: WeightedOrigin[];
}

export interface Normalized {
  mesh: MeshWire;
  faceOrigin: FaceOrigin;
  faces: NormalizedFace[];
  nextFaceId: number;
}

function originsOf(read: ReadMesh, members: number[], areas: Float64Array): WeightedOrigin[] {
  const acc = new Map<string, WeightedOrigin>();
  for (const t of members) {
    const runId = read.runId[t]!, faceId = read.faceId[t]!;
    const key = `${runId}:${faceId}`;
    const o = acc.get(key);
    if (o === undefined) acc.set(key, { runId, faceId, area: areas[t]! });
    else o.area += areas[t]!;
  }
  return [...acc.values()].sort((a, b) => b.area - a.area);
}

/**
 * Group `read` into faces and assign ids. Candidate ids come from `chooseId`; the first (largest)
 * group claiming an id wins and later claimants get fresh ids, which are allocated above both
 * `nextFaceId` and every kept id so ids never collide.
 */
export function normalizeTriangles(read: ReadMesh, nextFaceId: number, chooseId: ChooseFaceId): Normalized {
  const { groups } = groupCoplanar(read.verts, read.tris);
  const { areas } = trianglePlanes(read.verts, read.tris);
  const originsPerGroup = groups.map((members) => originsOf(read, members, areas));
  const claimed = new Set<number>();
  const ids = new Array<number | undefined>(groups.length);
  let maxClaimed = nextFaceId - 1;
  originsPerGroup.forEach((origins, g) => {
    const id = chooseId(origins);
    if (id === undefined || claimed.has(id)) return;
    claimed.add(id);
    ids[g] = id;
    if (id > maxClaimed) maxClaimed = id;
  });
  let next = maxClaimed + 1;
  const faces: NormalizedFace[] = groups.map((_, g) => ({ id: ids[g] ?? next++, origins: originsPerGroup[g]! }));

  const numTri = read.tris.length / 3;
  const tris = new Uint32Array(numTri * 3);
  const faceId = new Uint32Array(numTri);
  const faceOrigin: FaceOrigin = new Map();
  let out = 0;
  groups.forEach((members, g) => {
    const face = faces[g]!;
    faceOrigin.set(
      face.id,
      face.origins.map(({ runId, faceId: f }) => ({ runId, faceId: f })),
    );
    for (const t of members) {
      tris[out * 3] = read.tris[t * 3]!;
      tris[out * 3 + 1] = read.tris[t * 3 + 1]!;
      tris[out * 3 + 2] = read.tris[t * 3 + 2]!;
      faceId[out] = face.id;
      out++;
    }
  });
  return { mesh: { verts: read.verts, tris, faceId, runId: 0 }, faceOrigin, faces, nextFaceId: next };
}
