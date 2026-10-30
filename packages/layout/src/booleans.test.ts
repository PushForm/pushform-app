// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { booleanLayoutPaths } from './booleans';
import type { LayoutEntity } from './LayoutDocument';
import { createLayoutEllipse } from './ellipses';
const box = (x: number, y: number, w = 10, h = 10): LayoutEntity => ({
  id: 1,
  layerId: 1,
  kind: 'path',
  closed: true,
  points: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ],
});
const area = (shape: ReturnType<typeof booleanLayoutPaths>) => {
  if (!shape) return 0;
  const starts = shape.contourStarts ?? [0];
  return Math.abs(
    starts.reduce((sum, start, index) => {
      const ring = shape.points.slice(start, starts[index + 1] ?? shape.points.length);
      return (
        sum +
        ring.reduce((a, p, i) => {
          const q = ring[(i + 1) % ring.length]!;
          return a + p[0] * q[1] - q[0] * p[1];
        }, 0) /
          2
      );
    }, 0),
  );
};
describe('paper-space booleans', () => {
  it.each([
    ['union', 150],
    ['intersect', 50],
    ['subtract', 50],
    ['exclude', 100],
  ] as const)('%s computes overlapping rectangles', (op, expected) => {
    const sources = [box(0, 0), box(5, 0)],
      before = structuredClone(sources);
    expect(area(booleanLayoutPaths(sources, op))).toBeCloseTo(expected);
    expect(sources).toEqual(before);
  });
  it('keeps holes and disconnected islands as compound contours', () => {
    const hole = booleanLayoutPaths([box(0, 0, 30, 30), box(10, 10)], 'subtract')!;
    expect(hole.contourStarts).toHaveLength(2);
    expect(area(hole)).toBe(800);
    const island = booleanLayoutPaths([box(0, 0), box(20, 0)], 'union')!;
    expect(island.contourStarts).toHaveLength(2);
    expect(area(island)).toBe(200);
    expect(area(booleanLayoutPaths([{ ...box(0, 0), ...hole }, box(10, 10)], 'union'))).toBe(900);
  });
  it('handles identical, touching, disjoint and reversed-winding operands', () => {
    expect(booleanLayoutPaths([box(0, 0), box(0, 0)], 'subtract')).toBeNull();
    expect(booleanLayoutPaths([box(0, 0), box(10, 0)], 'intersect')).toBeNull();
    expect(booleanLayoutPaths([box(0, 0), box(20, 0)], 'intersect')).toBeNull();
    const b = box(5, 0);
    b.points.reverse();
    expect(area(booleanLayoutPaths([box(0, 0), b], 'union'))).toBe(150);
  });
  it('rejects open and self-crossing paths without changing inputs', () => {
    expect(() => booleanLayoutPaths([box(0, 0), { ...box(0, 0), closed: false }], 'union')).toThrow(
      /closed/,
    );
    expect(() =>
      booleanLayoutPaths(
        [
          box(0, 0),
          {
            ...box(0, 0),
            points: [
              [0, 0],
              [10, 10],
              [0, 10],
              [10, 0],
            ],
          },
        ],
        'union',
      ),
    ).toThrow(/self-intersecting/);
  });
});

it('retains untouched curves and their original anchors instead of saving tessellation vertices', () => {
  const curved = box(0, 0);
  curved.handles = [{ out: [3, -5] }, { in: [7, -5] }, {}, {}];
  const before = structuredClone(curved);
  const result = booleanLayoutPaths([curved, box(20, 0)], 'union')!;
  expect(result.points).toHaveLength(8);
  const start = result.points.findIndex((p) => p[0] === 0 && p[1] === 0);
  expect(result.handles?.[start]?.out).toEqual([3, -5]);
  expect(result.handles?.[start + 1]?.in).toEqual([7, -5]);
  expect(curved).toEqual(before);
});

it('subtracts all later operands from the first and treats nested contours with even-odd winding', () => {
  const first = box(0, 0, 30, 10),
    cutters = [box(5, 0, 5), box(20, 0, 5)];
  expect(area(booleanLayoutPaths([first, ...cutters], 'subtract'))).toBe(200);
  const nested = {
    ...first,
    points: [...box(0, 0, 30, 30).points, ...box(5, 5, 20, 20).points, ...box(10, 10).points],
    contourStarts: [0, 4, 8],
  };
  expect(area(booleanLayoutPaths([nested, box(50, 0)], 'union'))).toBe(700);
});

it.each(['union', 'subtract', 'intersect', 'exclude'] as const)(
  '%s inserts real curve intersection anchors and retains cubic handles',
  (operation) => {
    const curved = {
      ...box(0, 0),
      handles: [{ out: [0, -10] }, { in: [10, -10] }, {}, {}],
    } as LayoutEntity;
    const result = booleanLayoutPaths([curved, box(5, -15, 10, 30)], operation)!;
    expect(result.points.length).toBeLessThanOrEqual(12);
    const index = result.points.findIndex(
      (p) => Math.abs(p[0] - 5) < 1e-8 && Math.abs(p[1] + 7.5) < 1e-8,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const h = result.handles![index]!;
    expect([h.in, h.out].filter(Boolean)).toEqual(
      expect.arrayContaining([expect.arrayContaining([expect.closeTo(-7.5, 8)])]),
    );
    // Exact de Casteljau handles at t=.5, not a fitted approximation.
    const handles = result.handles!.flatMap((h) => [h.in, h.out].filter(Boolean));
    expect(handles).toContainEqual([
      expect.closeTo(operation === 'intersect' ? 7.5 : 2.5, 8),
      expect.closeTo(-7.5, 8),
    ]);
  },
);

it('keeps overlapping circles smooth with a small number of editable anchors, including repeated operations', () => {
  const a = { ...box(0, 0), ...createLayoutEllipse([0, 0], 10, 10) };
  const b = { ...a, ...createLayoutEllipse([10, 0], 10, 10) };
  const before = structuredClone([a, b]);
  const lens = booleanLayoutPaths([a, b], 'intersect')!;
  expect(lens.points.length).toBeLessThanOrEqual(6);
  expect(lens.handles?.every((h) => h.in && h.out)).toBe(true);
  const rebuilt = booleanLayoutPaths([{ ...a, ...lens }, a], 'union')!;
  expect(rebuilt.points.length).toBeLessThanOrEqual(8);
  expect(rebuilt.handles?.every((h) => h.in && h.out)).toBe(true);
  expect([a, b]).toEqual(before);
  expect(booleanLayoutPaths([a, a], 'subtract')).toBeNull();
  expect(
    booleanLayoutPaths([a, { ...a, ...createLayoutEllipse([20, 0], 10, 10) }], 'intersect'),
  ).toBeNull();
});
