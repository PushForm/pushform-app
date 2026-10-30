// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutPathHandle } from './LayoutDocument';
import { createLayoutArc } from './arcs';
import { layoutContourRange, nextLayoutPathIndex, flattenLayoutPath, isSimpleLayoutLoop, pathSegment } from './path';
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];
type Source = Pick<LayoutEntity, 'points' | 'handles' | 'closed' | 'contourStarts' | 'openContours'>;
export type LayoutCornerKind = 'fillet' | 'chamfer';
export function isLayoutCornerTool(tool: string): tool is LayoutCornerKind { return tool === 'fillet' || tool === 'chamfer'; }
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];

/** Replace a straight-sided vertex with a tangent circular fillet or equal-setback chamfer. */
export function createLayoutCorner(source: Source, vertexIndex: number, kind: LayoutCornerKind, amountMm: number): LayoutRectanglePath {
  if (source.contourStarts) {
    const { start, end } = layoutContourRange(source.points.length, vertexIndex, source.contourStarts);
    const open = source.openContours?.includes(source.contourStarts.indexOf(start)) ?? false;
    const contour = createLayoutCorner({ points: source.points.slice(start, end),
      ...(source.handles ? { handles: source.handles.slice(start, end) } : {}), closed: !open }, vertexIndex - start, kind, amountMm);
    const delta = contour.points.length - (end - start);
    return { points: [...source.points.slice(0, start), ...contour.points, ...source.points.slice(end)],
      handles: [...source.points.slice(0, start).map((_, i) => source.handles?.[i] ?? {}), ...contour.handles!,
        ...source.points.slice(end).map((_, i) => source.handles?.[end + i] ?? {})], closed: true,
      contourStarts: source.contourStarts.map(index => index >= end ? index + delta : index) };
  }
  const n = source.points.length;
  if (!Number.isFinite(amountMm) || amountMm <= 1e-6) throw new Error('Enter a positive corner size.');
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= n || n < 3 ||
      (!source.closed && (vertexIndex === 0 || vertexIndex === n - 1))) throw new Error('Choose two adjoining segments at a corner.');
  const before = (vertexIndex - 1 + n) % n, after = (vertexIndex + 1) % n;
  if (pathSegment(source.points, source.handles, before, source.closed).curved ||
      pathSegment(source.points, source.handles, vertexIndex, source.closed).curved) throw new Error('Choose two straight segments.');
  const a = source.points[before]!, b = source.points[vertexIndex]!, c = source.points[after]!;
  const incoming = sub(a, b), outgoing = sub(c, b), l1 = Math.hypot(...incoming), l2 = Math.hypot(...outgoing);
  if (![...a, ...b, ...c].every(Number.isFinite) || l1 < 1e-6 || l2 < 1e-6) throw new Error('Choose a non-degenerate corner.');
  const u: Point = [incoming[0] / l1, incoming[1] / l1], v: Point = [outgoing[0] / l2, outgoing[1] / l2];
  const angle = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  if (Math.abs(cross(u, v)) < 1e-6) throw new Error('Parallel or collinear segments do not form a corner.');
  const trim = kind === 'fillet' ? amountMm / Math.tan(angle / 2) : amountMm;
  if (trim >= Math.min(l1, l2) - 1e-6) throw new Error('Corner size exceeds the available segments. Choose a smaller size.');
  const start: Point = [b[0] + u[0] * trim, b[1] + u[1] * trim];
  const end: Point = [b[0] + v[0] * trim, b[1] + v[1] * trim];
  let replacement: LayoutRectanglePath = { points: [start, end], handles: [{}, {}], closed: false };
  if (kind === 'fillet') {
    const sum: Point = [u[0] + v[0], u[1] + v[1]], length = Math.hypot(...sum), centerDistance = amountMm / Math.sin(angle / 2);
    const center: Point = [b[0] + sum[0] / length * centerDistance, b[1] + sum[1] / length * centerDistance];
    replacement = createLayoutArc('arc', center, start, end, -Math.sign(cross(u, v)) * (Math.PI - angle));
    replacement.points[replacement.points.length - 1] = end;
  }
  const points = source.points.map(p => [...p] as Point);
  const handles: LayoutPathHandle[] = source.points.map((_, i) => ({
    ...(source.handles?.[i]?.in ? { in: [...source.handles[i]!.in!] as Point } : {}),
    ...(source.handles?.[i]?.out ? { out: [...source.handles[i]!.out!] as Point } : {}),
  }));
  points.splice(vertexIndex, 1, ...replacement.points);
  handles.splice(vertexIndex, 1, ...replacement.handles!);
  if (![...points, ...handles.flatMap(h => [h.in, h.out].filter((p): p is Point => !!p))].every(p => p.every(Number.isFinite))) throw new Error('Corner exceeds coordinate range.');
  if (source.closed && !isSimpleLayoutLoop(flattenLayoutPath(points, handles, true).slice(0, -1))) throw new Error('Corner would overlap the path. Choose a smaller size.');
  return { points, handles, closed: source.closed };
}

/** Edit adjacent edges, or join the chosen sides of two separate straight lines. */
export function createLayoutCornerBetween(first: Source, firstSegment: number, second: Source, secondSegment: number,
  kind: LayoutCornerKind, amountMm: number, samePath: boolean, firstPick?: Point, secondPick?: Point): LayoutRectanglePath {
  const one = pathSegment(first.points, first.handles, firstSegment, first.closed, first.contourStarts);
  const two = pathSegment(second.points, second.handles, secondSegment, second.closed, second.contourStarts);
  if (one.curved || two.curved) throw new Error('Choose two straight segments.');
  if (samePath) {
    const n = first.points.length;
    if (firstSegment === secondSegment) throw new Error('Choose a different adjoining segment.');
    const vertex = nextLayoutPathIndex(n, firstSegment, first.contourStarts) === secondSegment ? secondSegment
      : nextLayoutPathIndex(n, secondSegment, first.contourStarts) === firstSegment ? firstSegment : -1;
    return createLayoutCorner(first, vertex, kind, amountMm);
  }
  if (first.closed || second.closed || first.points.length !== 2 || second.points.length !== 2)
    throw new Error('Separate paths must be single straight lines; use adjoining segments within other paths.');
  const v1 = sub(one.b, one.a), v2 = sub(two.b, two.a), denominator = cross(v1, v2);
  if (Math.abs(denominator) < 1e-8 * Math.hypot(...v1) * Math.hypot(...v2) || Math.hypot(...v1) < 1e-6 || Math.hypot(...v2) < 1e-6)
    throw new Error('Choose two non-parallel lines.');
  const t = cross(sub(two.a, one.a), v2) / denominator;
  const corner: Point = [one.a[0] + t * v1[0], one.a[1] + t * v1[1]];
  const retain = (a: Point, b: Point, pick?: Point): Point => {
    if (pick && Math.hypot(...sub(pick, corner)) > 1e-6) {
      const direction = sub(pick, corner), da = sub(a, corner), db = sub(b, corner);
      return da[0] * direction[0] + da[1] * direction[1] > db[0] * direction[0] + db[1] * direction[1] ? a : b;
    }
    return Math.hypot(...sub(a, corner)) > Math.hypot(...sub(b, corner)) ? a : b;
  };
  return createLayoutCorner({ points: [retain(one.a, one.b, firstPick), corner, retain(two.a, two.b, secondPick)], closed: false }, 1, kind, amountMm);
}
