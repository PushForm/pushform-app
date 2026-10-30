// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec2, MVec3, Plane, Vec2, Vec3 } from '@pushform/core';
import { planeDistance, v3addScaled, v3cross, v3dot, v3sub } from '@pushform/core';

export type SegSeg2D =
  | { kind: 'none' }
  /** Single crossing; t along a, s along b (both in [0,1] within tolerance). */
  | { kind: 'point'; t: number; s: number; point: MVec2 }
  /** Collinear segments; `overlap` is the parameter interval of b on a (null if disjoint). */
  | { kind: 'collinear'; overlap: [number, number] | null };

/**
 * Segment/segment intersection in 2D. `tol` is a distance: endpoints within `tol` of the other
 * segment count as touching, and lines closer than `tol` are treated as collinear.
 */
export function segSegIntersect2D(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tol = 1e-9): SegSeg2D {
  const rx = a1[0] - a0[0], ry = a1[1] - a0[1];
  const qx = b1[0] - b0[0], qy = b1[1] - b0[1];
  const wx = b0[0] - a0[0], wy = b0[1] - a0[1];
  const rl = Math.hypot(rx, ry), ql = Math.hypot(qx, qy);
  const denom = rx * qy - ry * qx;
  if (rl === 0 || ql === 0) return { kind: 'none' };
  const sinAng = Math.abs(denom) / (rl * ql);
  // parallel when the angle is tiny relative to the tolerance over the segment lengths
  if (sinAng <= tol / Math.max(rl, ql)) {
    const distLine = Math.abs(wx * ry - wy * rx) / rl;
    if (distLine > tol) return { kind: 'none' };
    const t0 = (wx * rx + wy * ry) / (rl * rl);
    const t1 = ((b1[0] - a0[0]) * rx + (b1[1] - a0[1]) * ry) / (rl * rl);
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
    const tolT = tol / rl;
    return { kind: 'collinear', overlap: hi + tolT >= lo ? [Math.max(0, lo), Math.min(1, hi)] : null };
  }
  const t = (wx * qy - wy * qx) / denom;
  const s = (wx * ry - wy * rx) / denom;
  const tolT = tol / rl, tolS = tol / ql;
  if (t < -tolT || t > 1 + tolT || s < -tolS || s > 1 + tolS) return { kind: 'none' };
  const tc = Math.max(0, Math.min(1, t));
  return { kind: 'point', t: tc, s: Math.max(0, Math.min(1, s)), point: [a0[0] + rx * tc, a0[1] + ry * tc] };
}

export interface PointSegClosest2D {
  t: number;
  point: MVec2;
  distSq: number;
}
export function pointSegmentClosest2D(p: Vec2, a: Vec2, b: Vec2): PointSegClosest2D {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const q: MVec2 = [a[0] + dx * t, a[1] + dy * t];
  const ex = q[0] - p[0], ey = q[1] - p[1];
  return { t, point: q, distSq: ex * ex + ey * ey };
}

export interface PointSegClosest3D {
  t: number;
  point: MVec3;
  distSq: number;
}
export function pointSegmentClosest3D(p: Vec3, a: Vec3, b: Vec3): PointSegClosest3D {
  const d = v3sub(b, a);
  const l2 = v3dot(d, d);
  let t = l2 > 0 ? v3dot(v3sub(p, a), d) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const q = v3addScaled(a, d, t);
  const e = v3sub(q, p);
  return { t, point: q, distSq: v3dot(e, e) };
}

export interface LineLineClosest3D {
  /** Parameter on line 0 (p0 + t·d0) and line 1 (p1 + s·d1). */
  t: number;
  s: number;
  p: MVec3;
  q: MVec3;
  distSq: number;
  parallel: boolean;
}
/** Closest points between two infinite 3D lines. For parallel lines t = 0 and s is p0's projection. */
export function lineLineClosest3D(p0: Vec3, d0: Vec3, p1: Vec3, d1: Vec3): LineLineClosest3D {
  const w = v3sub(p0, p1);
  const a = v3dot(d0, d0), b = v3dot(d0, d1), c = v3dot(d1, d1);
  const d = v3dot(d0, w), e = v3dot(d1, w);
  const denom = a * c - b * b;
  let t: number, s: number, parallel = false;
  const scale = a * c;
  if (denom <= 1e-14 * (scale || 1)) {
    parallel = true;
    t = 0;
    s = c > 0 ? e / c : 0;
  } else {
    t = (b * e - c * d) / denom;
    s = (a * e - b * d) / denom;
  }
  const p = v3addScaled(p0, d0, t);
  const q = v3addScaled(p1, d1, s);
  const diff = v3sub(p, q);
  return { t, s, p, q, distSq: v3dot(diff, diff), parallel };
}

export interface SegSegClosest3D {
  t: number;
  s: number;
  p: MVec3;
  q: MVec3;
  distSq: number;
}
/** Closest points between two 3D segments (parameters clamped to [0,1]). */
export function segSegClosest3D(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): SegSegClosest3D {
  const d0 = v3sub(a1, a0), d1 = v3sub(b1, b0);
  const w = v3sub(a0, b0);
  const a = v3dot(d0, d0), b = v3dot(d0, d1), c = v3dot(d1, d1);
  const d = v3dot(d0, w), e = v3dot(d1, w);
  const denom = a * c - b * b;
  let t: number, s: number;
  if (a === 0 && c === 0) {
    const diff = v3sub(a0, b0);
    return { t: 0, s: 0, p: [a0[0], a0[1], a0[2]], q: [b0[0], b0[1], b0[2]], distSq: v3dot(diff, diff) };
  }
  if (denom <= 1e-14 * (a * c || 1)) {
    t = 0;
    s = c > 0 ? e / c : 0;
  } else {
    t = (b * e - c * d) / denom;
    s = (a * e - b * d) / denom;
  }
  // clamp t, recompute s, clamp s, recompute t
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  if (c > 0) {
    s = (b * t + e) / c;
    if (s < 0) {
      s = 0;
      t = a > 0 ? Math.max(0, Math.min(1, -d / a)) : 0;
    } else if (s > 1) {
      s = 1;
      t = a > 0 ? Math.max(0, Math.min(1, (b - d) / a)) : 0;
    }
  } else s = 0;
  const p = v3addScaled(a0, d0, t);
  const q = v3addScaled(b0, d1, s);
  const diff = v3sub(p, q);
  return { t, s, p, q, distSq: v3dot(diff, diff) };
}

/**
 * Segment/plane crossing. Returns the parameter t in [0,1] and the point, or null when the segment
 * does not reach the plane or lies in it (both endpoints within `tol`).
 */
export function segmentPlane(a: Vec3, b: Vec3, plane: Plane, tol = 0): { t: number; point: MVec3 } | null {
  const da = planeDistance(plane, a), db = planeDistance(plane, b);
  if (Math.abs(da) <= tol && Math.abs(db) <= tol) return null;
  if ((da > tol && db > tol) || (da < -tol && db < -tol)) return null;
  const denom = da - db;
  if (denom === 0) return null;
  const t = Math.max(0, Math.min(1, da / denom));
  return { t, point: v3addScaled(a, v3sub(b, a), t) };
}

/** True when the two segments span a common plane within `tol` (parallel segments are always coplanar). */
export function segmentsCoplanar(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3, tol: number): boolean {
  const n = v3cross(v3sub(a1, a0), v3sub(b1, b0));
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl === 0) return true;
  return Math.abs(v3dot(n, v3sub(b0, a0))) / nl <= tol;
}
