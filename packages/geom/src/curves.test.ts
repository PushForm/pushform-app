// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { v3dist } from '@pushform/core';
import { arcFrom3Points, arcFromBulge, tessellateArc, tessellateCircle, tessellateCurve, tessellatePolygon } from './curves';

describe('curves', () => {
  it('circle has `segments` points on the radius, CCW about the normal', () => {
    const { points, curve } = tessellateCircle([1, 1, 0], [0, 0, 1], 2, 24);
    expect(points).toHaveLength(24);
    for (const p of points) expect(v3dist(p, [1, 1, 0])).toBeCloseTo(2);
    expect(points[0]).toEqual([3, 1, 0]);
    expect(points[6]![1]).toBeCloseTo(3);
    expect(tessellateCurve(curve)).toEqual(points);
    expect(tessellatePolygon([0, 0, 0], [0, 0, 1], 1, 6).curve.kind).toBe('polygon');
  });
  it('arc spans start..end with segments+1 points', () => {
    const { points } = tessellateArc([0, 0, 0], [0, 0, 1], 1, 0, Math.PI / 2, 4);
    expect(points).toHaveLength(5);
    expect(points[0]![0]).toBeCloseTo(1);
    expect(points[4]![1]).toBeCloseTo(1);
    expect(points[4]![0]).toBeCloseTo(0);
  });
  it('3-point arc passes through all three points', () => {
    const t = arcFrom3Points([1, 0, 0], [0, 1, 0], [-1, 0, 0], 8)!;
    expect(t.curve.radius).toBeCloseTo(1);
    expect(t.curve.center[0]).toBeCloseTo(0);
    expect(t.points[0]![0]).toBeCloseTo(1);
    expect(t.points[4]![1]).toBeCloseTo(1);
    expect(t.points[8]![0]).toBeCloseTo(-1);
    expect(arcFrom3Points([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull();
    // reversed order flips the normal so the arc still goes through the middle point
    const r = arcFrom3Points([-1, 0, 0], [0, 1, 0], [1, 0, 0], 8)!;
    expect(r.curve.normal[2]).toBeCloseTo(-1);
    expect(r.points[4]![1]).toBeCloseTo(1);
  });
  it('bulge arc: bulge 1 is a semicircle', () => {
    const t = arcFromBulge([0, 0, 0], [2, 0, 0], 1, [0, 0, 1], 4)!;
    expect(t.curve.radius).toBeCloseTo(1);
    expect(t.curve.center[0]).toBeCloseTo(1);
    expect(t.curve.center[1]).toBeCloseTo(0);
    expect(t.points[0]![0]).toBeCloseTo(0);
    expect(t.points[4]![0]).toBeCloseTo(2);
    expect(t.points[2]![1]).toBeCloseTo(-1); // CCW from a to b about +z bulges to -y
    const neg = arcFromBulge([0, 0, 0], [2, 0, 0], -1, [0, 0, 1], 4)!;
    expect(neg.points[2]![1]).toBeCloseTo(1);
  });
});
