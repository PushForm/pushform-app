// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isLayoutLayerVisible, entitiesForLayer, type LayoutDocumentState, type LayoutPage } from './LayoutDocument';
import { layoutTextCorners, layoutTextCenter, rotateLayoutPoint } from './rotation';
import { layoutLabelLeader } from './labels';
import { layoutPathSegmentIndices, pathSegment, pointOnPathSegment } from './path';
import { layoutEntityBounds } from './selection';

export type PaperPoint = [number, number];
export type PaperSnapKind = 'endpoint' | 'intersection' | 'midpoint' | 'grid' | 'on-path';
export interface PaperSnap {
  point: PaperPoint;
  kind: PaperSnapKind | null;
  /** Centers use midpoint priority and indication, with a distinct hover description. */
  type?: 'center';
}

type Segment = { a: PaperPoint; b: PaperPoint };

function closestOnSegment(point: PaperPoint, { a, b }: Segment): PaperPoint {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return [a[0] + t * dx, a[1] + t * dy];
}

function segmentIntersection(first: Segment, second: Segment): PaperPoint | null {
  const ax = first.b[0] - first.a[0], ay = first.b[1] - first.a[1];
  const bx = second.b[0] - second.a[0], by = second.b[1] - second.a[1];
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-10) return null;
  const cx = second.a[0] - first.a[0], cy = second.a[1] - first.a[1];
  const t = (cx * by - cy * bx) / denominator;
  const u = (cx * ay - cy * ax) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [first.a[0] + t * ax, first.a[1] + t * ay];
}

/** Resolve visible paper geometry to a page-space point. The tolerance is supplied in mm by the caller. */
export function snapPaperPoint(
  raw: PaperPoint,
  page: LayoutPage,
  state: LayoutDocumentState,
  toleranceMm: number,
  excludedEntityIds?: ReadonlySet<number>,
  acceptPoint?: (point: PaperPoint) => boolean,
): PaperSnap {
  let best: PaperSnap = { point: raw, kind: null };
  let bestDistance = toleranceMm;
  let bestPriority = Infinity;
  const consider = (point: PaperPoint, kind: PaperSnapKind, priority: number, type?: 'center'): void => {
    const distance = Math.hypot(raw[0] - point[0], raw[1] - point[1]);
    if (distance > toleranceMm || acceptPoint && !acceptPoint(point)) return;
    if (best.kind !== null) {
      const explicit = priority < 3;
      const bestExplicit = bestPriority < 3;
      if (bestExplicit && !explicit) return;
      if (explicit === bestExplicit &&
        (distance > bestDistance + 0.25 ||
          (Math.abs(distance - bestDistance) <= 0.25 && priority >= bestPriority))) return;
    }
    best = { point, kind, ...(type ? { type } : {}) };
    bestDistance = distance;
    bestPriority = priority;
  };

  const segments: Segment[] = [];
  const centers: PaperPoint[] = [];
  for (const layerId of state.layerOrder) {
    if (state.settings.objectSnap === false) break;
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId)) {
    if (excludedEntityIds?.has(entity.id)) continue;
    const bounds = entity.text ? null : layoutEntityBounds(entity);
    if (entity.text) centers.push(layoutTextCenter(entity));
    else if (bounds) centers.push([(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2]);
    if (entity.kind === 'dimension' || entity.kind === 'angular-dimension') continue;
    if (entity.text) {
      const corners = layoutTextCorners(entity);
      const edges = corners.map((a, i) => ({ a, b: corners[(i + 1) % corners.length]! }));
      const leader = layoutLabelLeader(entity);
      if (leader) {
        const [tip, bend, start] = [leader.tip, leader.bend, leader.start].map(point =>
          rotateLayoutPoint(point, layoutTextCenter(entity), entity.text!.rotationDeg ?? 0)) as [PaperPoint, PaperPoint, PaperPoint];
        edges.push({ a: tip, b: bend }, { a: bend, b: start });
      }
      for (const edge of edges) {
        consider(edge.a, 'endpoint', 0);
        consider(edge.b, 'endpoint', 0);
        consider([(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2], 'midpoint', 2);
        segments.push(edge);
      }
      continue;
    }
    for (const point of entity.points) consider(point, 'endpoint', 0);
    for (const index of layoutPathSegmentIndices(entity)) {
      const steps = pathSegment(entity.points, entity.handles, index, entity.closed, entity.contourStarts).curved ? 20 : 1;
      let a = entity.points[index]!;
      for (let step = 1; step <= steps; step++) {
        const b = pointOnPathSegment(entity.points, entity.handles, index, entity.closed, step / steps, entity.contourStarts);
        if (raw[0] >= Math.min(a[0], b[0]) - toleranceMm &&
          raw[0] <= Math.max(a[0], b[0]) + toleranceMm &&
          raw[1] >= Math.min(a[1], b[1]) - toleranceMm &&
          raw[1] <= Math.max(a[1], b[1]) + toleranceMm) segments.push({ a, b });
        a = b;
      }
      consider(pointOnPathSegment(entity.points, entity.handles, index, entity.closed, 0.5, entity.contourStarts), 'midpoint', 2);
    }
    }
  }
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const first = segments[i]!, second = segments[j]!;
      if ([first.a, first.b].some((a) => [second.a, second.b].some((b) =>
        Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8))) continue;
      const crossing = segmentIntersection(first, second);
      if (crossing) consider(crossing, 'intersection', 1);
    }
  }
  // Existing corners, intersections, and segment midpoints win when a center coincides with them.
  for (const center of centers) consider(center, 'midpoint', 2, 'center');
  if (state.settings.grid.snap && state.settings.grid.spacingMm > 0) {
    const spacing = state.settings.grid.spacingMm;
    const left = page.margin.left;
    const top = page.margin.top;
    const right = page.size[0] - page.margin.right;
    const bottom = page.size[1] - page.margin.bottom;
    const grid: PaperPoint = [Math.round(raw[0] / spacing) * spacing,
      Math.round(raw[1] / spacing) * spacing];
    if (raw[0] > left && raw[0] < right && raw[1] > top && raw[1] < bottom &&
      grid[0] > left && grid[0] < right && grid[1] > top && grid[1] < bottom)
      consider(grid, 'grid', 3);
  }
  for (const segment of segments) consider(closestOnSegment(raw, segment), 'on-path', 4);
  return best;
}

export interface PaperAlignment {
  point: PaperPoint;
  /** Horizontal: the point shares the reference's y. Vertical: it shares the reference's x. */
  axis: 'horizontal' | 'vertical';
}

/**
 * Lock `point` onto the horizontal or vertical line through a reference vertex when it is within `toleranceMm` of it
 *; the closer line wins when both are in reach.
 */
export function alignToPaperReference(point: PaperPoint, reference: PaperPoint, toleranceMm: number): PaperAlignment | null {
  const dy = Math.abs(point[1] - reference[1]), dx = Math.abs(point[0] - reference[0]);
  if (dy > toleranceMm && dx > toleranceMm) return null;
  return dy <= dx ? { point: [point[0], reference[1]], axis: 'horizontal' } : { point: [reference[0], point[1]], axis: 'vertical' };
}
