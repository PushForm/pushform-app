// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, Vec3 } from '@pushform/core';
import { basisToWorld, planeBasis, v3cross, v3dist, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';

export type CurveKind = 'circle' | 'arc' | 'polygon';

/** Geometric description of a tessellated curve; angles are measured from the plane basis u axis. */
export interface Curve {
  kind: CurveKind;
  center: Vec3;
  normal: Vec3;
  radius: number;
  startAngle: number;
  endAngle: number;
  segments: number;
}
export interface Tessellation {
  points: MVec3[];
  curve: Curve;
}

function pointAt(c: Curve, angle: number): MVec3 {
  const b = planeBasis(c.center, c.normal);
  return basisToWorld(b, Math.cos(angle) * c.radius, Math.sin(angle) * c.radius);
}

/** Points of a curve: `segments` points for a full circle/polygon (closed, no repeat), `segments+1` for an arc. */
export function tessellateCurve(c: Curve): MVec3[] {
  const closed = c.kind !== 'arc';
  const sweep = closed ? Math.PI * 2 : c.endAngle - c.startAngle;
  const count = closed ? c.segments : c.segments + 1;
  const pts: MVec3[] = [];
  for (let i = 0; i < count; i++) pts.push(pointAt(c, c.startAngle + (sweep * i) / c.segments));
  return pts;
}

/** Full circle; default 24 segments. */
export function tessellateCircle(center: Vec3, normal: Vec3, radius: number, segments = 24, startAngle = 0): Tessellation {
  const curve: Curve = {
    kind: 'circle',
    center: [center[0], center[1], center[2]],
    normal: v3normalize(normal),
    radius,
    startAngle,
    endAngle: startAngle + Math.PI * 2,
    segments: Math.max(3, Math.round(segments)),
  };
  return { points: tessellateCurve(curve), curve };
}

/** Regular polygon inscribed in the circle of `radius` (Polygon tool). */
export function tessellatePolygon(center: Vec3, normal: Vec3, radius: number, sides = 6, startAngle = 0): Tessellation {
  const t = tessellateCircle(center, normal, radius, sides, startAngle);
  t.curve.kind = 'polygon';
  return t;
}

/** Arc by center/normal/radius and angle range (CCW about the normal). */
export function tessellateArc(
  center: Vec3,
  normal: Vec3,
  radius: number,
  startAngle: number,
  endAngle: number,
  segments = 12,
): Tessellation {
  const curve: Curve = {
    kind: 'arc',
    center: [center[0], center[1], center[2]],
    normal: v3normalize(normal),
    radius,
    startAngle,
    endAngle,
    segments: Math.max(1, Math.round(segments)),
  };
  return { points: tessellateCurve(curve), curve };
}

function angleInBasis(center: Vec3, normal: Vec3, p: Vec3): number {
  const b = planeBasis(center, normal);
  const r = v3sub(p, center);
  return Math.atan2(v3dot(r, b.v), v3dot(r, b.u));
}

/** Arc from a through b to c (3-point arc tool). Returns null for collinear points. */
export function arcFrom3Points(a: Vec3, b: Vec3, c: Vec3, segments = 12): Tessellation | null {
  const ab = v3sub(b, a), ac = v3sub(c, a);
  const n = v3cross(ab, ac);
  const nl = v3len(n);
  if (nl === 0) return null;
  // circumcenter
  const abl = v3dot(ab, ab), acl = v3dot(ac, ac);
  const t1 = v3cross(n, ab), t2 = v3cross(ac, n);
  const inv = 1 / (2 * nl * nl);
  const center: MVec3 = [
    a[0] + (t1[0] * acl + t2[0] * abl) * inv,
    a[1] + (t1[1] * acl + t2[1] * abl) * inv,
    a[2] + (t1[2] * acl + t2[2] * abl) * inv,
  ];
  const normal = v3normalize(n); // a→b→c is CCW about this normal
  const radius = v3dist(center, a);
  const start = angleInBasis(center, normal, a);
  let sweep = angleInBasis(center, normal, c) - start;
  while (sweep <= 0) sweep += Math.PI * 2;
  return tessellateArc(center, normal, radius, start, start + sweep, segments);
}

/**
 * Two-point arc with bulge (DXF convention): bulge = tan(θ/4), positive = CCW about `normal`
 * from a to b. Returns null for zero bulge (a straight segment).
 */
export function arcFromBulge(a: Vec3, b: Vec3, bulge: number, normal: Vec3, segments = 12): Tessellation | null {
  if (bulge === 0) return null;
  const n = v3normalize(normal);
  const chord = v3sub(b, a);
  const d = v3len(chord);
  if (d === 0) return null;
  const theta = 4 * Math.atan(bulge); // signed sweep
  const radius = Math.abs(d / (2 * Math.sin(theta / 2)));
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  // perpendicular to chord in plane, to the left of a→b (CCW side)
  const left = v3normalize(v3cross(n, chord));
  const h = (d / 2) / Math.tan(theta / 2); // signed distance from chord mid to center along `left`
  const center: MVec3 = [mid[0] + left[0] * h, mid[1] + left[1] * h, mid[2] + left[2] * h];
  const start = angleInBasis(center, n, a);
  return tessellateArc(center, n, radius, start, start + theta, segments);
}
