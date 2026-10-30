// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4invert, m4mul, m4rotationAxis, m4transformPoint, m4translation } from './mat4';
import { planeBasis, planeFromPoints, planeDistance, basisToLocal, basisToWorld } from './plane';
import { rayTriangle, raySegmentClosest } from './ray';
import { v3eq } from './vec3';

describe('mat4', () => {
  it('inverts translation·rotation', () => {
    const m = m4mul(m4translation([1, 2, 3]), m4rotationAxis([0, 0, 1], Math.PI / 3));
    const inv = m4invert(m)!;
    const p = m4transformPoint(m4mul(m, inv), [4, 5, 6]);
    expect(v3eq(p, [4, 5, 6], 1e-12)).toBe(true);
  });
});
describe('plane', () => {
  it('builds SketchUp-style basis and round-trips', () => {
    const b = planeBasis([1, 1, 1], [0, 0, 1]);
    expect(v3eq(b.u, [1, 0, 0])).toBe(true);
    expect(v3eq(b.v, [0, 1, 0])).toBe(true);
    const local = basisToLocal(b, [3, 4, 1]);
    expect(local).toEqual([2, 3, 0]);
    expect(v3eq(basisToWorld(b, 2, 3), [3, 4, 1])).toBe(true);
  });
  it('plane from points has signed distance', () => {
    const pl = planeFromPoints([0, 0, 0], [1, 0, 0], [0, 1, 0])!;
    expect(planeDistance(pl, [0, 0, 2])).toBeCloseTo(2);
  });
});
describe('ray', () => {
  it('hits a triangle', () => {
    const t = rayTriangle({ origin: [0.2, 0.2, 5], dir: [0, 0, -1] }, [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(t).toBeCloseTo(5);
  });
  it('closest point to a segment', () => {
    const r = raySegmentClosest({ origin: [0, 0, 5], dir: [0, 0, -1] }, [-1, 0.5, 0], [1, 0.5, 0]);
    expect(r.s).toBeCloseTo(0.5);
    expect(Math.sqrt(r.distSq)).toBeCloseTo(0.5);
  });
});
