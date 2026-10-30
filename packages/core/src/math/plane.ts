// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3, MVec3 } from './vec3';
import { v3cross, v3dot, v3normalize, v3sub, v3addScaled, V3_X, V3_Z, v3parallel } from './vec3';
import { ANGLE_TOL, COPLANAR_TOL } from '../tolerance';

/** Plane as unit normal n and offset d with n·p + d = 0. */
export interface Plane {
  readonly n: Vec3;
  readonly d: number;
}
export interface PlaneBasis {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
}

export function planeFromPointNormal(p: Vec3, n: Vec3): Plane {
  const un = v3normalize(n);
  return { n: un, d: -v3dot(un, p) };
}
export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = v3cross(v3sub(b, a), v3sub(c, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l === 0) return null;
  return planeFromPointNormal(a, n);
}
export const planeDistance = (pl: Plane, p: Vec3): number => v3dot(pl.n, p) + pl.d;
export const planeProject = (pl: Plane, p: Vec3): MVec3 => v3addScaled(p, pl.n, -planeDistance(pl, p));
export function planeFlip(pl: Plane): Plane {
  return { n: [-pl.n[0], -pl.n[1], -pl.n[2]], d: -pl.d };
}
export function planesCoincide(a: Plane, b: Plane, tol = COPLANAR_TOL, angTol = ANGLE_TOL): boolean {
  if (!v3parallel(a.n, b.n, angTol)) return false;
  const same = v3dot(a.n, b.n) > 0;
  return Math.abs(same ? a.d - b.d : a.d + b.d) <= tol;
}
/**
 * Deterministic in-plane basis (fixed rule): u = Z × n unless n is (anti)parallel to Z,
 * in which case u = X. v = n × u. Right-handed with n.
 */
export function planeBasis(origin: Vec3, n: Vec3): PlaneBasis {
  const un = v3normalize(n);
  let u: MVec3;
  if (v3parallel(un, V3_Z, 1e-9)) u = [V3_X[0], V3_X[1], V3_X[2]];
  else u = v3normalize(v3cross(V3_Z, un));
  const v = v3normalize(v3cross(un, u));
  return { origin, u, v, n: un };
}
export function basisToLocal(b: PlaneBasis, p: Vec3): [number, number, number] {
  const r = v3sub(p, b.origin);
  return [v3dot(r, b.u), v3dot(r, b.v), v3dot(r, b.n)];
}
export function basisToWorld(b: PlaneBasis, x: number, y: number, z = 0): MVec3 {
  return [
    b.origin[0] + b.u[0] * x + b.v[0] * y + b.n[0] * z,
    b.origin[1] + b.u[1] * x + b.v[1] * y + b.n[1] * z,
    b.origin[2] + b.u[2] * x + b.v[2] * y + b.n[2] * z,
  ];
}
