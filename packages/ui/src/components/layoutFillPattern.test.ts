// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { forgetLayoutImage, setLayoutCanvasPicture } from './layoutImage';
import { paintLayoutFillPattern } from './layoutFillPattern';

const SRC = 'data:image/png;base64,pattern-test';
afterEach(() => forgetLayoutImage(SRC));

function context() {
  const setTransform = vi.fn(), fills: { style: unknown; rule: unknown }[] = [];
  const ctx = {
    fillStyle: '#000000' as unknown, save: vi.fn(), restore: vi.fn(),
    createPattern: vi.fn(() => ({ setTransform })),
    fill(rule: unknown) { fills.push({ style: this.fillStyle, rule }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, setTransform, fills };
}

it('fills the path with the repeated picture, one picture per tile, from the origin and turned counterclockwise', () => {
  const picture = document.createElement('canvas'); picture.width = 40; picture.height = 20;
  setLayoutCanvasPicture(SRC, picture);
  const { ctx, raw, setTransform, fills } = context();
  paintLayoutFillPattern(ctx, { src: SRC, tileMm: [10, 5], originMm: [3, 4], scale: 2, rotationDeg: 90 }, true);
  expect(raw.createPattern).toHaveBeenCalledWith(picture, 'repeat');
  // A 20 × 10 mm tile of 40 × 20 px: 0.5 mm per pixel, its x axis turned to point up the page.
  const m = setTransform.mock.calls[0]![0] as Record<string, number>;
  expect([m.a, m.b, m.c, m.d, m.e, m.f].map(n => Math.round(n! * 1e9) / 1e9)).toEqual([0, -0.5, 0.5, 0, 3, 4]);
  expect(fills).toEqual([{ style: raw.createPattern.mock.results[0]!.value, rule: 'evenodd' }]);
  expect(raw.save).toHaveBeenCalled(); expect(raw.restore).toHaveBeenCalled();
});

it('paints nothing while the picture loads, and nothing without a pattern', () => {
  const { ctx, raw, fills } = context();
  paintLayoutFillPattern(ctx, undefined, false);
  paintLayoutFillPattern(ctx, { src: SRC, tileMm: [10, 5], originMm: [0, 0], scale: 1, rotationDeg: 0 }, false);
  expect(raw.createPattern).not.toHaveBeenCalled();
  expect(fills).toEqual([]);
});
