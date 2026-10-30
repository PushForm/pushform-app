// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPathHandle } from './LayoutDocument';
import type { PaperPathPoint as Point } from './path';

export const LAYOUT_RECTANGLE_KINDS = ['rectangle', 'rounded-rectangle', 'bulged-rectangle', 'lozenge'] as const;
export type LayoutRectangleKind = typeof LAYOUT_RECTANGLE_KINDS[number];
export interface LayoutRectanglePath { points: Point[]; handles?: LayoutPathHandle[]; closed: boolean; contourStarts?: number[] }

export function isLayoutRectangleTool(tool: string): tool is LayoutRectangleKind {
  return (LAYOUT_RECTANGLE_KINDS as readonly string[]).includes(tool);
}

/** Construct editable native paper paths; a and b are opposite rectangle corners. */
export function createLayoutRectangle(kind: LayoutRectangleKind, a: Point, b: Point, amountMm = 5): LayoutRectanglePath {
  if (![...a, ...b, amountMm].every(Number.isFinite) || amountMm < 0) throw new Error('Invalid rectangle coordinates or amount');
  const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
  const top = Math.min(a[1], b[1]), bottom = Math.max(a[1], b[1]);
  const width = right - left, height = bottom - top;
  if (width < 1e-6 || height < 1e-6) throw new Error('Rectangle needs a non-zero width and height');
  const plain: LayoutRectanglePath = { points: [[left, top], [right, top], [right, bottom], [left, bottom]], closed: true };
  if (kind === 'rectangle') return plain;
  if (kind === 'bulged-rectangle') {
    if (amountMm === 0) return plain;
    const bow = 4 * amountMm / 3;
    return { ...plain, handles: [
      { in: [left - bow, top + height / 3] },
      { out: [right + bow, top + height / 3] },
      { in: [right + bow, bottom - height / 3] },
      { out: [left - bow, bottom - height / 3] },
    ] };
  }
  const radius = kind === 'lozenge' ? Math.min(width, height) / 2 : Math.min(amountMm, width / 2, height / 2);
  if (radius === 0) return plain;
  const k = radius * 0.5522847498307936;
  const points: Point[] = [[left + radius, top], [right - radius, top], [right, top + radius],
    [right, bottom - radius], [right - radius, bottom], [left + radius, bottom],
    [left, bottom - radius], [left, top + radius]];
  const handles: LayoutPathHandle[] = [
    { in: [left + radius - k, top] }, { out: [right - radius + k, top] },
    { in: [right, top + radius - k] }, { out: [right, bottom - radius + k] },
    { in: [right - radius + k, bottom] }, { out: [left + radius - k, bottom] },
    { in: [left, bottom - radius + k] }, { out: [left, top + radius - k] },
  ];
  // At maximum radius adjacent tangent points coincide. Merge them, keeping both curve controls.
  const merged: Point[] = [], controls: LayoutPathHandle[] = [];
  points.forEach((point, index) => {
    const previous = merged.at(-1);
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-8) {
      Object.assign(controls.at(-1)!, handles[index]);
    } else { merged.push(point); controls.push(handles[index]!); }
  });
  return { points: merged, handles: controls, closed: true };
}
