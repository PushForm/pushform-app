// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutPathHandle } from './LayoutDocument';
import type { LayoutRectanglePath } from './rectangles';
import { normalizeDimensionAngle } from './dimensions';

type Point = [number, number];

/** Signed paper-space angle from the reference ray, unwrapped across the +/-180 degree boundary. */
export function layoutRotationAngle(pivot: Point, reference: Point, current: Point, previousDeg = 0): number {
  if (![...pivot, ...reference, ...current, previousDeg].every(Number.isFinite)) throw new Error('Rotation coordinates must be finite.');
  const a: Point = [reference[0] - pivot[0], reference[1] - pivot[1]], b: Point = [current[0] - pivot[0], current[1] - pivot[1]];
  if (![...a, ...b].every(Number.isFinite)) throw new Error('Rotation exceeds coordinate range.');
  if (Math.hypot(...a) < 1e-6 || Math.hypot(...b) < 1e-6) throw new Error('Choose a direction away from the rotation point.');
  const angle = (Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) * 180 / Math.PI;
  return angle + Math.round((previousDeg - angle) / 360) * 360;
}

/**
 * Pointer rotation with a detent at quarter turns: the angle becomes the nearest multiple of 90° when
 * the pointer, `radiusMm` from the pivot, is within `toleranceMm` of where that angle would put it; any other angle
 * is kept. Typed angles do not come through here and remain exact.
 */
export function snapLayoutRotationAngle(angleDeg: number, radiusMm: number, toleranceMm: number): number {
  if (!Number.isFinite(angleDeg)) throw new Error('Rotation must be finite.');
  const nearest = Math.sign(angleDeg) * Math.round(Math.abs(angleDeg) / 90) * 90;
  const offset = Math.abs(angleDeg - nearest) * Math.PI / 180;
  // The pointer's distance from the detent's ray, measured along the arc's chord.
  if (2 * radiusMm * Math.sin(offset / 2) > toleranceMm) return angleDeg;
  return nearest === 0 ? 0 : nearest;
}

/** Shared by the preview and committed transform so anchors and curve controls follow the same rotation. */
export function rotateLayoutPath(source: { points: readonly Point[]; handles?: readonly LayoutPathHandle[] | undefined; closed: boolean },
  pivot: Point, angleDeg: number): LayoutRectanglePath {
  if (![...pivot, angleDeg].every(Number.isFinite)) throw new Error('Rotation must be finite.');
  const angle = (angleDeg % 360) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const rotate = (point: Point): Point => {
    const x = point[0] - pivot[0], y = point[1] - pivot[1];
    const result: Point = [pivot[0] + x * cos - y * sin, pivot[1] + x * sin + y * cos];
    if (!result.every(Number.isFinite)) throw new Error('Rotation exceeds coordinate range.');
    return result;
  };
  return { points: source.points.map(rotate), closed: source.closed,
    ...(source.handles ? { handles: source.handles.map(handle => ({
      ...(handle.in ? { in: rotate(handle.in) } : {}), ...(handle.out ? { out: rotate(handle.out) } : {}),
    })) } : {}) };
}

/** Text points describe an unrotated box; the angle is applied about its center at paint time. */
export function layoutTextCenter(source: { points: readonly Point[] }): Point {
  const [a, b] = source.points;
  if (!a || !b) throw new Error('Text needs two bounds points.');
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function rotateLayoutPoint(point: Point, pivot: Point, angleDeg: number): Point {
  return rotateLayoutPath({ points: [point], closed: false }, pivot, angleDeg).points[0]!;
}

export function layoutTextCorners(source: LayoutEntity): Point[] {
  const [a, b] = source.points;
  if (!a || !b) return [];
  return ([a, [b[0], a[1]], b, [a[0], b[1]]] as Point[])
    .map(point => rotateLayoutPoint(point, layoutTextCenter(source), source.text?.rotationDeg ?? 0));
}

/** Rotate text rigidly without changing its local width, height, or typography. */
export function rotateLayoutEntity(source: LayoutEntity, pivot: Point, angleDeg: number): LayoutEntity {
  if (!source.text) {
    const rotated: LayoutEntity = { ...source, ...rotateLayoutPath(source, pivot, angleDeg) };
    // A rotated dimension's line turns with it.
    if (source.dimension?.alignment === 'rotated') rotated.dimension = { ...source.dimension, angleDeg: normalizeDimensionAngle((source.dimension.angleDeg ?? 0) + angleDeg) };
    return rotated;
  }
  const center = layoutTextCenter(source), next = rotateLayoutPoint(center, pivot, angleDeg);
  return { ...source, points: source.points.map(([x, y]) => [x + next[0] - center[0], y + next[1] - center[1]]),
    text: { ...source.text, rotationDeg: ((source.text.rotationDeg ?? 0) + angleDeg) % 360 } };
}

/** Resize in the box's own axes, keeping its opposite edge/corner and any leader fixed on paper. */
export function resizeLayoutTextPoints(source: LayoutEntity, bounds: readonly Point[]): Point[] {
  const center = layoutTextCenter(source), localCenter = layoutTextCenter({ points: bounds });
  const angle = source.text?.rotationDeg ?? 0;
  if (angle % 360 === 0) return [...bounds.map(point => [...point] as Point), ...source.points.slice(2)];
  const next = rotateLayoutPoint(localCenter, center, angle);
  return [...bounds.map(([x, y]): Point => [x + next[0] - localCenter[0], y + next[1] - localCenter[1]]),
    ...source.points.slice(2).map(point => rotateLayoutPoint(rotateLayoutPoint(point, center, angle), next, -angle))];
}
