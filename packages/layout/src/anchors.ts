// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { LayoutDimensionAnchor, LayoutEntity } from './LayoutDocument';
import { layoutPathSegmentIndices, pathSegment, pointOnPathSegment } from './path';

type Point = [number, number];

/** How far from a segment, in paper millimeters, a point still lies on it. */
export const SEGMENT_ANCHOR_TOL_MM = LENGTH_TOL * 1000;

/**
 * The point an anchor names on its path: a vertex, or the point at curve parameter `t` along the
 * drawn segment that starts at that vertex. Undefined when the source is not a path, its vertex count changed, or the
 * segment is not drawn.
 */
export function layoutAnchorOnPath(source: LayoutEntity, anchor: LayoutDimensionAnchor): Point | undefined {
  if (source.kind !== 'path' || source.points.length !== anchor.pointCount) return undefined;
  if (anchor.t === undefined) {
    const vertex = source.points[anchor.pointIndex];
    return vertex && [vertex[0], vertex[1]];
  }
  if (!layoutPathSegmentIndices(source).includes(anchor.pointIndex)) return undefined;
  return pointOnPathSegment(source.points, source.handles, anchor.pointIndex, source.closed, anchor.t, source.contourStarts);
}

/** The curve parameter on segment `index` nearest to `point`, and how far that point is. */
function nearestOnSegment(entity: LayoutEntity, index: number, point: Point): { t: number; distance: number } {
  const { a, b, curved } = pathSegment(entity.points, entity.handles, index, entity.closed, entity.contourStarts);
  const at = (t: number): Point => pointOnPathSegment(entity.points, entity.handles, index, entity.closed, t, entity.contourStarts);
  const dist = (t: number): number => { const p = at(t); return Math.hypot(p[0] - point[0], p[1] - point[1]); };
  if (!curved) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2)) : 0;
    return { t, distance: dist(t) };
  }
  // A cubic: sample, then narrow around the nearest sample.
  const steps = 64;
  let best = 0;
  for (let i = 1; i <= steps; i++) if (dist(i / steps) < dist(best / steps)) best = i;
  let lo = Math.max(0, (best - 1) / steps), hi = Math.min(1, (best + 1) / steps);
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist(m1) < dist(m2)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2;
  return { t, distance: dist(t) };
}

/**
 * An anchor for a point that lies on a path: its vertex when it is one, otherwise the drawn segment it lies
 * on and the curve parameter there. Null when the point is on neither.
 */
export function layoutPathAnchorAt(entity: LayoutEntity, point: Point, tolMm = SEGMENT_ANCHOR_TOL_MM): LayoutDimensionAnchor | null {
  if (entity.kind !== 'path') return null;
  const vertex = entity.points.findIndex((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) <= tolMm);
  if (vertex >= 0) return { entityId: entity.id, pointIndex: vertex, pointCount: entity.points.length };
  let found: { index: number; t: number; distance: number } | null = null;
  for (const index of layoutPathSegmentIndices(entity)) {
    const near = nearestOnSegment(entity, index, point);
    if (near.distance <= tolMm && near.t > 0 && near.t < 1 && (!found || near.distance < found.distance)) found = { index, ...near };
  }
  return found ? { entityId: entity.id, pointIndex: found.index, pointCount: entity.points.length, t: found.t } : null;
}

/**
 * Where an anchor along a segment lies and how that segment runs there: its point, the unit tangent in the
 * segment's direction, and whether the segment is curved. Null for a vertex anchor or one that does not resolve.
 */
export function layoutSegmentAnchorFrame(source: LayoutEntity, anchor: LayoutDimensionAnchor): { point: Point; tangent: Point; curved: boolean } | null {
  if (anchor.t === undefined) return null;
  const point = layoutAnchorOnPath(source, anchor);
  if (!point) return null;
  const { a, b, c1, c2, curved } = pathSegment(source.points, source.handles, anchor.pointIndex, source.closed, source.contourStarts);
  const t = anchor.t, s = 1 - t;
  const d: Point = curved
    ? [3 * s * s * (c1[0] - a[0]) + 6 * s * t * (c2[0] - c1[0]) + 3 * t * t * (b[0] - c2[0]),
      3 * s * s * (c1[1] - a[1]) + 6 * s * t * (c2[1] - c1[1]) + 3 * t * t * (b[1] - c2[1])]
    : [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(d[0], d[1]);
  return { point, tangent: len > 0 ? [d[0] / len, d[1] / len] : [0, 0], curved };
}
