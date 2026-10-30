// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3, MVec3 } from './vec3';
import { v3addScaled, v3dot, v3sub, v3cross, v3lenSq } from './vec3';
import type { Plane } from './plane';

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3; // unit
}
export const rayAt = (r: Ray, t: number): MVec3 => v3addScaled(r.origin, r.dir, t);

/** Returns t along the ray (>= 0) or null if parallel / behind. */
export function rayPlane(r: Ray, pl: Plane): number | null {
  const denom = v3dot(pl.n, r.dir);
  if (Math.abs(denom) < 1e-12) return null;
  const t = -(v3dot(pl.n, r.origin) + pl.d) / denom;
  return t >= 0 ? t : null;
}

/** Möller–Trumbore. Returns t or null. Back faces are hit too. */
export function rayTriangle(r: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = v3sub(b, a), e2 = v3sub(c, a);
  const p = v3cross(r.dir, e2);
  const det = v3dot(e1, p);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const tv = v3sub(r.origin, a);
  const u = v3dot(tv, p) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = v3cross(tv, e1);
  const v = v3dot(r.dir, q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = v3dot(e2, q) * inv;
  return t >= 0 ? t : null;
}

/**
 * Closest points between a ray and a segment. Returns parameters t (ray) and s (segment, clamped 0..1)
 * and the squared distance.
 */
export function raySegmentClosest(r: Ray, a: Vec3, b: Vec3): { t: number; s: number; distSq: number } {
  const d2 = v3sub(b, a);
  const w0 = v3sub(r.origin, a);
  const aa = v3dot(r.dir, r.dir), bb = v3dot(r.dir, d2), cc = v3dot(d2, d2);
  const dd = v3dot(r.dir, w0), ee = v3dot(d2, w0);
  const denom = aa * cc - bb * bb;
  let t: number, s: number;
  if (denom < 1e-14) {
    s = 0;
    t = Math.max(0, -dd / aa);
  } else {
    s = (aa * ee - bb * dd) / denom;
    s = Math.max(0, Math.min(1, s));
    t = Math.max(0, (bb * s - dd) / aa);
  }
  const p = rayAt(r, t);
  const q = v3addScaled(a, d2, s);
  return { t, s, distSq: v3lenSq(v3sub(p, q)) };
}
