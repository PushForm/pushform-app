// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isLayoutLayerVisible, entitiesForLayer, type LayoutDocumentState, type LayoutEntity, type LayoutPage } from './LayoutDocument';
import { angularDimensionGeometry, linearDimensionGeometry } from './dimensions';
import { flattenLayoutPath, layoutPathContours } from './path';
import { layoutTextCenter, rotateLayoutPoint } from './rotation';
type Point = [number, number];

export interface PaperBounds { minX: number; minY: number; maxX: number; maxY: number }

function boundsOf(points: readonly Point[]): PaperBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  return { minX, minY, maxX, maxY };
}

/** The paper-space extent of what an object draws, so selection boxes judge the visible shape rather than raw control points. */
export function layoutEntityBounds(entity: LayoutEntity): PaperBounds | null {
  if (entity.dimension && entity.points.length >= 3) {
    const { a, b, start, end } = linearDimensionGeometry(entity);
    return boundsOf([a, b, start, end]);
  }
  if (entity.angularDimension && entity.points.length >= 4) {
    const geometry = angularDimensionGeometry(entity);
    return boundsOf([geometry.vertex, entity.points[1]!, entity.points[2]!, geometry.text, ...geometry.arc]);
  }
  if (entity.text) {
    const [a, b] = entity.points;
    if (!a || !b) return boundsOf(entity.points);
    const center = layoutTextCenter(entity), angle = entity.text.rotationDeg ?? 0;
    const corners: Point[] = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
    return boundsOf([...corners.map((corner) => rotateLayoutPoint(corner, center, angle)), ...entity.points.slice(2)]);
  }
  if (entity.kind === 'path') {
    // Straight segments have the same extrema as their anchors. Avoid copying the
    // entire path for each pointer move; curves retain the existing sampling.
    if (!entity.handles?.some(handle => handle?.in || handle?.out)) return boundsOf(entity.points);
    return boundsOf(flattenLayoutPath(entity.points, entity.handles, entity.closed, 20, entity.contourStarts));
  }
  return boundsOf(entity.points);
}

/**
 * Objects chosen by a selection box. A left-to-right box selects only objects entirely inside it;
 * a right-to-left box also selects objects it merely touches. Order follows layer and drawing order.
 */
export function entitiesInSelectionBox(from: Point, to: Point, page: LayoutPage, state: LayoutDocumentState): LayoutEntity[] {
  const crossing = to[0] < from[0];
  const box: PaperBounds = { minX: Math.min(from[0], to[0]), minY: Math.min(from[1], to[1]),
    maxX: Math.max(from[0], to[0]), maxY: Math.max(from[1], to[1]) };
  const chosen: LayoutEntity[] = [];
  for (const layerId of state.layerOrder) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId)) {
      const bounds = layoutEntityBounds(entity);
      if (!bounds) continue;
      const inside = bounds.minX >= box.minX && bounds.maxX <= box.maxX && bounds.minY >= box.minY && bounds.maxY <= box.maxY;
      const touches = bounds.minX <= box.maxX && bounds.maxX >= box.minX && bounds.minY <= box.maxY && bounds.maxY >= box.minY;
      if (inside || (crossing && touches)) chosen.push(entity);
    }
  }
  return chosen;
}

/**
 * True when a lasso outline runs clockwise as seen on the page (paper y points down), so it selects what it
 * touches; counterclockwise outlines select only what they enclose.
 */
export function lassoIsCrossing(outline: readonly Point[]): boolean {
  let twiceArea = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++)
    twiceArea += outline[j]![0] * outline[i]![1] - outline[i]![0] * outline[j]![1];
  return twiceArea > 0;
}

/**
 * What an object draws, for lasso selection: polylines, each with whether it encloses an area. Paths keep their
 * curves; text frames keep their rotation; other objects are judged by the extent box selection uses.
 */
function drawnOutlines(entity: LayoutEntity): { points: Point[]; area: boolean }[] {
  if (entity.kind === 'path')
    return layoutPathContours(entity.points, entity.handles, entity.closed, entity.contourStarts, entity.openContours)
      .map((contour) => ({ points: flattenLayoutPath(contour.points, contour.handles, contour.closed, 20), area: contour.closed }));
  if (entity.text && entity.points.length >= 2) {
    const [a, b] = entity.points as [Point, Point];
    const center = layoutTextCenter(entity), angle = entity.text.rotationDeg ?? 0;
    const frame = ([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]] as Point[]).map((corner) => rotateLayoutPoint(corner, center, angle));
    // Further points (a label's leader) count as points, as for selection boxes.
    return [{ points: frame, area: true }, ...entity.points.slice(2).map((p) => ({ points: [p as Point], area: false }))];
  }
  const bounds = layoutEntityBounds(entity);
  if (!bounds) return [];
  return [{ points: [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY], [bounds.minX, bounds.minY]], area: true }];
}

/** Even-odd test: whether `p` lies inside the closed ring `ring`. */
function insideRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Segments a–b and c–d share a point (touching counts). */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const within = (p: Point, q: Point, r: Point): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const d1 = side(c, d, a), d2 = side(c, d, b), d3 = side(a, b, c), d4 = side(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/**
 * Objects chosen by a lasso outline, with the visibility rules of a selection box. A clockwise
 * outline selects objects whose drawing it touches or encloses, or whose enclosed area holds the outline; a
 * counterclockwise outline selects objects drawn entirely inside it, where no part of the drawing leaves it.
 * Inside is even-odd, so an area the outline wraps twice is outside. Fewer than three points select nothing.
 */
export function entitiesInLasso(outline: readonly Point[], page: LayoutPage, state: LayoutDocumentState): LayoutEntity[] {
  if (outline.length < 3) return [];
  const crossing = lassoIsCrossing(outline);
  const ring = [...outline, outline[0]!];
  const crossesOutline = (a: Point, b: Point): boolean => ring.some((p, i) => i > 0 && segmentsMeet(a, b, ring[i - 1]!, p));
  const chosen: LayoutEntity[] = [];
  for (const layerId of state.layerOrder) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId)) {
      const outlines = drawnOutlines(entity).filter((line) => line.points.length > 0);
      if (!outlines.length) continue;
      const segments = outlines.flatMap(({ points }): (readonly [Point, Point])[] =>
        points.length === 1 ? [[points[0]!, points[0]!]] : points.slice(1).map((p, i) => [points[i]!, p]));
      const enclosed = outlines.every(({ points }) => points.every((p) => insideRing(p, outline))) && !segments.some(([a, b]) => crossesOutline(a, b));
      const touched = enclosed || segments.some(([a, b]) => insideRing(a, outline) || crossesOutline(a, b))
        || outlines.some(({ points, area }) => area && outline.some((p) => insideRing(p, points)));
      if (crossing ? touched : enclosed) chosen.push(entity);
    }
  }
  return chosen;
}
