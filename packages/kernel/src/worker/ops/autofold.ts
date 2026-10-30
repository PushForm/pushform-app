// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Autofold: the model has already displaced vertices, folded
 * non-planar faces and re-triangulated. The kernel only validates and normalizes:
 *  1. `new Manifold(mesh)` must report NoError (closed, consistently oriented 2-manifold);
 *  2. no two non-adjacent triangles may intersect (BVH-accelerated tri/tri test);
 *  3. finalize (normalize / simplify / decompose / properties) keeping the input face ids.
 * Rejections are `KernelError('ManifoldError')` with `details.reason` = 'NotManifold' | 'SelfIntersecting'.
 */
import { COPLANAR_TOL, type Vec3 } from '@pushform/core';
import { buildTriBVH, queryBVHBox } from '@pushform/geom';
import type { AutofoldRequest, ComponentsResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { tryManifoldFromSoup, type TriangleSoup } from '../meshio';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

export type AutofoldRejection = 'NotManifold' | 'SelfIntersecting';

/** Validate the folded mesh and normalize it; throws `ManifoldError` with `details.reason` on rejection. */
export function autofold(ctx: KernelContext, req: AutofoldRequest): ComponentsResult {
  const mesh = req.mesh;
  if (mesh.tris.length === 0 || mesh.tris.length % 3 !== 0 || mesh.faceId.length !== mesh.tris.length / 3) {
    throw new KernelError('InvalidInput', 'autofold.mesh must hold at least one triangle and one faceId per triangle');
  }
  const runId = ctx.wasm.Manifold.reserveIDs(1);
  const r = tryManifoldFromSoup(ctx.wasm, mesh, runId);
  if (r.manifold === undefined) {
    throw new KernelError('ManifoldError', `Would create an invalid solid (${r.status})`, {
      reason: 'NotManifold' satisfies AutofoldRejection,
      status: r.status,
    });
  }
  try {
    const hit = meshSelfIntersection(mesh);
    if (hit !== null) {
      throw new KernelError('ManifoldError', 'Would create a self-intersecting solid', {
        reason: 'SelfIntersecting' satisfies AutofoldRejection,
        status: 'NoError',
        triangles: hit,
      });
    }
    const fin = finalizeManifold(ctx, r.manifold, { nextFaceId: req.nextFaceId, chooseId: keepIdsFromRuns(new Set([runId])) });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  } finally {
    r.manifold.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// Self-intersection test

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Parameter interval of the triangle's crossing with the other triangle's plane, along axis `ax`.
 * `d` holds the signed plane distances; at least one is > tol and one < -tol.
 */
function crossingInterval(p: readonly Vec3[], d: readonly number[], ax: number, tol: number): [number, number] {
  const pos = d.filter((x) => x > tol).length;
  const neg = d.filter((x) => x < -tol).length;
  const isolated = pos === 1 ? d.findIndex((x) => x > tol) : neg === 1 ? d.findIndex((x) => x < -tol) : d.findIndex((x) => x > tol);
  const a = isolated, b = (isolated + 1) % 3, c = (isolated + 2) % 3;
  const pa = p[a]![ax]!, da = d[a]!;
  const at = (k: number): number => {
    const dk = d[k]!, pk = p[k]![ax]!;
    const denom = da - dk;
    return Math.abs(denom) < 1e-300 ? pk : pa + ((pk - pa) * da) / denom;
  };
  const t1 = at(b), t2 = at(c);
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/** Möller's tri/tri test with a tolerance: touching within `tol` does not count. Coplanar pairs are ignored. */
export function trianglesIntersect(p: readonly Vec3[], q: readonly Vec3[], tol = COPLANAR_TOL): boolean {
  const n1 = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!));
  const l1 = Math.hypot(n1[0], n1[1], n1[2]);
  if (l1 === 0) return false;
  const u1: Vec3 = [n1[0] / l1, n1[1] / l1, n1[2] / l1];
  const dq = q.map((v) => dot(u1, sub(v, p[0]!)));
  if (Math.max(...dq) <= tol || Math.min(...dq) >= -tol) return false;

  const n2 = cross(sub(q[1]!, q[0]!), sub(q[2]!, q[0]!));
  const l2 = Math.hypot(n2[0], n2[1], n2[2]);
  if (l2 === 0) return false;
  const u2: Vec3 = [n2[0] / l2, n2[1] / l2, n2[2] / l2];
  const dp = p.map((v) => dot(u2, sub(v, q[0]!)));
  if (Math.max(...dp) <= tol || Math.min(...dp) >= -tol) return false;

  const dir = cross(u1, u2);
  const ax = Math.abs(dir[0]) >= Math.abs(dir[1]) && Math.abs(dir[0]) >= Math.abs(dir[2]) ? 0 : Math.abs(dir[1]) >= Math.abs(dir[2]) ? 1 : 2;
  const ip = crossingInterval(p, dp, ax, tol);
  const iq = crossingInterval(q, dq, ax, tol);
  const overlap = Math.min(ip[1], iq[1]) - Math.max(ip[0], iq[0]);
  // The axis projection shrinks the overlap by |dir[ax]| / |dir| (dir is unit-ish for near-perpendicular planes).
  const scale = Math.abs(dir[ax]!) / Math.max(Math.hypot(dir[0], dir[1], dir[2]), 1e-300);
  return overlap / Math.max(scale, 1e-300) > tol;
}

/**
 * First pair of non-adjacent (no shared vertex index) triangles that intersect, or null. The mesh
 * must share vertices by index for adjacency to be meaningful.
 */
export function meshSelfIntersection(mesh: TriangleSoup, tol = COPLANAR_TOL): [number, number] | null {
  const bvh = buildTriBVH({ verts: mesh.verts, tris: mesh.tris, faceId: mesh.faceId });
  const T = mesh.tris, P = mesh.verts;
  const numTri = T.length / 3;
  const point = (v: number): Vec3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  for (let i = 0; i < numTri; i++) {
    const ia = T[i * 3]!, ib = T[i * 3 + 1]!, ic = T[i * 3 + 2]!;
    const pb = bvh.primBounds;
    const min: Vec3 = [pb[i * 6]! - tol, pb[i * 6 + 1]! - tol, pb[i * 6 + 2]! - tol];
    const max: Vec3 = [pb[i * 6 + 3]! + tol, pb[i * 6 + 4]! + tol, pb[i * 6 + 5]! + tol];
    const p = [point(ia), point(ib), point(ic)];
    for (const j of queryBVHBox(bvh, min, max)) {
      if (j <= i) continue;
      const ja = T[j * 3]!, jb = T[j * 3 + 1]!, jc = T[j * 3 + 2]!;
      if (ja === ia || ja === ib || ja === ic || jb === ia || jb === ib || jb === ic || jc === ia || jc === ib || jc === ic) continue;
      if (trianglesIntersect(p, [point(ja), point(jb), point(jc)], tol)) return [i, j];
    }
  }
  return null;
}
