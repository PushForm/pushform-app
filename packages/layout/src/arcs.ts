// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPathHandle } from './LayoutDocument';
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];
export const LAYOUT_ARC_KINDS = ['arc', 'arc2', 'arc3', 'pie'] as const;
export type LayoutArcKind = typeof LAYOUT_ARC_KINDS[number];
const TAU = Math.PI * 2;
export function isLayoutArcTool(tool: string): tool is LayoutArcKind {
  return (LAYOUT_ARC_KINDS as readonly string[]).includes(tool);
}
/** Unwrap the cursor angle so either direction and sweeps larger than a semicircle are possible. */
export function layoutArcSweep(center: Point, start: Point, end: Point, previous = 0): number {
  let angle = Math.atan2(end[1] - center[1], end[0] - center[0]) - Math.atan2(start[1] - center[1], start[0] - center[0]);
  angle += Math.round((previous - angle) / TAU) * TAU;
  return Math.max(-TAU + 1e-7, Math.min(TAU - 1e-7, angle));
}

function circularPath(center: Point, radius: number, start: number, sweep: number): LayoutRectanglePath {
  if (![...center, radius, start, sweep].every(Number.isFinite)) throw new Error('Arc exceeds coordinate range.');
  if (radius < 1e-6 || Math.abs(sweep) < 1e-7 || Math.abs(sweep) >= TAU) throw new Error('Choose a non-zero radius and arc angle.');
  const count = Math.ceil(Math.abs(sweep) / (Math.PI / 2)), step = sweep / count;
  const points: Point[] = [], handles: LayoutPathHandle[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = start + i * step;
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
    handles.push({});
    if (i > 0) {
      const before = angle - step, k = 4 / 3 * Math.tan(step / 4) * radius;
      handles[i - 1]!.out = [points[i - 1]![0] - k * Math.sin(before), points[i - 1]![1] + k * Math.cos(before)];
      handles[i]!.in = [points[i]![0] + k * Math.sin(angle), points[i]![1] - k * Math.cos(angle)];
    }
  }
  if (![...points, ...handles.flatMap(h => [h.in, h.out].filter((p): p is Point => !!p))].every(p => p.every(Number.isFinite))) throw new Error('Arc exceeds coordinate range.');
  return { points, handles, closed: false };
}

/** Three clicks: center/start/end, endpoints/bulge, or start/pivot/end. Paper units are mm. */
export function createLayoutArc(kind: LayoutArcKind, a: Point, b: Point, c: Point, sweep?: number): LayoutRectanglePath {
  if (![...a, ...b, ...c, sweep ?? 0].every(Number.isFinite)) throw new Error('Arc coordinates must be finite.');
  if (kind === 'arc' || kind === 'pie') {
    if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-6) throw new Error('Choose an endpoint away from the center.');
    const shape = circularPath(a, Math.hypot(b[0] - a[0], b[1] - a[1]), Math.atan2(b[1] - a[1], b[0] - a[0]), sweep ?? layoutArcSweep(a, b, c));
    shape.points[0] = [...b];
    if (kind === 'pie') { shape.points.push([...a]); shape.handles!.push({}); shape.closed = true; }
    return shape;
  }
  let pivot = b, end = c;
  if (kind === 'arc2') {
    end = b;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < 1e-6) throw new Error('Choose different arc endpoints.');
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const bulge = ((c[0] - mid[0]) * -dy + (c[1] - mid[1]) * dx) / length;
    pivot = [mid[0] - dy / length * bulge, mid[1] + dx / length * bulge];
  }
  // Circumcenter in local coordinates avoids cancellation far from the paper origin.
  const ux = pivot[0] - a[0], uy = pivot[1] - a[1], vx = end[0] - a[0], vy = end[1] - a[1];
  const det = 2 * (ux * vy - uy * vx);
  const scale = Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy));
  if (scale < 1e-6 || Math.abs(det) < 1e-8 * scale * scale || Math.hypot(end[0] - pivot[0], end[1] - pivot[1]) < 1e-6)
    throw new Error('Choose three distinct points that are not on one line.');
  const u2 = ux * ux + uy * uy, v2 = vx * vx + vy * vy;
  const center: Point = [a[0] + (u2 * vy - v2 * uy) / det, a[1] + (ux * v2 - vx * u2) / det];
  const angle = (p: Point) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const positive = (value: number) => (value % TAU + TAU) % TAU;
  const start = angle(a), via = positive(angle(pivot) - start), finish = positive(angle(end) - start);
  const direction = via < finish ? 1 : -1;
  const firstSweep = direction > 0 ? via : via - TAU;
  const secondSweep = direction > 0 ? positive(angle(end) - angle(pivot)) : -positive(angle(pivot) - angle(end));
  const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
  const first = circularPath(center, radius, start, firstSweep), second = circularPath(center, radius, angle(pivot), secondSweep);
  first.handles!.at(-1)!.out = second.handles![0]!.out;
  const shape = { points: [...first.points, ...second.points.slice(1)], handles: [...first.handles!, ...second.handles!.slice(1)], closed: false };
  shape.points[0] = [...a]; shape.points[first.points.length - 1] = [...pivot]; shape.points[shape.points.length - 1] = [...end];
  if (![...shape.points, ...shape.handles.flatMap(h => [h.in, h.out].filter((p): p is Point => !!p))].every(p => p.every(Number.isFinite))) throw new Error('Arc exceeds coordinate range.');
  return shape;
}
