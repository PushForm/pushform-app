// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];

/** The side counts the Polygon tools draw. */
export const LAYOUT_POLYGON_MIN_SIDES = 3, LAYOUT_POLYGON_MAX_SIDES = 100;

/** Paper-space regular polygon: reference selects a vertex or the midpoint of a tangent side. */
export function createLayoutPolygon(center: Point, reference: Point, mode: 'inscribed' | 'circumscribed' = 'inscribed', sides = 6): LayoutRectanglePath {
  if (!Number.isSafeInteger(sides) || sides < LAYOUT_POLYGON_MIN_SIDES) throw new Error('A polygon needs at least three sides.');
  if (sides > LAYOUT_POLYGON_MAX_SIDES) throw new Error(`A polygon can have at most ${LAYOUT_POLYGON_MAX_SIDES} sides.`);
  const radius = Math.hypot(reference[0] - center[0], reference[1] - center[1]);
  if (!center.every(Number.isFinite) || !reference.every(Number.isFinite) || !Number.isFinite(radius) || radius <= LENGTH_TOL * 1000)
    throw new Error('Choose a polygon radius greater than zero.');
  const vertexRadius = mode === 'circumscribed' ? radius / Math.cos(Math.PI / sides) : radius;
  const start = Math.atan2(reference[1] - center[1], reference[0] - center[0]) + (mode === 'circumscribed' ? Math.PI / sides : 0);
  return { points: Array.from({ length: sides }, (_, index): Point => {
    const angle = start + index * 2 * Math.PI / sides;
    return [center[0] + vertexRadius * Math.cos(angle), center[1] + vertexRadius * Math.sin(angle)];
  }), closed: true };
}

/**
 * The polygon reference point snapped to the nearest 90° direction from the center: when `reference` lies
 * within `toleranceMm` of the horizontal or vertical line through the center, it turns onto that line at the same
 * distance, so the polygon sits square on the page. Null when it is farther from both lines, or no farther from the
 * center than the tolerance.
 */
export function snapLayoutPolygonReference(center: Point, reference: Point, toleranceMm: number): Point | null {
  const dx = reference[0] - center[0], dy = reference[1] - center[1], radius = Math.hypot(dx, dy);
  if (!(radius > toleranceMm) || Math.min(Math.abs(dx), Math.abs(dy)) > toleranceMm) return null;
  return Math.abs(dx) >= Math.abs(dy) ? [center[0] + Math.sign(dx) * radius, center[1]] : [center[0], center[1] + Math.sign(dy) * radius];
}
