// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { planeBasis, v3cross, v3dot, v3sub, type Vec3 } from '@pushform/core';
import { polygonInteriorPoint, triangulatePlanarFace, triangulatePolygon } from './triangulate';
import { pointInPolygon } from './polygon2d';

describe('triangulate', () => {
  it('square with a hole → 8 triangles, CCW', () => {
    const poly = [
      [[0, 0], [4, 0], [4, 4], [0, 4]],
      [[1, 1], [1, 2], [2, 2], [2, 1]], // CCW hole on purpose; normalized inside
    ];
    const t = triangulatePolygon(poly);
    expect(t.indices.length / 3).toBe(8);
    expect(t.ringStarts).toEqual([0, 4]);
    let area = 0;
    for (let i = 0; i < t.indices.length; i += 3) {
      const a = t.indices[i]! * 2, b = t.indices[i + 1]! * 2, c = t.indices[i + 2]! * 2;
      area += ((t.coords[b]! - t.coords[a]!) * (t.coords[c + 1]! - t.coords[a + 1]!) - (t.coords[c]! - t.coords[a]!) * (t.coords[b + 1]! - t.coords[a + 1]!)) / 2;
    }
    expect(area).toBeCloseTo(15);
    const ip = polygonInteriorPoint(poly)!;
    expect(pointInPolygon(ip, [poly[0]!, poly[1]!.slice().reverse()])).toBe(true);
  });
  it('planar face in 3D is triangulated CCW about the basis normal', () => {
    const n: Vec3 = [0, 1, 0];
    const basis = planeBasis([0, 2, 0], n);
    const ring: Vec3[] = [[0, 2, 0], [0, 2, 3], [3, 2, 3], [3, 2, 0]]; // CW about +y
    const t = triangulatePlanarFace([ring], basis);
    expect(t.indices.length / 3).toBe(2);
    const P = (i: number): Vec3 => [t.positions[i * 3]!, t.positions[i * 3 + 1]!, t.positions[i * 3 + 2]!];
    for (let i = 0; i < t.indices.length; i += 3) {
      const a = P(t.indices[i]!), b = P(t.indices[i + 1]!), c = P(t.indices[i + 2]!);
      const tn = v3cross(v3sub(b, a), v3sub(c, a));
      expect(v3dot(tn, n)).toBeGreaterThan(0);
    }
  });
});
