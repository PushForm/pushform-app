// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, Vec3 } from './math/vec3';
import { box3Empty, box3Expand, type Box3 } from './math/box3';

/**
 * Canonical immutable triangle mesh shared by kernel, model, render and io.
 * - `verts`: Float64Array, 3 per vertex, model units (meters).
 * - `tris`: Uint32Array, 3 vertex indices per triangle, CCW = outward.
 * - `faceId`: Uint32Array, one FaceLocalId per triangle (coplanar, edge-connected groups).
 * Treat as immutable after creation; replace the whole object to change a body's mesh.
 */
export interface MeshData {
  readonly verts: Float64Array;
  readonly tris: Uint32Array;
  readonly faceId: Uint32Array;
}

export const meshVertexCount = (m: MeshData): number => m.verts.length / 3;
export const meshTriangleCount = (m: MeshData): number => m.tris.length / 3;

export function meshVertex(m: MeshData, i: number): MVec3 {
  return [m.verts[i * 3]!, m.verts[i * 3 + 1]!, m.verts[i * 3 + 2]!];
}

export function meshBounds(m: MeshData): Box3 {
  const b = box3Empty();
  for (let i = 0; i < m.verts.length; i += 3) {
    box3Expand(b, [m.verts[i]!, m.verts[i + 1]!, m.verts[i + 2]!]);
  }
  return b;
}

/** Signed volume via divergence theorem; positive for outward-facing CCW triangles. */
export function meshSignedVolume(m: MeshData): number {
  let v = 0;
  const p = m.verts, t = m.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function meshTriangleNormal(m: MeshData, tri: number): MVec3 {
  const t = m.tris, p = m.verts;
  const a = t[tri * 3]! * 3, b = t[tri * 3 + 1]! * 3, c = t[tri * 3 + 2]! * 3;
  const e1: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
  const e2: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
  const n: MVec3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l > 0) {
    n[0] /= l;
    n[1] /= l;
    n[2] /= l;
  }
  return n;
}

/** Copy a mesh (typed arrays are copied so the result can be transferred to a worker). */
export function meshClone(m: MeshData): MeshData {
  return { verts: new Float64Array(m.verts), tris: new Uint32Array(m.tris), faceId: new Uint32Array(m.faceId) };
}

/** Build a box mesh (12 triangles, 6 faces with ids 0..5) for tests and fixtures. */
export function meshBox(min: Vec3, max: Vec3): MeshData {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const verts = new Float64Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // 0-3 bottom
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // 4-7 top
  ]);
  // faces: 0 -z, 1 +z, 2 -y, 3 +x, 4 +y, 5 -x (outward CCW)
  const tris = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // -y
    1, 2, 6, 1, 6, 5, // +x
    2, 3, 7, 2, 7, 6, // +y
    3, 0, 4, 3, 4, 7, // -x
  ]);
  const faceId = new Uint32Array([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  return { verts, tris, faceId };
}
