// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { LayoutEntity } from './LayoutDocument';
import { operateLayoutPaths, validateLayoutPathOperand } from './booleans';
import { flattenLayoutPath, layoutPathContours } from './path';
import { createLayoutEllipse } from './ellipses';
import type { LayoutRectanglePath } from './rectangles';

const path = (points: [number, number][], closed = false): LayoutEntity => ({
  id: 1,
  layerId: 1,
  kind: 'path',
  points,
  closed,
});
const box = (x = 0, y = 0, w = 10, h = 10) =>
  path(
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    true,
  );
const area = (shape: LayoutRectanglePath) =>
  Math.abs(
    layoutPathContours(shape.points, shape.handles, true, shape.contourStarts).reduce(
      (sum, contour) =>
        sum +
        flattenLayoutPath(contour.points, contour.handles, true, 500).reduce((a, p, i, ring) => {
          const q = ring[(i + 1) % ring.length]!;
          return a + p[0] * q[1] - q[0] * p[1];
        }, 0) /
          2,
      0,
    ),
  );
const length = (shape: LayoutRectanglePath) =>
  shape.points.reduce((sum, p, i, points) => {
    const q = i + 1 < points.length ? points[i + 1]! : shape.closed ? points[0]! : p;
    return sum + Math.hypot(p[0] - q[0], p[1] - q[1]);
  }, 0);

describe('Division', () => {
  it('splits a target into separate filled pieces along an open line', () => {
    const sources = [
        box(),
        path([
          [5, -5],
          [5, 15],
        ]),
      ],
      before = structuredClone(sources);
    const result = operateLayoutPaths(sources, 'division');
    expect(result).toHaveLength(2);
    result.forEach((p) => expect(area(p)).toBeCloseTo(50, 8));
    expect(result.every((p) => p.closed)).toBe(true);
    expect(sources).toEqual(before);
  });

  it('uses every cutter, splitting a target into four pieces', () => {
    const result = operateLayoutPaths(
      [
        box(),
        path([
          [5, -5],
          [5, 15],
        ]),
        path([
          [-5, 5],
          [15, 5],
        ]),
      ],
      'division',
    );
    expect(result).toHaveLength(4);
    result.forEach((p) => expect(area(p)).toBeCloseTo(25, 8));
  });

  it('retains all target area when a closed cutter creates an interior piece and a hole', () => {
    const result = operateLayoutPaths([box(0, 0, 30, 30), box(10, 10)], 'division');
    expect(result).toHaveLength(2);
    expect(result.map(area).sort((a, b) => a - b)).toEqual([100, 800]);
    expect(result.find((p) => p.contourStarts)?.contourStarts).toHaveLength(2);
  });

  it('preserves existing holes and excludes cutter geometry outside the target', () => {
    const ring = {
      ...box(0, 0, 30, 30),
      points: [...box(0, 0, 30, 30).points, ...box(10, 10).points],
      contourStarts: [0, 4],
    };
    const result = operateLayoutPaths(
      [
        ring,
        path([
          [-5, 15],
          [35, 15],
        ]),
      ],
      'division',
    );
    expect(result).toHaveLength(2);
    result.forEach((p) => expect(area(p)).toBeCloseTo(400, 8));
  });

  it.each([
    path([
      [5, 2],
      [5, 8],
    ]),
    path([
      [20, 0],
      [20, 10],
    ]),
    path([
      [0, 0],
      [10, 0],
    ]),
  ])('does not invent a split from a dangling, disjoint or coincident cutter', (cutter) => {
    const result = operateLayoutPaths([box(), cutter], 'division');
    expect(result).toHaveLength(1);
    expect(area(result[0]!)).toBe(100);
  });

  it('retains a curved cutter as cubic boundaries and preserves the total filled area', () => {
    const cutter: LayoutEntity = {
      ...path([
        [5, -5],
        [5, 15],
      ]),
      handles: [{ out: [9, 0] }, { in: [1, 10] }],
    };
    const result = operateLayoutPaths([box(), cutter], 'division');
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.points.length <= 6 && p.handles?.some((h) => h.in || h.out))).toBe(
      true,
    );
    expect(result.reduce((sum, shape) => sum + area(shape), 0)).toBeCloseTo(100, 4);
  });
});

it.each(['division', 'cut-path'] as const)(
  '%s cuts a circle at intersections without polygonizing its outline',
  (operation) => {
    const circle = { ...box(), ...createLayoutEllipse([0, 0], 10, 10) };
    const before = structuredClone(circle);
    const results = operateLayoutPaths(
      [
        circle,
        path([
          [3, -20],
          [3, 20],
        ]),
      ],
      operation,
    );
    expect(results).toHaveLength(2);
    expect(
      results.every((p) => p.points.length <= 6 && p.handles?.some((h) => h.in || h.out)),
    ).toBe(true);
    if (operation === 'division')
      expect(results.reduce((sum, p) => sum + area(p), 0)).toBeCloseTo(
        area(createLayoutEllipse([0, 0], 10, 10)),
        3,
      );
    expect(circle).toEqual(before);
  },
);

it('Division preserves a curved hole and disconnected islands when the cutter misses', () => {
  const outer = createLayoutEllipse([0, 0], 20, 20),
    hole = createLayoutEllipse([0, 0], 10, 10);
  const island = createLayoutEllipse([50, 0], 10, 10);
  const target: LayoutEntity = {
    ...box(),
    points: [...outer.points, ...hole.points, ...island.points],
    handles: [...outer.handles!, ...hole.handles!, ...island.handles!],
    contourStarts: [0, 4, 8],
  };
  const result = operateLayoutPaths(
    [
      target,
      path([
        [100, 0],
        [100, 20],
      ]),
    ],
    'division',
  );
  expect(result).toHaveLength(2);
  expect(result.map((p) => p.points.length).sort((a, b) => a - b)).toEqual([4, 8]);
  expect(result.every((p) => p.handles?.every((h) => h.in && h.out))).toBe(true);
  expect(result.reduce((sum, p) => sum + area(p), 0)).toBeCloseTo(
    area(outer) - area(hole) + area(island),
    3,
  );
});

it('Cut Path splits a cubic exactly at t=.5 and preserves both subcurves', () => {
  const target: LayoutEntity = {
    ...path([
      [0, 0],
      [10, 0],
    ]),
    handles: [{ out: [0, -10] }, { in: [10, -10] }],
  };
  const result = operateLayoutPaths(
    [
      target,
      path([
        [5, -20],
        [5, 20],
      ]),
    ],
    'cut-path',
  );
  expect(result).toEqual([
    {
      points: [
        [0, 0],
        [5, -7.5],
      ],
      handles: [{ out: [0, -5] }, { in: [2.5, -7.5] }],
      closed: false,
    },
    {
      points: [
        [5, -7.5],
        [10, 0],
      ],
      handles: [{ out: [7.5, -7.5] }, { in: [10, -5] }],
      closed: false,
    },
  ]);
});

describe('Cut Path', () => {
  it('opens a closed target at each crossing and keeps the complete outline', () => {
    const sources = [
        box(),
        path([
          [5, -5],
          [5, 15],
        ]),
      ],
      before = structuredClone(sources);
    const result = operateLayoutPaths(sources, 'cut-path');
    expect(result).toHaveLength(2);
    expect(result.every((p) => !p.closed)).toBe(true);
    expect(result.map(length)).toEqual([20, 20]);
    expect(result.flatMap((p) => [p.points[0], p.points.at(-1)])).toEqual([
      [5, 0],
      [5, 10],
      [5, 10],
      [5, 0],
    ]);
    expect(sources).toEqual(before);
  });

  it('cuts an open path in multiple places without closing its ends', () => {
    const result = operateLayoutPaths(
      [
        path([
          [0, 0],
          [10, 0],
        ]),
        path([
          [3, -5],
          [3, 5],
        ]),
        path([
          [7, -5],
          [7, 5],
        ]),
      ],
      'cut-path',
    );
    expect(result.map((p) => p.points)).toEqual([
      [
        [0, 0],
        [3, 0],
      ],
      [
        [3, 0],
        [expect.closeTo(7, 8), 0],
      ],
      [
        [expect.closeTo(7, 8), 0],
        [10, 0],
      ],
    ]);
    expect(result.every((p) => !p.closed)).toBe(true);
  });

  it('deduplicates shared-vertex crossings and wraps a closed contour at a single cut', () => {
    const cutter = path([
      [-5, -5],
      [0, 0],
      [-5, 5],
    ]);
    const result = operateLayoutPaths([box(), cutter], 'cut-path');
    expect(result).toHaveLength(1);
    expect(result[0]?.closed).toBe(false);
    expect(length(result[0]!)).toBe(40);
    expect(result[0]?.points[0]).toEqual(result[0]?.points.at(-1));
  });

  it('cuts at the ends of a collinear overlap without dropping stroke segments', () => {
    const result = operateLayoutPaths(
      [
        path([
          [0, 0],
          [10, 0],
        ]),
        path([
          [3, 0],
          [7, 0],
        ]),
      ],
      'cut-path',
    );
    expect(result).toHaveLength(3);
    expect(result.map(length)).toEqual([
      expect.closeTo(3, 8),
      expect.closeTo(4, 8),
      expect.closeTo(3, 8),
    ]);
  });

  it('leaves a contour closed when no cutter crosses it', () => {
    const result = operateLayoutPaths(
      [
        box(),
        path([
          [20, 0],
          [20, 10],
        ]),
      ],
      'cut-path',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.closed).toBe(true);
    expect(length(result[0]!)).toBe(40);
  });

  it('allows open cutters for Division and any drawn path for Cut Path, but requires a filled target for Division', () => {
    const line = path([
      [0, 0],
      [10, 0],
    ]);
    expect(() => validateLayoutPathOperand(line, 'division', false)).not.toThrow();
    expect(() => validateLayoutPathOperand(line, 'division', true)).toThrow(/closed/);
    expect(() => validateLayoutPathOperand(line, 'cut-path', true)).not.toThrow();
    expect(() => validateLayoutPathOperand(line, 'subtract', false)).toThrow(/closed/);
  });
});
