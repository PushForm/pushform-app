// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutPolygon, snapLayoutPolygonReference } from './polygons';

it.each([3, 4, 6, 9])('inscribes a regular %s-sided polygon with a vertex at the reference point', sides => {
  const center: [number, number] = [20, 30], reference: [number, number] = [14, 22];
  const shape = createLayoutPolygon(center, reference, 'inscribed', sides);
  expect(shape.closed).toBe(true);
  expect(shape.points).toHaveLength(sides);
  expect(shape.points[0]![0]).toBeCloseTo(reference[0]);
  expect(shape.points[0]![1]).toBeCloseTo(reference[1]);
  for (const point of shape.points) expect(Math.hypot(point[0] - center[0], point[1] - center[1])).toBeCloseTo(10);
});

it.each([3, 4, 6, 9])('circumscribes a regular %s-sided polygon around the reference circle', sides => {
  const center: [number, number] = [20, 30], reference: [number, number] = [14, 22];
  const { points } = createLayoutPolygon(center, reference, 'circumscribed', sides);
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % sides]!;
    const distance = Math.abs((b[0] - a[0]) * (center[1] - a[1]) - (b[1] - a[1]) * (center[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    expect(distance).toBeCloseTo(10);
    expect(Math.hypot(a[0] - center[0], a[1] - center[1])).toBeGreaterThan(10);
  }
  const first = points[0]!, last = points.at(-1)!;
  expect((first[0] + last[0]) / 2).toBeCloseTo(reference[0]);
  expect((first[1] + last[1]) / 2).toBeCloseTo(reference[1]);
});

it('defaults to an inscribed hexagon and rejects degenerate inputs', () => {
  expect(createLayoutPolygon([0, 0], [10, 0])).toEqual(createLayoutPolygon([0, 0], [10, 0], 'inscribed', 6));
  expect(() => createLayoutPolygon([0, 0], [0, 0])).toThrow();
  expect(() => createLayoutPolygon([0, 0], [Infinity, 0])).toThrow();
  expect(() => createLayoutPolygon([0, 0], [10, 0], 'inscribed', 2)).toThrow();
  expect(() => createLayoutPolygon([0, 0], [10, 0], 'inscribed', 101)).toThrow();
  expect(createLayoutPolygon([0, 0], [10, 0], 'inscribed', 100).points).toHaveLength(100);
});

it('snaps the reference point to 90° steps from the center within the tolerance', () => {
  const center: [number, number] = [20, 30];
  const near = (point: [number, number] | null, expected: [number, number]) => {
    expect(point![0]).toBeCloseTo(expected[0]); expect(point![1]).toBeCloseTo(expected[1]);
  };
  near(snapLayoutPolygonReference(center, [30, 31], 2), [20 + Math.hypot(10, 1), 30]); // right, keeping the distance
  near(snapLayoutPolygonReference(center, [10, 28.5], 2), [20 - Math.hypot(10, 1.5), 30]); // left
  near(snapLayoutPolygonReference(center, [21, 18], 2), [20, 30 - Math.hypot(1, 12)]); // up the page
  near(snapLayoutPolygonReference(center, [19, 45], 2), [20, 30 + Math.hypot(1, 15)]); // down the page
  expect(snapLayoutPolygonReference(center, [30, 35], 2)).toBeNull(); // 26.6° off: free
  expect(snapLayoutPolygonReference(center, [21, 30.5], 2)).toBeNull(); // too close to the center to judge
  // A snapped inscribed square stands on a corner pointing right; a circumscribed one sits square.
  const square = createLayoutPolygon(center, snapLayoutPolygonReference(center, [30, 31], 2)!, 'circumscribed', 4);
  for (const [x, y] of square.points) { expect(Math.abs(Math.abs(x - 20) - Math.hypot(10, 1))).toBeLessThan(1e-9); expect(Math.abs(Math.abs(y - 30) - Math.hypot(10, 1))).toBeLessThan(1e-9); }
});
