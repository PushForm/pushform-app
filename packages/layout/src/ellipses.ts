// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];

/** Bézier control distance for a quarter circle of radius 1. */
const QUARTER = 4 / 3 * Math.tan(Math.PI / 8);

/**
 * Paper-space ellipse (a circle when the radii match) as four Bézier quarters, the way .layout files store one: anchors at
 * the right, bottom, left and top extremes, each with smooth handles along the tangent.
 */
export function createLayoutEllipse(center: Point, rx: number, ry: number): LayoutRectanglePath {
  if (![...center, rx, ry].every(Number.isFinite) || rx <= 1e-6 || ry <= 1e-6) throw new Error('An ellipse needs a width and height greater than zero.');
  const [cx, cy] = center, kx = rx * QUARTER, ky = ry * QUARTER;
  return {
    points: [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]],
    handles: [
      { in: [cx + rx, cy - ky], out: [cx + rx, cy + ky] },
      { in: [cx + kx, cy + ry], out: [cx - kx, cy + ry] },
      { in: [cx - rx, cy + ky], out: [cx - rx, cy - ky] },
      { in: [cx - kx, cy - ry], out: [cx + kx, cy - ry] },
    ],
    closed: true,
  };
}
