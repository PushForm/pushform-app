// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export type Vec3 = readonly [number, number, number];
export type MVec3 = [number, number, number];

export const v3 = (x: number, y: number, z: number): MVec3 => [x, y, z];
export const V3_ZERO: Vec3 = [0, 0, 0];
export const V3_X: Vec3 = [1, 0, 0];
export const V3_Y: Vec3 = [0, 1, 0];
export const V3_Z: Vec3 = [0, 0, 1];

export const v3add = (a: Vec3, b: Vec3): MVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Vec3, b: Vec3): MVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: Vec3, s: number): MVec3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3addScaled = (a: Vec3, b: Vec3, s: number): MVec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];
export const v3neg = (a: Vec3): MVec3 => [-a[0], -a[1], -a[2]];
export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Vec3, b: Vec3): MVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3lenSq = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const v3dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const v3distSq = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0],
    dy = a[1] - b[1],
    dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};
export const v3normalize = (a: Vec3): MVec3 => {
  const l = v3len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const v3lerp = (a: Vec3, b: Vec3, t: number): MVec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const v3eq = (a: Vec3, b: Vec3, tol = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
export const v3min = (a: Vec3, b: Vec3): MVec3 => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
];
export const v3max = (a: Vec3, b: Vec3): MVec3 => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.max(a[2], b[2]),
];
export const v3abs = (a: Vec3): MVec3 => [Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2])];
export const v3clone = (a: Vec3): MVec3 => [a[0], a[1], a[2]];
/** Angle between two vectors in radians, robust near 0 and π. */
export function v3angle(a: Vec3, b: Vec3): number {
  const c = v3cross(a, b);
  return Math.atan2(v3len(c), v3dot(a, b));
}
/** True if a and b are parallel (either direction) within the angular tolerance. */
export function v3parallel(a: Vec3, b: Vec3, tol: number): boolean {
  const ang = v3angle(a, b);
  return ang <= tol || Math.PI - ang <= tol;
}
/** Any unit vector perpendicular to n. */
export function v3anyPerpendicular(n: Vec3): MVec3 {
  const ax = Math.abs(n[0]),
    ay = Math.abs(n[1]),
    az = Math.abs(n[2]);
  const helper: Vec3 = ax <= ay && ax <= az ? V3_X : ay <= az ? V3_Y : V3_Z;
  return v3normalize(v3cross(n, helper));
}
