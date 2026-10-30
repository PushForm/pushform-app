// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutPathHandle } from './LayoutDocument';

export type PaperPathPoint = [number, number];

/** Valid compound contours: closed ones keep three vertices and open ones (`openContours`) two. */
export function validLayoutContourStarts(points: readonly PaperPathPoint[], closed: boolean, starts: readonly number[],
  openContours?: readonly number[]): boolean {
  return closed && starts.length >= 2 && starts[0] === 0 && validLayoutOpenContours(starts, openContours) && starts.every((start, index) =>
    Number.isSafeInteger(start) && start >= 0 && (starts[index + 1] ?? points.length) - start >= (openContours?.includes(index) ? 2 : 3));
}

/** Open contour numbers are distinct, ascending, and name contours of the compound path. */
export function validLayoutOpenContours(starts: readonly number[], openContours?: readonly number[]): boolean {
  return !openContours || openContours.length > 0 && openContours.every((contour, index) =>
    Number.isSafeInteger(contour) && contour >= 0 && contour < starts.length && (index === 0 || contour > openContours[index - 1]!));
}

export function layoutContourRange(count: number, index: number, starts?: readonly number[]): { start: number; end: number } {
  const contour = starts?.findLastIndex(start => start <= index) ?? -1;
  return { start: contour < 0 ? 0 : starts![contour]!, end: contour < 0 ? count : starts![contour + 1] ?? count };
}

export function nextLayoutPathIndex(count: number, index: number, starts?: readonly number[]): number {
  const { start, end } = layoutContourRange(count, index, starts);
  return index + 1 < end ? index + 1 : start;
}

/** A path's contours; open contours (`openContours`) come back open, so leave them out to trace the fill. */
export function layoutPathContours(points: readonly PaperPathPoint[], handles: readonly LayoutPathHandle[] | undefined,
  closed: boolean, starts?: readonly number[], openContours?: readonly number[]): { points: PaperPathPoint[]; handles: LayoutPathHandle[] | undefined; closed: boolean }[] {
  return (starts ?? [0]).map((start, index) => ({ points: points.slice(start, starts?.[index + 1] ?? points.length),
    handles: handles?.slice(start, starts?.[index + 1] ?? points.length), closed: closed && !openContours?.includes(index) }));
}

/** Whether a path draws the segment that starts at vertex `index`: open paths and open contours have no closing segment. */
export function layoutPathSegmentDrawn(count: number, index: number, closed: boolean, starts?: readonly number[],
  openContours?: readonly number[]): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= count) return false;
  if (index + 1 < layoutContourRange(count, index, starts).end) return true;
  return closed && !openContours?.includes(starts?.findLastIndex(start => start <= index) ?? 0);
}

/** The vertex indices that start a drawn segment, in order. */
export function layoutPathSegmentIndices(entity: Pick<LayoutEntity, 'points' | 'closed' | 'contourStarts' | 'openContours'>): number[] {
  return entity.points.map((_, index) => index).filter(index =>
    layoutPathSegmentDrawn(entity.points.length, index, entity.closed, entity.contourStarts, entity.openContours));
}

/** Remove a vertex within its own contour; closed compound contours always retain three vertices and open ones two. */
export function removeLayoutPathVertex(entity: LayoutEntity, index: number):
  { points: PaperPathPoint[]; handles: LayoutPathHandle[]; closed: boolean; contourStarts?: number[] } | null {
  if (index < 0 || index >= entity.points.length || entity.points.length <= 2) return null;
  const { start, end } = layoutContourRange(entity.points.length, index, entity.contourStarts);
  const closed = entity.closed && !entity.openContours?.includes(entity.contourStarts?.findLastIndex(first => first <= index) ?? 0);
  if (entity.contourStarts && end - start <= (closed ? 3 : 2)) return null;
  const handles = entity.points.map((_, i) => ({ ...entity.handles?.[i] }));
  if (closed || index > start) delete handles[index === start ? end - 1 : index - 1]!.out;
  if (closed || index < end - 1) delete handles[nextLayoutPathIndex(entity.points.length, index, entity.contourStarts)]!.in;
  return { points: entity.points.filter((_, i) => i !== index), handles: handles.filter((_, i) => i !== index),
    closed: entity.closed && entity.points.length > 3,
    ...(entity.contourStarts ? { contourStarts: entity.contourStarts.map(start => start > index ? start - 1 : start) } : {}) };
}

export function pathSegment(points: readonly PaperPathPoint[], handles: readonly LayoutPathHandle[] | undefined,
  index: number, closed: boolean, contourStarts?: readonly number[]): { a: PaperPathPoint; b: PaperPathPoint; c1: PaperPathPoint; c2: PaperPathPoint; curved: boolean } {
  const next = nextLayoutPathIndex(points.length, index, contourStarts);
  if (index < 0 || index >= points.length - (closed ? 0 : 1)) throw new Error('Invalid path segment');
  const a = points[index]!, b = points[next]!;
  const c1 = handles?.[index]?.out ?? a;
  const c2 = handles?.[next]?.in ?? b;
  return { a, b, c1, c2, curved: Boolean(handles?.[index]?.out || handles?.[next]?.in) };
}

export function pointOnPathSegment(points: readonly PaperPathPoint[], handles: readonly LayoutPathHandle[] | undefined,
  index: number, closed: boolean, t: number, contourStarts?: readonly number[]): PaperPathPoint {
  const { a, b, c1, c2, curved } = pathSegment(points, handles, index, closed, contourStarts);
  if (!curved) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const s = 1 - t;
  return [s ** 3 * a[0] + 3 * s ** 2 * t * c1[0] + 3 * s * t ** 2 * c2[0] + t ** 3 * b[0],
    s ** 3 * a[1] + 3 * s ** 2 * t * c1[1] + 3 * s * t ** 2 * c2[1] + t ** 3 * b[1]];
}

export function flattenLayoutPath(points: readonly PaperPathPoint[], handles: readonly LayoutPathHandle[] | undefined,
  closed: boolean, curveSteps = 20, contourStarts?: readonly number[], openContours?: readonly number[]): PaperPathPoint[] {
  if (contourStarts) return layoutPathContours(points, handles, closed, contourStarts, openContours)
    .flatMap(contour => flattenLayoutPath(contour.points, contour.handles, contour.closed, curveSteps));
  if (points.length === 0) return [];
  const result: PaperPathPoint[] = [[...points[0]!]];
  const count = points.length - (closed ? 0 : 1);
  for (let index = 0; index < count; index++) {
    const steps = pathSegment(points, handles, index, closed).curved ? curveSteps : 1;
    for (let step = 1; step <= steps; step++)
      result.push(pointOnPathSegment(points, handles, index, closed, step / steps));
  }
  return result;
}

const lerp = (a: PaperPathPoint, b: PaperPathPoint, t: number): PaperPathPoint =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Insert an anchor without changing the cubic's geometry. */
export function splitLayoutPathSegment(points: readonly PaperPathPoint[], handles: readonly LayoutPathHandle[] | undefined,
  closed: boolean, index: number, t: number, contourStarts?: readonly number[]): { points: PaperPathPoint[]; handles: LayoutPathHandle[]; contourStarts?: number[] } {
  const { a, b, c1, c2, curved } = pathSegment(points, handles, index, closed, contourStarts);
  if (!(t > 0 && t < 1)) throw new Error('Split position must lie inside the segment');
  const p01 = lerp(a, c1, t), p12 = lerp(c1, c2, t), p23 = lerp(c2, b, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
  const middle = lerp(p012, p123, t);
  const next = nextLayoutPathIndex(points.length, index, contourStarts);
  const contours = contourStarts ? { contourStarts: contourStarts.map(start => start > index ? start + 1 : start) } : {};
  const resultPoints = points.map((point): PaperPathPoint => [...point]);
  const resultHandles = points.map((_, i): LayoutPathHandle => ({
    ...(handles?.[i]?.in ? { in: [...handles[i]!.in!] as PaperPathPoint } : {}),
    ...(handles?.[i]?.out ? { out: [...handles[i]!.out!] as PaperPathPoint } : {}),
  }));
  if (!curved) {
    resultPoints.splice(index + 1, 0, lerp(a, b, t));
    resultHandles.splice(index + 1, 0, {});
    return { points: resultPoints, handles: resultHandles, ...contours };
  }
  resultHandles[index]!.out = p01;
  resultHandles[next]!.in = p23;
  resultPoints.splice(index + 1, 0, middle);
  resultHandles.splice(index + 1, 0, { in: p012, out: p123 });
  return { points: resultPoints, handles: resultHandles, ...contours };
}

/** True for one non-degenerate, non-self-intersecting boundary (no holes or branches). */
export function isSimpleLayoutLoop(points: readonly PaperPathPoint[]): boolean {
  if (points.length < 3) return false;
  const epsilon = 1e-8;
  const cross = (a: PaperPathPoint, b: PaperPathPoint, c: PaperPathPoint): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a: PaperPathPoint, b: PaperPathPoint, p: PaperPathPoint): boolean =>
    Math.abs(cross(a, b, p)) < epsilon && p[0] >= Math.min(a[0], b[0]) - epsilon &&
    p[0] <= Math.max(a[0], b[0]) + epsilon && p[1] >= Math.min(a[1], b[1]) - epsilon && p[1] <= Math.max(a[1], b[1]) + epsilon;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[(i + 2) % points.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < epsilon) return false;
    if (Math.abs(cross(a, b, c)) < epsilon && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) return false;
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const d = points[j]!, e = points[(j + 1) % points.length]!;
      const abD = cross(a, b, d), abE = cross(a, b, e), deA = cross(d, e, a), deB = cross(d, e, b);
      if ((abD * abE < 0 && deA * deB < 0) || onSegment(a, b, d) || onSegment(a, b, e) || onSegment(d, e, a) || onSegment(d, e, b)) return false;
    }
  }
  return Math.abs(area) > epsilon;
}

export function pointInsideLayoutPath(point: PaperPathPoint, boundary: readonly PaperPathPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[i]!, b = boundary[j]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
