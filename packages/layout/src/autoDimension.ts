// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { LayoutDimensionAnchor, LayoutEntity } from './LayoutDocument';
import { layoutPathSegmentIndices, nextLayoutPathIndex, pathSegment } from './path';
type Point = [number, number];

interface Span { entity: LayoutEntity; start: number; end: number; startIndex: number; endIndex: number }
interface Extreme { t: number; entity: LayoutEntity; index: number }

/**
 * The two vertices furthest apart along the chain of coincident straight segments through the picked one:
 * the picked path's own collinear joined segments plus overlapping or touching collinear segments of other candidates.
 */
export function autoDimensionExtent(source: LayoutEntity, segmentIndex: number, candidates: readonly LayoutEntity[]):
  { points: [Point, Point]; anchors: [LayoutDimensionAnchor, LayoutDimensionAnchor] } | null {
  if (source.kind !== 'path' || segmentIndex < 0 || segmentIndex >= source.points.length - (source.closed ? 0 : 1)) return null;
  const seed = pathSegment(source.points, source.handles, segmentIndex, source.closed, source.contourStarts);
  const length = Math.hypot(seed.b[0] - seed.a[0], seed.b[1] - seed.a[1]);
  if (seed.curved || !Number.isFinite(length) || length < LENGTH_TOL) return null;
  const origin = seed.a, u: Point = [(seed.b[0] - origin[0]) / length, (seed.b[1] - origin[1]) / length];
  const along = (p: Point): number => (p[0] - origin[0]) * u[0] + (p[1] - origin[1]) * u[1];
  const offLine = (p: Point): number => Math.abs((p[0] - origin[0]) * u[1] - (p[1] - origin[1]) * u[0]);
  const spans = new Set<Span>();
  for (const entity of [source, ...candidates.filter((candidate) => candidate.id !== source.id)]) {
    if (entity.kind !== 'path') continue;
    for (const index of layoutPathSegmentIndices(entity)) {
      const segment = pathSegment(entity.points, entity.handles, index, entity.closed, entity.contourStarts);
      if (segment.curved || offLine(segment.a) > LENGTH_TOL || offLine(segment.b) > LENGTH_TOL) continue;
      const next = nextLayoutPathIndex(entity.points.length, index, entity.contourStarts), ta = along(segment.a), tb = along(segment.b);
      spans.add(ta <= tb ? { entity, start: ta, end: tb, startIndex: index, endIndex: next }
        : { entity, start: tb, end: ta, startIndex: next, endIndex: index });
    }
  }
  let low: Extreme = { t: 0, entity: source, index: segmentIndex };
  let high: Extreme = { t: length, entity: source, index: (segmentIndex + 1) % source.points.length };
  // Absorb every span that touches the growing extent until nothing more connects.
  for (let grew = true; grew;) {
    grew = false;
    for (const span of spans) {
      if (span.end < low.t - LENGTH_TOL || span.start > high.t + LENGTH_TOL) continue;
      spans.delete(span);
      if (span.start < low.t) { low = { t: span.start, entity: span.entity, index: span.startIndex }; grew = true; }
      if (span.end > high.t) { high = { t: span.end, entity: span.entity, index: span.endIndex }; grew = true; }
    }
  }
  const vertex = (end: Extreme): Point => [...end.entity.points[end.index]!] as Point;
  const anchor = (end: Extreme): LayoutDimensionAnchor => ({ entityId: end.entity.id, pointIndex: end.index, pointCount: end.entity.points.length });
  return { points: [vertex(low), vertex(high)], anchors: [anchor(low), anchor(high)] };
}
