// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPathHandle } from './LayoutDocument';

type Point = [number, number];

/** Arrow styles for the ends of open shapes. */
export const LAYOUT_ARROW_TYPES = [
  'filled-triangle', 'open-triangle', 'filled-skinny-triangle', 'open-skinny-triangle', 'open-arrow-90', 'open-arrow-120',
  'filled-circle', 'open-circle', 'filled-square', 'open-square', 'filled-diamond', 'open-diamond', 'star', 't-bar',
  'slash-right', 'slash-left',
] as const;
export type LayoutArrowType = typeof LAYOUT_ARROW_TYPES[number];

/** An arrow at one end of an open shape; `sizePt` is the arrow size, in points. */
export interface LayoutArrow { type: LayoutArrowType; sizePt: number; nativeUnknownFields?: Uint8Array[] }

export const LAYOUT_ARROW_LABELS: Record<LayoutArrowType, string> = {
  'filled-triangle': 'Filled triangle', 'open-triangle': 'Open triangle',
  'filled-skinny-triangle': 'Filled skinny triangle', 'open-skinny-triangle': 'Open skinny triangle',
  'open-arrow-90': 'Open arrow 90°', 'open-arrow-120': 'Open arrow 120°',
  'filled-circle': 'Filled circle', 'open-circle': 'Open circle', 'filled-square': 'Filled square', 'open-square': 'Open square',
  'filled-diamond': 'Filled diamond', 'open-diamond': 'Open diamond', star: 'Star', 't-bar': 'T',
  'slash-right': 'Slash right', 'slash-left': 'Slash left',
};

/** The default arrow size, in points. */
export const LAYOUT_DEFAULT_ARROW_SIZE_PT = 4;

/**
 * `startArrowType`/`endArrowType` codes in .layout files.
 * 0 is none, and 15/16 (underrun, overrun) are line extensions rather than arrows.
 */
export const LAYOUT_ARROW_FILE_CODES: Record<LayoutArrowType, number> = {
  'filled-triangle': 1, 'open-triangle': 2, 'open-arrow-90': 3, 'open-arrow-120': 4, 'filled-circle': 5, 'open-circle': 6,
  'filled-square': 7, 'open-square': 8, 'filled-diamond': 9, 'open-diamond': 10, star: 11, 't-bar': 12,
  'slash-right': 13, 'slash-left': 14, 'filled-skinny-triangle': 17, 'open-skinny-triangle': 18,
};

/**
 * The arrow a .layout `arrowData` type code and size describe; null for none, for codes that are not arrows, and for a
 * size of zero, which draws as nothing (some files carry such arrows).
 */
export function layoutArrowFromFile(code: number, sizePt: number): LayoutArrow | null {
  const type = LAYOUT_ARROW_TYPES.find(candidate => LAYOUT_ARROW_FILE_CODES[candidate] === code);
  return type && sizePt > 0 ? { type, sizePt } : null;
}

export interface LayoutArrowShape { points: Point[]; closed: boolean; filled: boolean }

/**
 * Arrowhead outlines at `tip`, for a line arriving from `toward`, and how far before the tip a line under an open
 * arrowhead stops (its back), all in paper millimeters. Drawn per, in units of one
 * point per size unit: triangles and diamonds 3 long and 2 wide (skinny triangles 1 wide), circles and squares 2
 * across and centered on the tip, slashes and the T's bar 2 across, and the star's three 2-unit strokes with one
 * horizontal however the line turns.
 */
export function layoutArrowShapes(arrow: LayoutArrow, tip: Point, toward: Point): { shapes: LayoutArrowShape[]; back: number } {
  const unit = arrow.sizePt * 25.4 / 72;
  const angle = Math.atan2(toward[1] - tip[1], toward[0] - tip[0]);
  const at = (distance: number, side: number): Point => [
    tip[0] + Math.cos(angle) * distance - Math.sin(angle) * side,
    tip[1] + Math.sin(angle) * distance + Math.cos(angle) * side,
  ];
  const circle = (): Point[] => Array.from({ length: 24 }, (_, i): Point => [tip[0] + unit * Math.cos(i / 12 * Math.PI), tip[1] + unit * Math.sin(i / 12 * Math.PI)]);
  const one = (points: Point[], closed: boolean, filled: boolean, back: number) => ({ shapes: [{ points, closed, filled }], back });
  const filled = arrow.type.startsWith('filled');
  switch (arrow.type) {
    case 'filled-triangle': case 'open-triangle':
      return one([tip, at(3 * unit, unit), at(3 * unit, -unit)], true, filled, 3 * unit);
    case 'filled-skinny-triangle': case 'open-skinny-triangle':
      return one([tip, at(3 * unit, unit / 2), at(3 * unit, -unit / 2)], true, filled, 3 * unit);
    case 'open-arrow-90': case 'open-arrow-120':
      return one([at(3 * unit, 1.5 * unit), tip, at(3 * unit, -1.5 * unit)], false, false, 0);
    case 'filled-circle': case 'open-circle': return one(circle(), true, filled, unit);
    case 'filled-square': case 'open-square':
      return one([at(-unit, -unit), at(-unit, unit), at(unit, unit), at(unit, -unit)], true, filled, unit);
    case 'filled-diamond': case 'open-diamond':
      return one([tip, at(1.5 * unit, unit), at(3 * unit, 0), at(1.5 * unit, -unit)], true, filled, 3 * unit);
    case 'star': return {
      shapes: [0, 60, 120].map(degrees => {
        const dx = unit * Math.cos(degrees * Math.PI / 180), dy = unit * Math.sin(degrees * Math.PI / 180);
        return { points: [[tip[0] - dx, tip[1] - dy], [tip[0] + dx, tip[1] + dy]], closed: false, filled: false };
      }),
      back: 0,
    };
    case 't-bar': return one([at(0, -unit), at(0, unit)], false, false, 0);
    case 'slash-right': case 'slash-left': return one([at(-unit, -unit), at(unit, unit)], false, false, 0);
  }
}

/**
 * The arrowheads of an open path and its points with each straight end segment under an open arrowhead stopped at
 * the arrowhead's back, so no line shows inside it. A curved end segment, or one no longer than the back,
 * keeps its end. Closed paths and paths without arrows come back unchanged.
 */
export function layoutPathArrows(points: readonly Point[], handles: readonly LayoutPathHandle[] | undefined, closed: boolean,
  style: { startArrow?: LayoutArrow | undefined; endArrow?: LayoutArrow | undefined } | undefined): { points: Point[]; shapes: LayoutArrowShape[] } {
  const trimmed = points.map((point): Point => [point[0], point[1]]);
  const shapes: LayoutArrowShape[] = [];
  const n = points.length;
  if (closed || n < 2 || !style) return { points: trimmed, shapes };
  const ends = [
    { arrow: style.startArrow, at: 0, next: 1, curved: !!(handles?.[0]?.out || handles?.[1]?.in), toward: handles?.[0]?.out ?? points[1]! },
    { arrow: style.endArrow, at: n - 1, next: n - 2, curved: !!(handles?.[n - 1]?.in || handles?.[n - 2]?.out), toward: handles?.[n - 1]?.in ?? points[n - 2]! },
  ];
  for (const { arrow, at, next, curved, toward } of ends) {
    if (!arrow) continue;
    const tip = points[at]!;
    const head = layoutArrowShapes(arrow, tip, toward);
    shapes.push(...head.shapes);
    if (!(head.back > 0 && head.shapes.some(shape => shape.closed && !shape.filled)) || curved) continue;
    const other = points[next]!, length = Math.hypot(other[0] - tip[0], other[1] - tip[1]);
    if (length <= head.back) continue;
    const t = head.back / length;
    trimmed[at] = [tip[0] + (other[0] - tip[0]) * t, tip[1] + (other[1] - tip[1]) * t];
  }
  return { points: trimmed, shapes };
}
