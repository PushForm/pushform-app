// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Rgb } from '@pushform/model';
import { rgbToCss } from '../engine/format';

export { rgbToCss };

/** CSS hex (`#rrggbb`) → `[r, g, b]` in 0..1; black for malformed input. */
export function cssToRgb(css: string): [number, number, number] {
  let h = css.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0]! + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const sameRgb = (a: Rgb, b: Rgb): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
