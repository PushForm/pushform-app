// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData, Plane, Vec3 } from '@pushform/core';
import { ANGLE_TOL, COPLANAR_TOL, LENGTH_TOL, v3cross, v3dot, v3normalize, v3parallel, v3sub } from '@pushform/core';

export interface CoplanarGroups {
  /** One face id per triangle, 0..count-1 in order of first appearance. */
  faceId: Uint32Array;
  /** Plane per face id (area-weighted normal, centroid offset). */
  planes: Plane[];
  count: number;
}
export interface CoplanarOptions {
  /** Point-to-plane distance tolerance. Default COPLANAR_TOL. */
  tol?: number;
  /** Normal angle tolerance (radians). Default ANGLE_TOL. */
  angTol?: number;
  /** Vertex welding tolerance for meshes with duplicated positions. Default LENGTH_TOL. */
  weldTol?: number;
}

/** Weld vertex positions into canonical indices by grid rounding. */
export function weldVertices(verts: Float64Array, tol = LENGTH_TOL): Int32Array {
  const n = verts.length / 3;
  const map = new Map<string, number>();
  const canon = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(verts[i * 3]! / tol)},${Math.round(verts[i * 3 + 1]! / tol)},${Math.round(verts[i * 3 + 2]! / tol)}`;
    const e = map.get(k);
    if (e === undefined) {
      map.set(k, i);
      canon[i] = i;
    } else canon[i] = e;
  }
  return canon;
}

/**
 * Group triangles into coplanar, edge-adjacent sets (the face rule: non-adjacent coplanar
 * triangles stay separate faces). Returns a faceId per triangle and one plane per face.
 */
export function groupCoplanarFaces(mesh: MeshData, opts: CoplanarOptions = {}): CoplanarGroups {
  const tol = opts.tol ?? COPLANAR_TOL;
  const angTol = opts.angTol ?? ANGLE_TOL;
  const canon = weldVertices(mesh.verts, opts.weldTol ?? LENGTH_TOL);
  const triCount = mesh.tris.length / 3;
  const vertCount = mesh.verts.length / 3;
  const p = mesh.verts, t = mesh.tris;

  // per-triangle unit normal (scaled by 2*area) and a point on it
  const normals = new Float64Array(triCount * 3);
  const areas = new Float64Array(triCount);
  for (let i = 0; i < triCount; i++) {
    const a = t[i * 3]! * 3, b = t[i * 3 + 1]! * 3, c = t[i * 3 + 2]! * 3;
    const e1: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n = v3cross(e1, e2);
    const l = Math.hypot(n[0], n[1], n[2]);
    areas[i] = l / 2;
    if (l > 0) {
      normals[i * 3] = n[0] / l;
      normals[i * 3 + 1] = n[1] / l;
      normals[i * 3 + 2] = n[2] / l;
    }
  }
  const triNormal = (i: number): Vec3 => [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!];
  const triVertex = (i: number, k: number): Vec3 => {
    const v = t[i * 3 + k]! * 3;
    return [p[v]!, p[v + 1]!, p[v + 2]!];
  };
  const coplanar = (i: number, j: number): boolean => {
    if (areas[i] === 0 || areas[j] === 0) return false;
    const ni = triNormal(i), nj = triNormal(j);
    if (!v3parallel(ni, nj, angTol) || v3dot(ni, nj) < 0) return false;
    const a = triVertex(i, 0);
    for (let k = 0; k < 3; k++) {
      if (Math.abs(v3dot(ni, v3sub(triVertex(j, k), a))) > tol) return false;
    }
    return true;
  };

  // union-find over triangles
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  // directed edge map: key(min,max) -> triangles
  const edgeTris = new Map<number, number[]>();
  for (let i = 0; i < triCount; i++) {
    for (let k = 0; k < 3; k++) {
      const u = canon[t[i * 3 + k]!]!, v = canon[t[i * 3 + ((k + 1) % 3)]!]!;
      if (u === v) continue;
      const key = (u < v ? u : v) * vertCount + (u < v ? v : u);
      const list = edgeTris.get(key);
      if (list) list.push(i);
      else edgeTris.set(key, [i]);
    }
  }
  for (const list of edgeTris.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x]!, j = list[y]!;
        const ri = find(i), rj = find(j);
        if (ri !== rj && coplanar(i, j)) parent[ri] = rj;
      }
    }
  }

  const faceId = new Uint32Array(triCount);
  const idOfRoot = new Map<number, number>();
  const sumN: number[][] = [], sumC: number[][] = [], sumA: number[] = [];
  for (let i = 0; i < triCount; i++) {
    const r = find(i);
    let id = idOfRoot.get(r);
    if (id === undefined) {
      id = idOfRoot.size;
      idOfRoot.set(r, id);
      sumN.push([0, 0, 0]);
      sumC.push([0, 0, 0]);
      sumA.push(0);
    }
    faceId[i] = id;
    const a = areas[i]!;
    const n = triNormal(i);
    const sn = sumN[id]!, sc = sumC[id]!;
    sn[0]! += n[0] * a;
    sn[1]! += n[1] * a;
    sn[2]! += n[2] * a;
    for (let k = 0; k < 3; k++) {
      const v = triVertex(i, k);
      sc[0]! += (v[0] * a) / 3;
      sc[1]! += (v[1] * a) / 3;
      sc[2]! += (v[2] * a) / 3;
    }
    sumA[id]! += a;
  }
  const planes: Plane[] = sumN.map((sn, id) => {
    const a = sumA[id]! || 1;
    const n = v3normalize([sn[0]!, sn[1]!, sn[2]!]);
    const c: Vec3 = [sumC[id]![0]! / a, sumC[id]![1]! / a, sumC[id]![2]! / a];
    return { n, d: -v3dot(n, c) };
  });
  return { faceId, planes, count: planes.length };
}

/** Plane of a triangle group from a mesh's existing faceId array (area-weighted). */
export function facePlanesFromMesh(mesh: MeshData): Map<number, Plane> {
  const out = new Map<number, Plane>();
  const acc = new Map<number, { n: [number, number, number]; c: [number, number, number]; a: number }>();
  const p = mesh.verts, t = mesh.tris;
  for (let i = 0; i < mesh.faceId.length; i++) {
    const a = t[i * 3]! * 3, b = t[i * 3 + 1]! * 3, c = t[i * 3 + 2]! * 3;
    const e1: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n = v3cross(e1, e2);
    const area2 = Math.hypot(n[0], n[1], n[2]);
    const id = mesh.faceId[i]!;
    let e = acc.get(id);
    if (!e) {
      e = { n: [0, 0, 0], c: [0, 0, 0], a: 0 };
      acc.set(id, e);
    }
    e.n[0] += n[0] / 2;
    e.n[1] += n[1] / 2;
    e.n[2] += n[2] / 2;
    const w = area2 / 6;
    e.c[0] += (p[a]! + p[b]! + p[c]!) * w;
    e.c[1] += (p[a + 1]! + p[b + 1]! + p[c + 1]!) * w;
    e.c[2] += (p[a + 2]! + p[b + 2]! + p[c + 2]!) * w;
    e.a += area2 / 2;
  }
  for (const [id, e] of acc) {
    const n = v3normalize(e.n);
    const a = e.a || 1;
    const c: Vec3 = [e.c[0] / a, e.c[1] / a, e.c[2] / a];
    out.set(id, { n, d: -v3dot(n, c) });
  }
  return out;
}
