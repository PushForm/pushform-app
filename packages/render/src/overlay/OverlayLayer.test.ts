// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pushform/core';
import { boxSegments, circleSegments, polygonTriangles } from './OverlayLayer';

describe('overlay circle / box segments', () => {
  it('circle: ring segments on the plane at the radius, plus ticks with longer major ticks', () => {
    const segs = circleSegments({ center: [1, 1, 0], normal: [0, 0, 1], radius: 2, ticks: 24 }, 72);
    expect(segs).toHaveLength(72 + 24);
    for (const [a, b] of segs.slice(0, 72)) {
      expect(Math.hypot(a![0] - 1, a![1] - 1)).toBeCloseTo(2);
      expect(a![2]).toBeCloseTo(0);
      expect(b![2]).toBeCloseTo(0);
    }
    const ticks = segs.slice(72);
    const len = (s: readonly (readonly number[])[]) => Math.hypot(s[0]![0]! - s[1]![0]!, s[0]![1]! - s[1]![1]!, s[0]![2]! - s[1]![2]!);
    expect(len(ticks[0]!)).toBeCloseTo(2 * 0.18); // major (every 90°)
    expect(len(ticks[1]!)).toBeCloseTo(2 * 0.1); // minor (15°)
    expect(len(ticks[6]!)).toBeCloseTo(2 * 0.18);
  });

  it('box: 12 edges of the axis-aligned box', () => {
    const segs = boxSegments([0, 0, 0], [1, 2, 3]);
    expect(segs).toHaveLength(12);
    const lengths = segs.map(([a, b]) => Math.hypot(b![0] - a![0], b![1] - a![1], b![2] - a![2])).sort((x, y) => x - y);
    expect(lengths).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });
});

/** Triangles of a polygon overlay as [a, b, c] point triples, with their unsigned areas. */
function triangles(pos: Float32Array): { pts: Vec3[]; area: number }[] {
  const out: { pts: Vec3[]; area: number }[] = [];
  for (let i = 0; i < pos.length; i += 9) {
    const a: Vec3 = [pos[i]!, pos[i + 1]!, pos[i + 2]!];
    const b: Vec3 = [pos[i + 3]!, pos[i + 4]!, pos[i + 5]!];
    const c: Vec3 = [pos[i + 6]!, pos[i + 7]!, pos[i + 8]!];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    out.push({ pts: [a, b, c], area: Math.hypot(cross[0]!, cross[1]!, cross[2]!) / 2 });
  }
  return out;
}
const centroid = (t: Vec3[]): Vec3 => [0, 1, 2].map((k) => (t[0]![k]! + t[1]![k]! + t[2]![k]!) / 3) as unknown as Vec3;

describe('overlay polygon fill', () => {
  it('keeps a concave outline inside its boundary', () => {
    // L shape (area 3) with its notch at x > 1, y > 1; a fan from (2, 0) would cover the notch (area 4)
    const outline: Vec3[] = [[2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0], [0, 0, 0]];
    const tris = triangles(polygonTriangles({ points: outline }, [0, 0, 0]));
    expect(tris.reduce((s, t) => s + t.area, 0)).toBeCloseTo(3);
    for (const t of tris) {
      const c = centroid(t.pts);
      expect(c[0] > 1 && c[1] > 1).toBe(false);
    }
  });

  it('leaves holes open, in any plane, relative to the origin', () => {
    // a 4 × 4 square with a 2 × 2 hole, standing in the XZ plane at y = 5
    const outer: Vec3[] = [[0, 5, 0], [4, 5, 0], [4, 5, 4], [0, 5, 4]];
    const hole: Vec3[] = [[1, 5, 1], [3, 5, 1], [3, 5, 3], [1, 5, 3]];
    const tris = triangles(polygonTriangles({ points: outer, holes: [hole] }, [0, 5, 0]));
    expect(tris.reduce((s, t) => s + t.area, 0)).toBeCloseTo(12);
    for (const t of tris) {
      const c = centroid(t.pts);
      expect(c[1]).toBeCloseTo(0);
      expect(c[0] > 1 && c[0] < 3 && c[2] > 1 && c[2] < 3).toBe(false);
    }
  });

  it('draws nothing for a degenerate outline', () => {
    expect(polygonTriangles({ points: [[0, 0, 0], [1, 0, 0]] }, [0, 0, 0])).toHaveLength(0);
    expect(polygonTriangles({ points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }, [0, 0, 0])).toHaveLength(0);
  });
});