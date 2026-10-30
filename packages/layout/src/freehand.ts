// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { LayoutPathHandle } from './LayoutDocument';
import type { PaperPathPoint as Point } from './path';
import type { LayoutRectanglePath } from './rectangles';

const MIN_DISTANCE_MM = LENGTH_TOL * 1000;
const distance = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Simplify pointer noise, then interpolate an open editable Bézier stroke. */
export function createLayoutFreehand(samples: readonly Point[], toleranceMm: number): LayoutRectanglePath {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || samples.some(p => !p.every(Number.isFinite))) {
    throw new Error('Invalid freehand coordinates or tolerance');
  }
  const input: Point[] = [];
  for (const point of samples) {
    if (!input.length || distance(input.at(-1)!, point) > MIN_DISTANCE_MM) input.push([...point]);
  }
  // Retain the exact release position even when it is almost coincident with the previous sample.
  if (input.length > 1 && samples.length) input[input.length - 1] = [...samples.at(-1)!];
  if (input.length < 2) return { points: [], closed: false };

  // Iterative Douglas–Peucker avoids stack overflow on long strokes. Distance is to the
  // segment, not its infinite line, so loops and collinear reversals survive simplification.
  const keep = new Set([0, input.length - 1]);
  const pending: [number, number][] = [[0, input.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    const a = input[first]!, b = input[last]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
    let farthest = -1, maximum = toleranceMm;
    for (let i = first + 1; i < last; i++) {
      const p = input[i]!;
      const t = lengthSquared > MIN_DISTANCE_MM ** 2
        ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared)) : 0;
      const deviation = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (deviation > maximum) { maximum = deviation; farthest = i; }
    }
    if (farthest !== -1) { keep.add(farthest); pending.push([first, farthest], [farthest, last]); }
  }
  const points = [...keep].sort((a, b) => a - b).map(i => input[i]!);
  if (points.length === 2) {
    return { points: distance(points[0]!, points[1]!) > MIN_DISTANCE_MM ? points : [], closed: false };
  }

  // Opposed, equal-length handles give continuous tangents at each anchor. Limit their
  // reach by the shorter neighboring segment so uneven pointer sampling cannot create spikes.
  const handles: LayoutPathHandle[] = points.map((point, i) => {
    const before = points[i - 1], after = points[i + 1];
    if (!before && after) return { out: [point[0] + (after[0] - point[0]) / 3, point[1] + (after[1] - point[1]) / 3] };
    if (before && !after) return { in: [point[0] + (before[0] - point[0]) / 3, point[1] + (before[1] - point[1]) / 3] };
    if (!before || !after) return {};
    const left = distance(before, point), right = distance(point, after);
    if (Math.min(left, right) <= MIN_DISTANCE_MM) return {};
    const tx = (point[0] - before[0]) / left + (after[0] - point[0]) / right;
    const ty = (point[1] - before[1]) / left + (after[1] - point[1]) / right;
    // This unnormalized bisector shrinks to zero at a reversal, preserving a cusp.
    const scale = Math.min(left, right) / 6;
    return { in: [point[0] - tx * scale, point[1] - ty * scale], out: [point[0] + tx * scale, point[1] + ty * scale] };
  });
  return { points, handles, closed: false };
}
