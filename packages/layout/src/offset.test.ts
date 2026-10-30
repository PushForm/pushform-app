// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutOffset, layoutOffsetBoundary, layoutOffsetDistance } from './offset';
import { createLayoutArc } from './arcs';
import { createLayoutRectangle } from './rectangles';

it('offsets rectangles outward and inward independently of winding without altering the source', () => {
  const source = createLayoutRectangle('rectangle', [10, 10], [50, 40]);
  const before = structuredClone(source);
  expect(createLayoutOffset(source, 5).points).toEqual([[5, 5], [55, 5], [55, 45], [5, 45]]);
  expect(createLayoutOffset(source, -5).points).toEqual([[15, 15], [45, 15], [45, 35], [15, 35]]);
  expect(createLayoutOffset({ ...source, points: [...source.points].reverse() }, 5).points).toEqual([[5, 45], [55, 45], [55, 5], [5, 5]]);
  expect(source).toEqual(before);
  expect(layoutOffsetDistance(source, [55, 25])).toBe(5);
  expect(layoutOffsetDistance(source, [45, 25])).toBe(-5);
});

it('offsets open lines and multi-segment paths to either side with mitered corners and open ends', () => {
  const source = { points: [[0, 0], [20, 0], [20, 20]] as [number, number][], closed: false };
  expect(createLayoutOffset(source, 3)).toEqual({ points: [[0, 3], [17, 3], [17, 20]], closed: false });
  expect(createLayoutOffset(source, -3).points).toEqual([[0, -3], [23, -3], [23, 20]]);
  expect(layoutOffsetDistance(source, [10, 3])).toBe(3);
  expect(layoutOffsetDistance(source, [10, -3])).toBe(-3);
  const diagonal = createLayoutOffset({ points: [[0, 0], [10, 10]], closed: false }, 2);
  expect(diagonal.points[0]![0]).toBeCloseTo(-Math.SQRT2);
  expect(diagonal.points[0]![1]).toBeCloseTo(Math.SQRT2);
});

it('supports concave polygons and tessellates curved paths into editable offset outlines', () => {
  const concave = { points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]] as [number, number][], closed: true };
  expect(createLayoutOffset(concave, -2).points).toEqual([[2, 2], [28, 2], [28, 8], [8, 8], [8, 28], [2, 28]]);
  const arc = createLayoutArc('arc', [50, 50], [70, 50], [50, 70]);
  const boundary = layoutOffsetBoundary(arc);
  expect(boundary.length).toBeGreaterThan(10);
  const offset = createLayoutOffset(arc, 2);
  expect(offset.closed).toBe(false); expect(offset.handles).toBeUndefined();
  for (const p of offset.points) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(18, 1);
  const rounded = createLayoutRectangle('rounded-rectangle', [0, 0], [60, 30], 5);
  expect(createLayoutOffset(rounded, 2).closed).toBe(true);
});

it('rejects collapse, crossing sources/results, sharp reversals, zero, and nonfinite distances', () => {
  const source = createLayoutRectangle('rectangle', [0, 0], [20, 10]);
  for (const distance of [0, NaN, Infinity, -5, -6, -30]) expect(() => createLayoutOffset(source, distance)).toThrow();
  expect(() => createLayoutOffset({ points: [[0, 0], [20, 20], [0, 20], [20, 0]], closed: true }, 2)).toThrow('simple path');
  expect(() => createLayoutOffset({ points: [[0, 0], [20, 20], [0, 20], [20, 0]], closed: false }, 2)).toThrow('simple path');
  expect(() => createLayoutOffset({ points: [[0, 0], [20, 0], [10, 0]], closed: false }, 2)).toThrow('doubles back');
});

it('insets previously offset rounded rectangles beyond their remaining corner radius', () => {
  // OffsetTest.pfl contains nearly coincident, repeatedly inset rounded rectangles.
  const rounded = createLayoutRectangle('rounded-rectangle', [58, 37], [222, 140], 5);
  const first = createLayoutOffset(rounded, -4.27);
  const source = createLayoutOffset(first, -0.21);
  for (const original of [source, { ...source, points: [...source.points].reverse() }]) {
    const before = structuredClone(original);
    const inset = createLayoutOffset(original, -11);
    expect(inset.closed).toBe(true);
    expect(inset.points).toHaveLength(4);
    expect(Math.min(...inset.points.map(p => p[0]))).toBeCloseTo(73.48);
    expect(Math.max(...inset.points.map(p => p[0]))).toBeCloseTo(206.52);
    expect(Math.min(...inset.points.map(p => p[1]))).toBeCloseTo(52.48);
    expect(Math.max(...inset.points.map(p => p[1]))).toBeCloseTo(124.52);
    expect(original).toEqual(before);
    expect(() => createLayoutOffset(original, -60)).toThrow('collapses');
  }
});
