// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutCorner, createLayoutCornerBetween } from './corners';
import { createLayoutRectangle } from './rectangles';
import { flattenLayoutPath, pathSegment } from './path';

it('rounds a right angle with a tangent circular fillet and preserves closure and the source', () => {
  const source = createLayoutRectangle('rectangle', [0, 0], [40, 30]), before = structuredClone(source);
  const shape = createLayoutCorner(source, 1, 'fillet', 5);
  expect(shape.closed).toBe(true);
  expect(shape.points).toEqual([[0, 0], [35, 0], [40, expect.closeTo(5, 8)], [40, 30], [0, 30]]);
  const segment = pathSegment(shape.points, shape.handles, 1, true);
  expect(segment.curved).toBe(true);
  expect(segment.c1[1]).toBeCloseTo(0); expect(segment.c2[0]).toBeCloseTo(40);
  for (const p of flattenLayoutPath(shape.points.slice(1, 3), shape.handles?.slice(1, 3), false))
    expect(Math.hypot(p[0] - 35, p[1] - 5)).toBeCloseTo(5, 2);
  expect(source).toEqual(before);
});

it('bevels corners by equal setbacks and supports either edge order, reversed winding, and the closing corner', () => {
  const source = createLayoutRectangle('rectangle', [0, 0], [40, 30]);
  const forward = createLayoutCornerBetween(source, 0, source, 1, 'chamfer', 4, true);
  expect(forward).toEqual(createLayoutCornerBetween(source, 1, source, 0, 'chamfer', 4, true));
  expect(forward.points).toEqual([[0, 0], [36, 0], [40, 4], [40, 30], [0, 30]]);
  const closing = createLayoutCornerBetween(source, 3, source, 0, 'fillet', 4, true);
  expect(closing.points[0]).toEqual([0, expect.closeTo(4, 8)]); expect(closing.points[1]).toEqual([expect.closeTo(4, 8), 0]);
  expect(createLayoutCorner({ ...source, points: [...source.points].reverse() }, 2, 'fillet', 5).closed).toBe(true);
});

it('handles acute, obtuse, and concave corners and preserves unrelated curve controls', () => {
  for (const end of [[30, 10], [10, 30]] as [number, number][]) {
    const source = { points: [[0, 0], [20, 0], end] as [number, number][], closed: false };
    expect(createLayoutCorner(source, 1, 'fillet', 2).points.length).toBeGreaterThanOrEqual(4);
  }
  const source = { points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]] as [number, number][], closed: true };
  expect(createLayoutCorner(source, 3, 'fillet', 2).closed).toBe(true);
  const curved = { points: [[0, 0], [20, 0], [20, 20], [40, 20]] as [number, number][],
    handles: [{}, {}, { out: [25, 15] as [number, number] }, { in: [35, 15] as [number, number] }], closed: false };
  const result = createLayoutCorner(curved, 1, 'fillet', 3);
  expect(result.handles?.at(-2)?.out).toEqual([25, 15]); expect(result.handles?.at(-1)?.in).toEqual([35, 15]);
});

it('joins two separate lines using their clicked sides and can extend them to their intersection', () => {
  const first = { points: [[0, 0], [40, 0]] as [number, number][], closed: false };
  const second = { points: [[20, -20], [20, 20]] as [number, number][], closed: false };
  expect(createLayoutCornerBetween(first, 0, second, 0, 'chamfer', 5, false, [10, 0], [20, 10]).points)
    .toEqual([[0, 0], [15, 0], [20, 5], [20, 20]]);
  const short = { points: [[0, 0], [10, 0]] as [number, number][], closed: false };
  const extended = createLayoutCornerBetween(short, 0, second, 0, 'fillet', 3, false);
  expect(extended.points[0]).toEqual([0, 0]); expect(extended.points[1]).toEqual([17, 0]);
});

it('rejects invalid sizes, non-adjacent edges, curves, parallel lines, endpoints, and collapsed corners', () => {
  const source = createLayoutRectangle('rectangle', [0, 0], [40, 30]);
  for (const size of [0, -1, Infinity, 30, 50]) expect(() => createLayoutCorner(source, 1, 'fillet', size)).toThrow();
  expect(() => createLayoutCornerBetween(source, 0, source, 2, 'fillet', 2, true)).toThrow('adjoining');
  expect(() => createLayoutCorner({ ...source, closed: false }, 0, 'chamfer', 2)).toThrow('adjoining');
  expect(() => createLayoutCorner({ ...source, handles: [{ out: [10, 2] }, {}, {}, {}] }, 1, 'fillet', 2)).toThrow('straight');
  const line = { points: [[0, 0], [20, 0]] as [number, number][], closed: false };
  expect(() => createLayoutCornerBetween(line, 0, { points: [[0, 10], [20, 10]], closed: false }, 0, 'fillet', 2, false)).toThrow('non-parallel');
});
