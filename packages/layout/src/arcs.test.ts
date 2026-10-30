// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutArc, layoutArcSweep } from './arcs';
import { flattenLayoutPath, pathSegment, pointOnPathSegment } from './path';

it('constructs circular Bézier arcs in either direction and closes pies with straight radii', () => {
  for (const sweep of [Math.PI / 2, -Math.PI / 2, Math.PI * 1.5, -Math.PI * 1.5]) {
    const shape = createLayoutArc('arc', [20, 20], [30, 20], [20, 30], sweep);
    expect(shape.closed).toBe(false);
    expect(shape.points.length).toBe(Math.ceil(Math.abs(sweep) / (Math.PI / 2)) + 1);
    const samples = flattenLayoutPath(shape.points, shape.handles, false);
    for (const p of samples) expect(Math.abs(Math.hypot(p[0] - 20, p[1] - 20) - 10)).toBeLessThan(0.003);
    expect(shape.points.at(-1)![0]).toBeCloseTo(20 + 10 * Math.cos(sweep));
    expect(shape.points.at(-1)![1]).toBeCloseTo(20 + 10 * Math.sin(sweep));
  }
  const pie = createLayoutArc('pie', [20, 20], [30, 20], [20, 40]);
  expect(pie.closed).toBe(true); expect(pie.points.at(-1)).toEqual([20, 20]);
  expect(pathSegment(pie.points, pie.handles, pie.points.length - 2, true).curved).toBe(false);
  expect(pathSegment(pie.points, pie.handles, pie.points.length - 1, true).curved).toBe(false);
  expect(layoutArcSweep([0, 0], [10, 0], [0, -10], Math.PI)).toBeCloseTo(1.5 * Math.PI);
  expect(layoutArcSweep([0, 0], [10, 0], [0, 10], -Math.PI)).toBeCloseTo(-1.5 * Math.PI);
});

it('uses perpendicular bulge and preserves the three-point pivot, including major arcs', () => {
  for (const bulge of [-20, -5, 5, 20]) {
    const shape = createLayoutArc('arc2', [0, 0], [20, 0], [100, bulge]);
    expect(shape.points[0]).toEqual([0, 0]); expect(shape.points.at(-1)).toEqual([20, 0]);
    expect(shape.points).toContainEqual([10, bulge]);
    const centerY = (bulge * bulge - 100) / (2 * bulge), radius = Math.hypot(10, centerY);
    for (let i = 0; i < shape.points.length - 1; i++) {
      const mid = pointOnPathSegment(shape.points, shape.handles, i, false, 0.5);
      expect(Math.hypot(mid[0] - 10, mid[1] - centerY)).toBeCloseTo(radius, 5);
    }
  }
  const shape = createLayoutArc('arc3', [10, 0], [-10, 0], [0, 10]);
  expect(shape.points).toContainEqual([-10, 0]); expect(shape.points.at(-1)).toEqual([0, 10]);
  expect(shape.points.length).toBe(4);
});

it('rejects degenerate and non-finite arcs', () => {
  expect(() => createLayoutArc('arc', [0, 0], [0, 0], [0, 10])).toThrow();
  expect(() => createLayoutArc('arc', [0, 0], [10, 0], [20, 0])).toThrow();
  expect(() => createLayoutArc('arc2', [0, 0], [20, 0], [10, 0])).toThrow();
  expect(() => createLayoutArc('arc3', [0, 0], [10, 10], [20, 20])).toThrow();
  expect(() => createLayoutArc('arc3', [0, 0], [10, 10], [0, 0])).toThrow();
  expect(() => createLayoutArc('pie', [0, 0], [10, 0], [NaN, 10])).toThrow();
});
