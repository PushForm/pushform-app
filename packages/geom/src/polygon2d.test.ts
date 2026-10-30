// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import {
  dedupeRing,
  normalizePolygon,
  offsetPolygon,
  pointInPolygon,
  pointInRing,
  pointOnRing,
  polygonArea,
  polygonBounds,
  ringCentroid,
  signedArea,
} from './polygon2d';

const sq = (s: number, o = 0): number[][] => [
  [o, o],
  [o + s, o],
  [o + s, o + s],
  [o, o + s],
];

describe('polygon2d', () => {
  it('signed area and orientation', () => {
    expect(signedArea(sq(2))).toBeCloseTo(4);
    expect(signedArea(sq(2).reverse())).toBeCloseTo(-4);
    const norm = normalizePolygon([sq(4).reverse(), sq(1, 1)]);
    expect(signedArea(norm[0]!)).toBeGreaterThan(0);
    expect(signedArea(norm[1]!)).toBeLessThan(0);
    expect(polygonArea(norm)).toBeCloseTo(15);
  });
  it('point in polygon with holes', () => {
    const poly = [sq(4), sq(1, 1).reverse()];
    expect(pointInRing([0.5, 0.5], sq(4))).toBe(true);
    expect(pointInPolygon([0.5, 0.5], poly)).toBe(true);
    expect(pointInPolygon([1.5, 1.5], poly)).toBe(false);
    expect(pointInPolygon([5, 5], poly)).toBe(false);
    expect(pointOnRing([2, 0], sq(4), 1e-9)).toBe(true);
    expect(pointOnRing([2, 0.1], sq(4), 1e-9)).toBe(false);
  });
  it('bounds, centroid, dedupe', () => {
    const b = polygonBounds([sq(3, 1)]);
    expect(b.min).toEqual([1, 1]);
    expect(b.max).toEqual([4, 4]);
    expect(ringCentroid(sq(2))).toEqual([1, 1]);
    expect(dedupeRing([[0, 0], [0, 0], [1, 0], [1, 1], [0, 1], [0, 1e-12]], 1e-9)).toHaveLength(4);
  });
  it('offset (naive miter) grows a square', () => {
    const o = offsetPolygon([sq(2)], 0.5);
    expect(signedArea(o[0]!)).toBeCloseTo(9);
    expect(o[0]![0]![0]).toBeCloseTo(-0.5);
  });
});
