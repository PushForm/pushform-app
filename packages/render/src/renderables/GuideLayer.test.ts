// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { GUIDE_EXTENT, GuideLayer, buildGuideGeometry } from './GuideLayer';
import type { RenderGuides } from '../types';

const guides: RenderGuides = {
  lines: [{ id: 1, p: [1, 2, 3], dir: [0, 0, 2] }],
  points: [{ id: 2, p: [5, 5, 5] }],
  segments: [{ id: 3, a: [0, 0, 0], b: [1, 0, 0] }],
};

describe('buildGuideGeometry', () => {
  it('turns an infinite line into one long segment around its point (unit direction), plus finite segments', () => {
    const g = buildGuideGeometry(guides, [0, 0, 0]);
    expect(g.lines.positions.length / 6).toBe(2);
    expect(Array.from(g.lines.positions.slice(0, 6))).toEqual([1, 2, 3 - GUIDE_EXTENT, 1, 2, 3 + GUIDE_EXTENT]);
    expect(Array.from(g.lines.positions.slice(6, 12))).toEqual([0, 0, 0, 1, 0, 0]);
    // guide lines never widen to profiles: equal normals, no flags
    expect(g.lines.flags[0]).toBe(0);
    expect(g.lines.normalA[2]).toBe(1);
    expect(g.lines.normalB[2]).toBe(1);
    expect(Array.from(g.points)).toEqual([5, 5, 5]);
  });

  it('applies the floating origin and skips zero-length directions', () => {
    const g = buildGuideGeometry({ lines: [{ id: 1, p: [1, 1, 1], dir: [0, 0, 0] }], points: [{ id: 2, p: [5, 5, 5] }] }, [5, 0, 0]);
    expect(g.lines.positions.length).toBe(0);
    expect(Array.from(g.points)).toEqual([0, 5, 5]);
  });
});

describe('GuideLayer', () => {
  it('builds dashed lines and point glyphs, diffs by identity and clears on null', () => {
    const l = new GuideLayer();
    expect(l.lineMaterial.dashed).toBe(true);
    expect(l.isEmpty).toBe(true);
    expect(l.set(guides)).toBe(true);
    expect(l.set(guides)).toBe(false);
    expect(l.lines.segmentCount).toBe(2);
    expect(l.points.visible).toBe(true);
    expect(l.isEmpty).toBe(false);
    expect(l.set(null)).toBe(true);
    expect(l.isEmpty).toBe(true);
    l.dispose();
  });
});
