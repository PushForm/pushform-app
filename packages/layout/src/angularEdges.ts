// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutAngularEdgeAnchor, LayoutEntity } from './LayoutDocument';
import { pathSegment } from './path';
type Point = [number, number];
type Lookup = (id: number) => LayoutEntity | undefined;

function edge(source: LayoutEntity | undefined, index: number, count: number) {
  if (!source || source.kind !== 'path' || source.points.length !== count || index < 0 || index >= count - (source.closed ? 0 : 1))
    throw new Error('Angular dimension edge is unavailable.');
  const segment = pathSegment(source.points, source.handles, index, source.closed, source.contourStarts);
  if (segment.curved) throw new Error('Choose a straight edge, not a curve.');
  const { a, b } = segment;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!Number.isFinite(length) || length < 1e-6) throw new Error('Choose an edge with nonzero length.');
  return { a, length, u: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as Point };
}
function vertex(first: ReturnType<typeof edge>, second: ReturnType<typeof edge>): Point {
  const cross = first.u[0] * second.u[1] - first.u[1] * second.u[0];
  if (Math.abs(cross) < 1e-10) throw new Error('Choose two nonparallel straight edges.');
  const dx = second.a[0] - first.a[0], dy = second.a[1] - first.a[1];
  const t = (dx * second.u[1] - dy * second.u[0]) / cross;
  const point: Point = [first.a[0] + t * first.u[0], first.a[1] + t * first.u[1]];
  if (!point.every(Number.isFinite)) throw new Error('The edge intersection is outside the coordinate range.');
  return point;
}

/** Infinite straight-edge extensions define the vertex, even when the segments do not touch. */
export function resolveAngularEdgePoints(refs: readonly LayoutAngularEdgeAnchor[], lookup: Lookup): [Point, Point, Point] {
  if (refs.length !== 2) throw new Error('Choose two edges.');
  const lines = refs.map(ref => edge(lookup(ref.entityId), ref.segmentIndex, ref.pointCount));
  const v = vertex(lines[0]!, lines[1]!);
  const rays = lines.map((line, index): Point => [v[0] + line.u[0] * line.length * refs[index]!.direction,
    v[1] + line.u[1] * line.length * refs[index]!.direction]);
  return [v, rays[0]!, rays[1]!];
}

export function angularEdgesFromPicks(first: { entity: LayoutEntity; segmentIndex: number; point: Point },
  second: { entity: LayoutEntity; segmentIndex: number; point: Point }): { points: [Point, Point, Point]; edges: [LayoutAngularEdgeAnchor, LayoutAngularEdgeAnchor] } {
  if (first.entity.id === second.entity.id && first.segmentIndex === second.segmentIndex) throw new Error('Choose a different second edge.');
  const picks = [first, second] as const;
  const lines = picks.map(pick => edge(pick.entity, pick.segmentIndex, pick.entity.points.length));
  const v = vertex(lines[0]!, lines[1]!);
  const edges = picks.map((pick, index): LayoutAngularEdgeAnchor => {
    const line = lines[index]!;
    let side = (pick.point[0] - v[0]) * line.u[0] + (pick.point[1] - v[1]) * line.u[1];
    if (Math.abs(side) < 1e-6) side = (line.a[0] - v[0]) * line.u[0] + (line.a[1] - v[1]) * line.u[1] + line.length / 2;
    return { entityId: pick.entity.id, segmentIndex: pick.segmentIndex, pointCount: pick.entity.points.length, direction: side < 0 ? -1 : 1 };
  }) as [LayoutAngularEdgeAnchor, LayoutAngularEdgeAnchor];
  return { edges, points: resolveAngularEdgePoints(edges, id => picks.find(pick => pick.entity.id === id)?.entity) };
}

/** Intersect two point-pair lines, then use the farthest endpoint on each as the angle sides. */
export function angularRaysFromPoints(points: readonly Point[]): [Point, Point, Point] {
  if (points.length !== 4 || points.some(p => !p.every(Number.isFinite))) throw new Error('Choose four finite ray points.');
  const lines = [0, 2].map(index => {
    const a = points[index]!, b = points[index + 1]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!Number.isFinite(length)) throw new Error('Ray coordinates exceed the coordinate range.');
    if (length < 1e-6) throw new Error('Choose two different points for each ray.');
    return { a, length, u: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as Point };
  });
  const v = vertex(lines[0]!, lines[1]!);
  const ends = [0, 2].map(index => {
    const a = points[index]!, b = points[index + 1]!;
    const da = Math.hypot(a[0] - v[0], a[1] - v[1]), db = Math.hypot(b[0] - v[0], b[1] - v[1]);
    // A symmetric pair has no farther end; break ties by coordinates so click order never chooses the side.
    const tied = Math.abs(da - db) <= 1e-10 * Math.max(1, da, db);
    const endpoint = tied ? (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? a : b) : da > db ? a : b;
    return [...endpoint] as Point;
  });
  return [v, ends[0]!, ends[1]!];
}
