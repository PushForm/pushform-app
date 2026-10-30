// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { TextLayer, textArrowGeometry, textLabelPoint, TEXT_ARROW_PX } from './TextLayer';
import type { RenderText } from '../types';

describe('textLabelPoint', () => {
  it('puts a pushpin label at the anchor plus its offset, and a view-based one along the view', () => {
    expect(textLabelPoint({ position: [1, 2, 3], offset: [1, 0, 0], viewOffset: null }, [0, 1, 0], [0, 0, 1])).toEqual([2, 2, 3]);
    expect(textLabelPoint({ position: [1, 2, 3], offset: null, viewOffset: [2, 1] }, [0, 1, 0], [0, 0, 1])).toEqual([1, 4, 4]);
    expect(textLabelPoint({ position: [1, 2, 3], offset: null, viewOffset: null }, [0, 1, 0], [0, 0, 1])).toEqual([1, 2, 3]);
  });
});

describe('textArrowGeometry', () => {
  const tip = [0, 0, 0] as const, back = [1, 0, 0] as const, view = [0, 0, -1] as const;
  it('draws a closed arrow as a triangle a length back along the leader', () => {
    const g = textArrowGeometry('closed', tip, back, view, 0.01);
    expect(g.segments).toEqual([]);
    expect(g.triangles).toHaveLength(3);
    expect(g.triangles[1]![0]).toBeCloseTo(TEXT_ARROW_PX.length * 0.01, 12);
    expect(Math.abs(g.triangles[1]![1])).toBeCloseTo((TEXT_ARROW_PX.width / 2) * 0.01, 12);
  });
  it('draws open arrows and slashes as strokes, dots as a filled fan, and nothing for none', () => {
    expect(textArrowGeometry('open', tip, back, view, 1).segments).toHaveLength(4);
    expect(textArrowGeometry('slash', tip, back, view, 1).segments).toHaveLength(2);
    expect(textArrowGeometry('dot', tip, back, view, 1).triangles.length).toBeGreaterThanOrEqual(24);
    expect(textArrowGeometry('none', tip, back, view, 1)).toEqual({ triangles: [], segments: [] });
  });
});

describe('TextLayer', () => {
  const text = (over: Partial<RenderText> = {}): RenderText => ({
    id: '/1', text: 'A', kind: 'leader', position: [0, 0, 0], offset: [1, 0, 0], viewOffset: null, leader: 'pushpin', arrow: 'closed', color: '#000000', fontSizePt: 12, selected: false, ...over,
  });

  it('reports changes by identity and makes labels only on a drawn frame', () => {
    const layer = new TextLayer();
    const texts = { items: [text()] };
    expect(layer.set(texts)).toBe(true);
    expect(layer.set(texts)).toBe(false);
    expect(layer.isEmpty).toBe(false);
    // without a frame there is nothing laid out yet (troika needs WebGL)
    expect(layer.group.children.filter((c) => c.constructor.name === 'Text')).toHaveLength(0);
    expect(layer.set({ items: [] })).toBe(true);
    expect(layer.isEmpty).toBe(true);
    layer.dispose();
  });
});
