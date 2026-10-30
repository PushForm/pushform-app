// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import type { Vec3 } from '@pushform/core';
import type { RenderDimension } from '../types';
import { alignedTextFrame, buildArrowTriangles, buildDimensionEndpoints, buildDimensionLines, DIMENSION_ARROW_PX, DimensionLayer } from './DimensionLayer';

const item = (over: Partial<RenderDimension> = {}): RenderDimension => ({
  id: 1, lines: [[[0, 0, 0], [0, 1, 0]], [[0, 1, 0], [2, 1, 0]]], arrows: [{ tip: [0, 1, 0], back: [1, 0, 0] }],
  text: '2.000m', textAt: [1, 1, 0], fontSizePt: 10, selected: false, ...over,
});

describe('dimension geometry', () => {
  it('lays out lines origin-relative, selected ones apart', () => {
    const { normal, selected } = buildDimensionLines([item(), item({ id: 2, selected: true, lines: [[[5, 5, 5], [6, 5, 5]]] })], [1, 0, 0]);
    expect([...normal]).toEqual([-1, 0, 0, -1, 1, 0, -1, 1, 0, 1, 1, 0]);
    expect([...selected]).toEqual([4, 5, 5, 5, 5, 5]);
  });

  it('sizes arrowheads in screen pixels across the line, facing the camera', () => {
    // Looking down -z at 0.01 m per pixel: a 10 px long, 6 px wide head back along +x from the tip.
    const tri = buildArrowTriangles([{ tip: [0, 1, 0], back: [1, 0, 0] }], [0, 0, 0], [0, 0, -1], () => 0.01);
    const l = DIMENSION_ARROW_PX.length * 0.01, w = (DIMENSION_ARROW_PX.width / 2) * 0.01;
    const expected = [0, 1, 0, l, 1 + w, 0, l, 1 - w, 0];
    [...tri].forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6));
  });

  it('keeps text and arrowheads a fixed screen size as the camera zooms', () => {
    const layer = new DimensionLayer();
    expect(layer.set({ items: [item()] }, [0, 0, 0])).toBe(true);
    const camera = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const label = layer.group.children.find((c) => (c as { text?: string }).text === '2.000m')!;
    layer.update(camera, () => 0.01);
    const near = label.scale.x;
    layer.update(camera, () => 0.02);
    expect(label.scale.x).toBeCloseTo(near * 2, 9);
    expect(near).toBeCloseTo(0.01 * 10 * (96 / 72), 9);
    layer.dispose();
  });

  it('hides the arrowheads once the last dimension is gone', () => {
    const layer = new DimensionLayer();
    layer.set({ items: [item()] }, [0, 0, 0]);
    const camera = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    layer.update(camera, () => 0.01);
    const visibleMeshes = () => layer.group.children.filter((c) => c.type === 'Mesh' && !('text' in c) && c.visible).length;
    expect(visibleMeshes()).toBe(1);
    layer.set({ items: [] }, [0, 0, 0]);
    layer.update(camera, () => 0.01);
    expect(visibleMeshes()).toBe(0);
    layer.dispose();
  });
});

describe('dimension endpoints and aligned text', () => {
  const base = { id: 1, lines: [], text: '2m', textAt: [1, 0, 0] as Vec3, fontSizePt: 10, selected: false };
  const arrows = [{ tip: [0, 0, 0] as Vec3, back: [1, 0, 0] as Vec3 }, { tip: [2, 0, 0] as Vec3, back: [-1, 0, 0] as Vec3 }];
  const view: Vec3 = [0, 0, -1];

  it('draws closed arrows and dots as triangles, open arrows and slashes as lines, and nothing for none', () => {
    const at = (arrow?: RenderDimension['arrow']) => buildDimensionEndpoints([{ ...base, arrows, ...(arrow ? { arrow } : {}) }], [0, 0, 0], view, () => 0.01);
    expect(at().triangles.length).toBe(2 * 9);
    expect(at().segments.length).toBe(0);
    expect(at('dot').triangles.length).toBeGreaterThan(2 * 9);
    expect(at('open').triangles.length).toBe(0);
    expect(at('open').segments.length).toBe(2 * 4 * 3);
    expect(at('slash').segments.length).toBe(2 * 2 * 3);
    expect(at('none')).toEqual({ triangles: new Float32Array(0), segments: new Float32Array(0) });
  });

  it('reads aligned text left to right, facing the camera, above, on or outside the line', () => {
    const right: Vec3 = [1, 0, 0], up: Vec3 = [0, 1, 0];
    // A line drawn right to left, measured points below it (out = +y), seen from above.
    const aligned = { along: [-1, 0, 0] as Vec3, out: [0, 1, 0] as Vec3, position: 'above' as const };
    const z0 = (v: Vec3): number[] => v.map((x) => x + 0);
    const above = alignedTextFrame(aligned, [1, 0, 0], view, right, up, 0.2);
    expect(z0(above.x)).toEqual([1, 0, 0]);
    expect(above.z[2]).toBeGreaterThan(0);
    expect(z0(above.position)).toEqual([1, 0.2, 0]);
    expect(z0(alignedTextFrame({ ...aligned, position: 'centered' }, [1, 0, 0], view, right, up, 0.2).position)).toEqual([1, 0, 0]);
    // Outside is away from the measured points even where that is below the text.
    expect(z0(alignedTextFrame({ ...aligned, out: [0, -1, 0], position: 'outside' }, [1, 0, 0], view, right, up, 0.2).position)).toEqual([1, -0.2, 0]);
    // A vertical line reads bottom to top.
    expect(z0(alignedTextFrame({ ...aligned, along: [0, -1, 0], out: [1, 0, 0] }, [0, 0, 0], view, right, up, 0.2).x)).toEqual([0, 1, 0]);
  });
});
