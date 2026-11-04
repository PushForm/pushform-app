// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { GUIDE_EXTENT, GUIDE_POINT_SIZE, GUIDE_POINT_STROKE, GuideLayer, buildGuideGeometry, guidePointGlyph } from './GuideLayer';
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

describe('guide point glyph', () => {
  it('is an upright + six pixels across with two-pixel arms, centered on the point', () => {
    expect(guidePointGlyph()).toEqual([
      '..##..',
      '..##..',
      '######',
      '######',
      '..##..',
      '..##..',
    ]);
  });

  it('keeps its pixel size at any distance and scales only with the device pixel ratio', () => {
    const l = new GuideLayer();
    const size = l.pointMaterial.uniforms['uSize'], stroke = l.pointMaterial.uniforms['uStroke'];
    expect(size?.value).toBe(GUIDE_POINT_SIZE);
    expect(stroke?.value).toBeCloseTo(GUIDE_POINT_STROKE / GUIDE_POINT_SIZE, 12);
    // the vertex shader sets a fixed point size, with no division by depth
    expect(l.pointMaterial.vertexShader).toMatch(/gl_PointSize = uSize;/);
    l.setResolution(800, 600, 2);
    expect(size?.value).toBe(GUIDE_POINT_SIZE * 2);
    // at twice the pixels the glyph keeps its shape: arms twice as long and wide
    expect(guidePointGlyph(GUIDE_POINT_SIZE * 2, GUIDE_POINT_STROKE * 2)).toEqual(
      guidePointGlyph().flatMap((row) => { const wide = [...row].map((c) => c + c).join(''); return [wide, wide]; }),
    );
    l.dispose();
  });
});
