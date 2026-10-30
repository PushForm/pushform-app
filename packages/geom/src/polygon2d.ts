// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec2, Vec2 } from '@pushform/core';

/** A ring of [x, y] points (implicitly closed; the last point is not repeated). */
export type Ring = number[][];
/**
 * One polygon with holes: `[outer, ...holes]`, each ring a list of `[x, y]` points.
 * Normalized form: outer CCW (positive area), holes CW (negative area).
 */
export type PolygonsWithHoles = number[][][];

export interface Bounds2 {
  min: MVec2;
  max: MVec2;
}

/** Shoelace signed area: positive for CCW rings. */
export function signedArea(ring: ArrayLike<ArrayLike<number>>): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = ring[i]!, q = ring[j]!;
    a += (q[0]! + p[0]!) * (q[1]! - p[1]!);
  }
  return -a / 2;
}

export const isCCW = (ring: ArrayLike<ArrayLike<number>>): boolean => signedArea(ring) > 0;

export function reverseRing(ring: Ring): Ring {
  return ring.slice().reverse();
}

/** Returns a copy with the outer ring CCW and all holes CW. Degenerate (zero-area) rings are kept as-is. */
export function normalizePolygon(poly: PolygonsWithHoles): PolygonsWithHoles {
  return poly.map((ring, i) => {
    const a = signedArea(ring);
    const wantCCW = i === 0;
    if (a === 0) return ring.map((p) => [p[0]!, p[1]!]);
    return (a > 0) === wantCCW ? ring.map((p) => [p[0]!, p[1]!]) : reverseRing(ring).map((p) => [p[0]!, p[1]!]);
  });
}

/** Even-odd crossing test. Points on the boundary are not reliably classified; use `pointOnRing` first. */
export function pointInRing(p: Vec2, ring: ArrayLike<ArrayLike<number>>): boolean {
  const x = p[0], y = p[1];
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    if (yi > y !== yj > y) {
      const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** True if p lies within `tol` of any ring segment. */
export function pointOnRing(p: Vec2, ring: ArrayLike<ArrayLike<number>>, tol: number): boolean {
  const n = ring.length;
  const t2 = tol * tol;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j]![0]!, ay = ring[j]![1]!;
    const bx = ring[i]![0]!, by = ring[i]![1]!;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t - p[0], qy = ay + dy * t - p[1];
    if (qx * qx + qy * qy <= t2) return true;
  }
  return false;
}

/** Inside the outer ring and outside every hole (even-odd). */
export function pointInPolygon(p: Vec2, poly: PolygonsWithHoles): boolean {
  const outer = poly[0];
  if (!outer || !pointInRing(p, outer)) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(p, poly[i]!)) return false;
  return true;
}

export function ringBounds(ring: ArrayLike<ArrayLike<number>>): Bounds2 {
  const b: Bounds2 = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const x = p[0]!, y = p[1]!;
    if (x < b.min[0]) b.min[0] = x;
    if (x > b.max[0]) b.max[0] = x;
    if (y < b.min[1]) b.min[1] = y;
    if (y > b.max[1]) b.max[1] = y;
  }
  return b;
}

/** Bounds of the outer ring (holes are inside it by definition). */
export function polygonBounds(poly: PolygonsWithHoles): Bounds2 {
  const outer = poly[0];
  return outer ? ringBounds(outer) : { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
}

/** |outer| − Σ|holes|. */
export function polygonArea(poly: PolygonsWithHoles): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const r = Math.abs(signedArea(poly[i]!));
    a += i === 0 ? r : -r;
  }
  return a;
}

export function ringCentroid(ring: ArrayLike<ArrayLike<number>>): MVec2 {
  const n = ring.length;
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = ring[j]!, q = ring[i]!;
    const cross = p[0]! * q[1]! - q[0]! * p[1]!;
    a += cross;
    cx += (p[0]! + q[0]!) * cross;
    cy += (p[1]! + q[1]!) * cross;
  }
  if (Math.abs(a) < 1e-300) {
    // degenerate: average of points
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i]![0]!;
      sy += ring[i]![1]!;
    }
    return n ? [sx / n, sy / n] : [0, 0];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Drops consecutive points closer than `tol` (including the closing pair). */
export function dedupeRing(ring: ArrayLike<ArrayLike<number>>, tol: number): Ring {
  const out: Ring = [];
  const t2 = tol * tol;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const last = out[out.length - 1];
    if (last) {
      const dx = p[0]! - last[0]!, dy = p[1]! - last[1]!;
      if (dx * dx + dy * dy <= t2) continue;
    }
    out.push([p[0]!, p[1]!]);
  }
  if (out.length > 1) {
    const a = out[0]!, b = out[out.length - 1]!;
    const dx = a[0]! - b[0]!, dy = a[1]! - b[1]!;
    if (dx * dx + dy * dy <= t2) out.pop();
  }
  return out;
}

/** Polygon offset; implemented in `offset.ts` (re-exported here for the original stub's import path). */
export { offsetPolygon } from './offset';
