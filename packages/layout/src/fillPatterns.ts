// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutFillPattern } from './LayoutDocument';

/** Pictures without a stored resolution are this many pixels per inch. */
export const LAYOUT_PATTERN_DEFAULT_DPI = 96;

/**
 * The affine map, as Canvas `transform(a, b, c, d, e, f)` arguments, from one tile's unit square ([0, 0] its
 * top-left, [1, 1] its bottom-right corner) to paper millimeters. Tile (i, j) is the unit square moved by (i, j).
 */
export function layoutFillPatternMatrix(pattern: LayoutFillPattern): [number, number, number, number, number, number] {
  const radians = pattern.rotationDeg * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const width = pattern.tileMm[0] * pattern.scale, height = pattern.tileMm[1] * pattern.scale;
  // Paper y points down, so a counterclockwise turn on the page takes +x toward -y.
  return [width * cos, -width * sin, height * sin, height * cos, pattern.originMm[0], pattern.originMm[1]];
}

export function validLayoutFillPattern(pattern: unknown): pattern is LayoutFillPattern {
  if (!pattern || typeof pattern !== 'object') return false;
  const p = pattern as Partial<LayoutFillPattern>;
  const pair = (value: unknown, positive: boolean) => Array.isArray(value) && value.length === 2 &&
    value.every(n => typeof n === 'number' && Number.isFinite(n) && (!positive || n > 0));
  return typeof p.src === 'string' && /^data:image\/(png|jpeg);/.test(p.src) && pair(p.tileMm, true) && pair(p.originMm, false) &&
    typeof p.scale === 'number' && Number.isFinite(p.scale) && p.scale > 0 &&
    typeof p.rotationDeg === 'number' && Number.isFinite(p.rotationDeg);
}
