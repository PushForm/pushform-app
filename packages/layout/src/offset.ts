// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LAYOUT_CURVE_TOL } from '@pushform/core';
import type { LayoutEntity } from './LayoutDocument';
import { isSimpleLayoutLoop, pathSegment, pointInsideLayoutPath } from './path';
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];
type Source = Pick<LayoutEntity, 'points' | 'handles' | 'closed' | 'contourStarts'>;
const EPS = 1e-8;
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const area = (points: Point[]) => points.reduce((sum, p, i) => sum + cross(p, points[(i + 1) % points.length]!), 0) / 2;

/** Tessellate curved sources to within 0.01 mm of their control hull; keep straight corners exact. */
export function layoutOffsetBoundary(source: Source): Point[] {
  if (source.contourStarts) throw new Error('Choose a single-contour path to offset.');
  if (source.points.length < 2 || !source.points.every(p => p.every(Number.isFinite))) throw new Error('Choose a valid path.');
  const points: Point[] = [[...source.points[0]!]];
  function curve(a: Point, b: Point, c: Point, d: Point, depth = 0): void {
    if (![a, b, c, d].every(p => p.every(Number.isFinite))) throw new Error('Invalid curve controls.');
    const chord = sub(d, a), length = Math.hypot(...chord);
    const flatness = length < EPS ? Math.max(Math.hypot(...sub(b, a)), Math.hypot(...sub(c, a)))
      : Math.max(Math.abs(cross(chord, sub(b, a))), Math.abs(cross(chord, sub(c, a)))) / length;
    const excess = Math.hypot(...sub(b, a)) + Math.hypot(...sub(c, b)) + Math.hypot(...sub(d, c)) - length;
    if (flatness <= LAYOUT_CURVE_TOL * 1000 && excess <= LAYOUT_CURVE_TOL * 1000) { points.push([...d]); return; }
    if (depth >= 16 || points.length > 2048) throw new Error('Path is too complex to offset.');
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), mid = midpoint(abc, bcd);
    curve(a, ab, abc, mid, depth + 1); curve(mid, bcd, cd, d, depth + 1);
  }
  for (let i = 0; i < source.points.length - (source.closed ? 0 : 1); i++) {
    const segment = pathSegment(source.points, source.handles, i, source.closed);
    if (segment.curved) curve(segment.a, segment.c1, segment.c2, segment.b);
    else points.push([...segment.b]);
  }
  if (source.closed) points.pop();
  // Curved rectangle factories can contain coincident tangent points.
  const boundary = points.filter((p, i) => i === 0 || Math.hypot(...sub(p, points[i - 1]!)) > EPS);
  if (boundary.length < (source.closed ? 3 : 2)) throw new Error('Choose a non-degenerate path.');
  if (boundary.length > 2048) throw new Error('Path is too complex to offset.');
  return boundary;
}

function simpleOpenPath(points: Point[]): boolean {
  const on = (a: Point, b: Point, p: Point) => Math.abs(cross(sub(b, a), sub(p, a))) < EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    if (Math.hypot(...sub(b, a)) < EPS) return false;
    for (let j = i + 2; j < points.length - 1; j++) {
      const c = points[j]!, d = points[j + 1]!;
      if ((cross(sub(b, a), sub(c, a)) * cross(sub(b, a), sub(d, a)) < 0 &&
        cross(sub(d, c), sub(a, c)) * cross(sub(d, c), sub(b, c)) < 0) ||
        on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return false;
    }
  }
  return true;
}

/** Positive distance expands closed paths; for open paths it moves to the directed path's left. */
export function createLayoutOffset(source: Source, distanceMm: number): LayoutRectanglePath {
  if (!Number.isFinite(distanceMm) || Math.abs(distanceMm) < 1e-6) throw new Error('Enter a non-zero offset distance.');
  const boundary = layoutOffsetBoundary(source), closed = source.closed;
  if (closed ? !isSimpleLayoutLoop(boundary) : !simpleOpenPath(boundary)) throw new Error('Offset requires a simple path without crossings.');
  const side = closed ? -Math.sign(area(boundary)) * distanceMm : distanceMm;
  const count = boundary.length - (closed ? 0 : 1);
  const edges = Array.from({ length: count }, (_, i) => {
    const a = boundary[i]!, b = boundary[(i + 1) % boundary.length]!, v = sub(b, a), length = Math.hypot(...v);
    const direction: Point = [v[0] / length, v[1] / length];
    const normal: Point = [-direction[1] * side, direction[0] * side];
    return { direction, start: [a[0] + normal[0], a[1] + normal[1]] as Point, end: [b[0] + normal[0], b[1] + normal[1]] as Point };
  });
  let points: Point[] = boundary.map((p, i) => {
    if (!closed && i === 0) return edges[0]!.start;
    if (!closed && i === boundary.length - 1) return edges.at(-1)!.end;
    const previous = edges[(i - 1 + edges.length) % edges.length]!, next = edges[i]!;
    const denominator = cross(previous.direction, next.direction);
    if (Math.abs(denominator) < EPS) {
      if (previous.direction[0] * next.direction[0] + previous.direction[1] * next.direction[1] < 0) throw new Error('Cannot offset a path that doubles back.');
      return next.start;
    }
    const t = cross(sub(next.start, previous.end), next.direction) / denominator;
    const intersection: Point = [previous.end[0] + t * previous.direction[0], previous.end[1] + t * previous.direction[1]];
    if (!intersection.every(Number.isFinite) || Math.hypot(...sub(intersection, p)) > Math.abs(distanceMm) * 100)
      throw new Error('Offset is too sharp at a corner.');
    return intersection;
  });
  const reversedEdge = edges.some((edge, i) => {
    const vector = sub(points[(i + 1) % points.length]!, points[i]!);
    return vector[0] * edge.direction[0] + vector[1] * edge.direction[1] <= EPS;
  });
  if (reversedEdge) {
    const winding = Math.sign(area(boundary));
    const convex = boundary.every((p, i) => winding * cross(
      sub(boundary[(i + 1) % boundary.length]!, p),
      sub(boundary[(i + 2) % boundary.length]!, boundary[(i + 1) % boundary.length]!)
    ) >= -EPS);
    if (!closed || distanceMm >= 0 || !convex)
      throw new Error('Offset collapses or overlaps. Choose a smaller distance.');
    // An inset can consume short convex edges without collapsing the whole shape.
    // Intersect the shifted interior half-planes to remove those vanished corners.
    points = boundary;
    for (const edge of edges) {
      const clipped: Point[] = [];
      const signedDistance = (p: Point) => winding * cross(edge.direction, sub(p, edge.start));
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        const da = signedDistance(a), db = signedDistance(b);
        const aInside = da >= -EPS, bInside = db >= -EPS;
        if (aInside) clipped.push(a);
        if (aInside !== bInside) {
          const t = da / (da - db);
          clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
      }
      points = clipped.filter((p, i) => Math.hypot(...sub(p, clipped[(i + clipped.length - 1) % clipped.length]!)) > EPS);
    }
    if (points.length < 3 || Math.abs(area(points)) <= EPS)
      throw new Error('Offset collapses or overlaps. Choose a smaller distance.');
  }
  if (!points.every(p => p.every(Number.isFinite)) ||
      (closed ? !isSimpleLayoutLoop(points) || Math.sign(area(points)) !== Math.sign(area(boundary)) : !simpleOpenPath(points)))
    throw new Error('Offset collapses or overlaps. Choose a smaller distance.');
  return { points, closed };
}

/** Mouse placement distance from the nearest source segment, with an inside/outside sign. */
export function layoutOffsetDistance(source: Source, point: Point): number {
  const boundary = layoutOffsetBoundary(source);
  let best = Infinity, signed = 0;
  for (let i = 0; i < boundary.length - (source.closed ? 0 : 1); i++) {
    const a = boundary[i]!, b = boundary[(i + 1) % boundary.length]!, v = sub(b, a), length = Math.hypot(...v);
    if (length < EPS) continue;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * v[0] + (point[1] - a[1]) * v[1]) / (length * length)));
    const distance = Math.hypot(point[0] - a[0] - t * v[0], point[1] - a[1] - t * v[1]);
    if (distance < best) { best = distance; signed = Math.sign(cross(v, sub(point, a))) * distance; }
  }
  return source.closed ? (pointInsideLayoutPath(point, boundary) ? -best : best) : signed;
}
