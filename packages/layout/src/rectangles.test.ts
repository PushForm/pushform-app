// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutRectangle } from './rectangles';
import { flattenLayoutPath, isSimpleLayoutLoop } from './path';

describe('Native rectangle variants', () => {
  it('rounds every corner with editable curve controls and clamps oversized radii', () => {
    const shape = createLayoutRectangle('rounded-rectangle', [10, 10], [70, 40], 5);
    expect(shape.points).toHaveLength(8);
    expect(shape.points[0]).toEqual([15, 10]);
    expect(shape.handles![1]!.out).toBeDefined();
    const points = flattenLayoutPath(shape.points, shape.handles, true);
    expect(isSimpleLayoutLoop(points.slice(0, -1))).toBe(true);
    const clamped = createLayoutRectangle('rounded-rectangle', [0, 0], [20, 10], 100);
    expect(clamped.points).toHaveLength(6);
    expect(isSimpleLayoutLoop(flattenLayoutPath(clamped.points, clamped.handles, true).slice(0, -1))).toBe(true);
  });
  it('bows the left and right sides outward while keeping the top and bottom straight', () => {
    const shape = createLayoutRectangle('bulged-rectangle', [0, 0], [40, 20], 5);
    const samples = flattenLayoutPath(shape.points, shape.handles, true);
    expect(Math.min(...samples.map((p) => p[0]))).toBeCloseTo(-5);
    expect(Math.max(...samples.map((p) => p[0]))).toBeCloseTo(45);
    expect(shape.handles![0]!.out).toBeUndefined();
    expect(shape.handles![2]!.out).toBeUndefined();
    expect(isSimpleLayoutLoop(samples.slice(0, -1))).toBe(true);
  });
  it('makes horizontal and vertical lozenges and a circular outline for square bounds', () => {
    for (const end of [[60, 20], [20, 60], [20, 20]] as [number, number][]) {
      const shape = createLayoutRectangle('lozenge', [0, 0], end);
      const samples = flattenLayoutPath(shape.points, shape.handles, true);
      expect(Math.min(...samples.map((p) => p[0]))).toBeCloseTo(0);
      expect(Math.max(...samples.map((p) => p[0]))).toBeCloseTo(end[0]);
      expect(Math.max(...samples.map((p) => p[1]))).toBeCloseTo(end[1]);
      expect(isSimpleLayoutLoop(samples.slice(0, -1))).toBe(true);
      expect(createLayoutRectangle('lozenge', end, [0, 0])).toEqual(shape);
    }
    expect(createLayoutRectangle('lozenge', [0, 0], [20, 20]).points).toHaveLength(4);
  });
  it('supports zero rounding or bulge and rejects empty geometry', () => {
    expect(createLayoutRectangle('rounded-rectangle', [0, 0], [20, 10], 0)).toEqual(createLayoutRectangle('rectangle', [0, 0], [20, 10]));
    expect(createLayoutRectangle('bulged-rectangle', [0, 0], [20, 10], 0).handles).toBeUndefined();
    expect(() => createLayoutRectangle('lozenge', [0, 0], [20, 0])).toThrow('non-zero');
    expect(() => createLayoutRectangle('rounded-rectangle', [0, 0], [20, 10], -1)).toThrow('Invalid');
  });
});
