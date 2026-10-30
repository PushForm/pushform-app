// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { planeFromPointNormal } from '@pushform/core';
import {
  lineLineClosest3D,
  pointSegmentClosest3D,
  segSegClosest3D,
  segSegIntersect2D,
  segmentPlane,
  segmentsCoplanar,
} from './intersections';

describe('intersections', () => {
  it('2D segment crossing', () => {
    const r = segSegIntersect2D([0, 0], [2, 2], [0, 2], [2, 0]);
    expect(r.kind).toBe('point');
    if (r.kind === 'point') {
      expect(r.t).toBeCloseTo(0.5);
      expect(r.s).toBeCloseTo(0.5);
      expect(r.point).toEqual([1, 1]);
    }
    expect(segSegIntersect2D([0, 0], [1, 0], [2, 1], [2, -1]).kind).toBe('none');
    expect(segSegIntersect2D([0, 0], [1, 0], [0, 1], [1, 1]).kind).toBe('none');
    const touching = segSegIntersect2D([0, 0], [2, 0], [1, 1e-12], [1, 1], 1e-9);
    expect(touching.kind).toBe('point');
  });
  it('2D collinear overlap', () => {
    const r = segSegIntersect2D([0, 0], [4, 0], [2, 0], [6, 0]);
    expect(r.kind).toBe('collinear');
    if (r.kind === 'collinear') expect(r.overlap).toEqual([0.5, 1]);
    const d = segSegIntersect2D([0, 0], [1, 0], [2, 0], [3, 0]);
    expect(d.kind).toBe('collinear');
    if (d.kind === 'collinear') expect(d.overlap).toBeNull();
  });
  it('3D line/line and segment/segment closest points', () => {
    const l = lineLineClosest3D([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
    expect(l.distSq).toBeCloseTo(1);
    expect(l.t).toBeCloseTo(0);
    expect(l.s).toBeCloseTo(0);
    expect(l.parallel).toBe(false);
    const s = segSegClosest3D([0, 0, 0], [1, 0, 0], [3, -1, 0], [3, 1, 0]);
    expect(s.t).toBeCloseTo(1);
    expect(s.s).toBeCloseTo(0.5);
    expect(s.distSq).toBeCloseTo(4);
    const par = lineLineClosest3D([0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0]);
    expect(par.parallel).toBe(true);
    expect(par.distSq).toBeCloseTo(1);
    expect(pointSegmentClosest3D([5, 1, 0], [0, 0, 0], [2, 0, 0]).point).toEqual([2, 0, 0]);
  });
  it('segment/plane', () => {
    const pl = planeFromPointNormal([0, 0, 1], [0, 0, 1]);
    const h = segmentPlane([0, 0, 0], [0, 0, 2], pl);
    expect(h?.t).toBeCloseTo(0.5);
    expect(h?.point).toEqual([0, 0, 1]);
    expect(segmentPlane([0, 0, 2], [0, 0, 3], pl)).toBeNull();
    expect(segmentPlane([0, 0, 1], [1, 0, 1], pl, 1e-9)).toBeNull();
    expect(segmentsCoplanar([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], 1e-9)).toBe(true);
    expect(segmentsCoplanar([0, 0, 0], [1, 0, 0], [0, 1, 1], [0, -1, 1], 1e-9)).toBe(false);
  });
});
