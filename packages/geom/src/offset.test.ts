// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { offsetPolygon, offsetPolygonFull, offsetPolyline, type OffsetArc } from './offset';
import { polygonArea, signedArea, type PolygonsWithHoles } from './polygon2d';

const sq = (s: number, o = 0): number[][] => [
  [o, o],
  [o + s, o],
  [o + s, o + s],
  [o, o + s],
];

const sortedPts = (ring: number[][]): number[][] =>
  ring.map((p) => [+p[0]!.toFixed(9), +p[1]!.toFixed(9)]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);

describe('offsetPolygon', () => {
  it('shrinks a unit square inward by 0.1 to a 0.8 square', () => {
    const o = offsetPolygon([sq(1)], -0.1);
    expect(o).toHaveLength(1);
    expect(signedArea(o[0]!)).toBeCloseTo(0.64, 9);
    expect(sortedPts(o[0]!)).toEqual([
      [0.1, 0.1],
      [0.1, 0.9],
      [0.9, 0.1],
      [0.9, 0.9],
    ]);
  });

  it('grows a unit square outward by 0.1 to a 1.2 square', () => {
    const o = offsetPolygon([sq(1)], 0.1);
    expect(o).toHaveLength(1);
    expect(o[0]).toHaveLength(4);
    expect(signedArea(o[0]!)).toBeCloseTo(1.44, 9);
    expect(sortedPts(o[0]!)).toEqual([
      [-0.1, -0.1],
      [-0.1, 1.1],
      [1.1, -0.1],
      [1.1, 1.1],
    ]);
  });

  it('handles the concave corner of an L-shape', () => {
    const L: PolygonsWithHoles = [
      [
        [0, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ],
    ];
    const inward = offsetPolygon(L, -0.2);
    expect(inward[0]).toHaveLength(6);
    expect(signedArea(inward[0]!)).toBeCloseTo(1.56, 9);
    expect(sortedPts(inward[0]!)).toEqual([
      [0.2, 0.2],
      [0.2, 1.8],
      [0.8, 0.8],
      [0.8, 1.8],
      [1.8, 0.2],
      [1.8, 0.8],
    ]);
    const outward = offsetPolygon(L, 0.2);
    expect(outward[0]).toHaveLength(6);
    // bbox 2.4 × 2.4 = 5.76 minus the remaining notch [1.2, 2.2]² = 1 → 4.76
    expect(signedArea(outward[0]!)).toBeCloseTo(4.76, 9);
  });

  it('offsets a square with a hole: the hole grows when the polygon shrinks', () => {
    const poly: PolygonsWithHoles = [sq(1), sq(0.2, 0.4).reverse()];
    const o = offsetPolygon(poly, -0.1);
    expect(o).toHaveLength(2);
    expect(signedArea(o[0]!)).toBeCloseTo(0.64, 9);
    expect(signedArea(o[1]!)).toBeCloseTo(-0.16, 9);
    expect(polygonArea(o)).toBeCloseTo(0.48, 9);
    const grown = offsetPolygon(poly, 0.05);
    expect(signedArea(grown[0]!)).toBeCloseTo(1.21, 9);
    expect(signedArea(grown[1]!)).toBeCloseTo(-0.01, 9);
  });

  it('removes the hole when it would merge with the outer ring and vanishes past the inradius', () => {
    const poly: PolygonsWithHoles = [sq(1), sq(0.2, 0.4).reverse()];
    const o = offsetPolygon(poly, -0.25);
    // outer 0.25..0.75 (0.5²), hole 0.15..0.85: the hole swallows the outer → nothing left
    expect(o).toEqual([]);
    expect(offsetPolygon([sq(1)], -0.6)).toEqual([]);
  });

  it('splits a dumbbell into two polygons when the neck collapses', () => {
    const dumbbell: PolygonsWithHoles = [
      [
        [0, 0],
        [1, 0],
        [1, 0.4],
        [2, 0.4],
        [2, 0],
        [3, 0],
        [3, 1],
        [2, 1],
        [2, 0.6],
        [1, 0.6],
        [1, 1],
        [0, 1],
      ],
    ];
    const r = offsetPolygonFull(dumbbell, -0.15);
    expect(r.polygons).toHaveLength(2);
    for (const p of r.polygons) expect(signedArea(p[0]!)).toBeCloseTo(0.7 * 0.7, 9);
    expect(r.tags[0]![0]).toHaveLength(r.polygons[0]![0]!.length);
  });

  it('keeps raw overlaps when cleanup is off', () => {
    const o = offsetPolygon([sq(1)], -0.6, { cleanup: false });
    expect(o).toHaveLength(1);
    expect(o[0]).toHaveLength(4);
    expect(signedArea(o[0]!)).toBeCloseTo(0.04, 9); // inverted mitre ring, left as-is
  });

  it('offsets arc runs concentrically and tags the output edges', () => {
    const n = 24;
    const arc: OffsetArc = { key: 'c1', center: [0, 0], radius: 1 };
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    const tags = ring.map(() => arc);
    const r = offsetPolygonFull([ring], 0.5, { arcs: [tags] });
    expect(r.polygons).toHaveLength(1);
    const out = r.polygons[0]![0]!;
    expect(out).toHaveLength(n);
    for (const p of out) expect(Math.hypot(p[0]!, p[1]!)).toBeCloseTo(1.5, 9);
    expect(r.tags[0]![0]!.every((t) => t?.key === 'c1')).toBe(true);
    const inner = offsetPolygon([ring], -0.25, { arcs: [tags] });
    for (const p of inner[0]!) expect(Math.hypot(p[0]!, p[1]!)).toBeCloseTo(0.75, 9);
  });

  it('bevels mitres past the mitre limit', () => {
    const spike: PolygonsWithHoles = [
      [
        [0, 0],
        [4, 0],
        [0, 0.2],
      ],
    ];
    const o = offsetPolygon(spike, 0.1, { mitreLimit: 2 });
    expect(o[0]!.length).toBeGreaterThan(3);
    const maxX = Math.max(...o[0]!.map((p) => p[0]!));
    expect(maxX).toBeLessThan(4.3);
  });
});

describe('offsetPolyline', () => {
  it('offsets an open chain to the right of travel with mitred joins', () => {
    const o = offsetPolyline(
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      0.1,
    );
    expect(o).toHaveLength(3);
    expect(o[0]).toEqual([0, -0.1]);
    expect(o[1]![0]).toBeCloseTo(1.1);
    expect(o[1]![1]).toBeCloseTo(-0.1);
    expect(o[2]![0]).toBeCloseTo(1.1);
    expect(o[2]![1]).toBeCloseTo(1);
  });
});
