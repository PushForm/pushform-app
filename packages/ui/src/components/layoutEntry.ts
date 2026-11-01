// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { VcbValue } from '@pushform/commands';

type Point = readonly [number, number];

/** A value a Layout tool takes, drawn as a field on the page beside what it sets. Points are in page millimeters. */
export interface LayoutEntryField {
  /** Stable id within the tool (`length`, `angle`, `width`, …). */
  readonly id: string;
  /** Accessible name, e.g. "Width". */
  readonly label: string;
  /** Live value shown while the field is not being typed in. */
  readonly value: string;
  /** Page point the field is anchored on; beside the pointer when omitted. */
  readonly at?: Point | undefined;
  /** Page direction, away from the shape, in which the field is drawn clear of `at`. */
  readonly away?: Point | undefined;
  readonly locked?: boolean | undefined;
}

/** A gray dimension line on the page, in millimeters. */
export type LayoutEntrySegment = readonly [Point, Point];

export interface LayoutEntryLocks {
  /** Locked line length or rectangle sizes, in millimeters, and line angle in degrees. */
  readonly length?: number | undefined;
  readonly angle?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export type LayoutEntryKind = 'line' | 'box' | 'radius' | 'arc' | 'single' | 'none';

/** Screen gap between a shape and its dimension line. */
export const ENTRY_DIMENSION_OFFSET_PX = 28;

/** Field id used for a tool's single value, and for the field typing opens beside the pointer. */
export const LAYOUT_POINTER_FIELD = 'value';

/** How a tool takes typed values: a line's length and angle, a box's width and height, a radius, an arc's step, or one value. */
export function layoutEntryKind(tool: string, boxTool: boolean, radiusTool: boolean, arcTool = false): LayoutEntryKind {
  if (tool === 'line') return 'line';
  if (arcTool) return 'arc';
  if (boxTool) return 'box';
  if (radiusTool) return 'radius';
  if (tool === 'move' || tool === 'rotate' || tool === 'offset' || tool === 'fillet' || tool === 'chamfer') return 'single';
  return 'none';
}

/** Angle of a→b on the page in degrees, positive turning clockwise (page y runs down), in (-180, 180]. */
export function pageAngle(a: Point, b: Point): number {
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return deg === -180 ? 180 : deg;
}

const sideOf = (v: number): number => (v < 0 ? -1 : 1);

/**
 * The pointer's point held to the locked values: a line keeps its locked length and angle from
 * `anchor`, and a box its locked width and height on the pointer's side of the first corner
 * (`divisor` 2 when drawn from the center, where the pointer sets half of each).
 */
export function lockedPoint(kind: LayoutEntryKind, anchor: Point, p: Point, locks: LayoutEntryLocks, divisor = 1): [number, number] {
  if (kind === 'line') {
    if (locks.length === undefined && locks.angle === undefined) return [p[0], p[1]];
    const dx = p[0] - anchor[0], dy = p[1] - anchor[1];
    const length = locks.length ?? Math.hypot(dx, dy);
    const radians = locks.angle !== undefined ? (locks.angle * Math.PI) / 180 : Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : 0;
    return [anchor[0] + length * Math.cos(radians), anchor[1] + length * Math.sin(radians)];
  }
  if (kind === 'box') {
    const x = locks.width !== undefined ? anchor[0] + sideOf(p[0] - anchor[0]) * locks.width / divisor : p[0];
    const y = locks.height !== undefined ? anchor[1] + sideOf(p[1] - anchor[1]) * locks.height / divisor : p[1];
    return [x, y];
  }
  return [p[0], p[1]];
}

export interface LayoutEntryInput {
  readonly kind: LayoutEntryKind;
  readonly anchor: Point | null;
  readonly cursor: Point | null;
  /** The box's corners as drawn (after Shift and Ctrl), for box tools. */
  readonly corners?: readonly [Point, Point] | undefined;
  /** For arc tools: which arc, its points placed so far and the swept angle of an Arc or Pie, in radians. */
  readonly arc?: { readonly tool: string; readonly points: readonly Point[]; readonly sweep: number } | undefined;
  /** Label of a single-value tool's field, e.g. "Distance". */
  readonly label: string;
  /** Live value of a single-value tool, when it has one. */
  readonly value?: string | undefined;
  readonly locks: LayoutEntryLocks;
  /** Millimeters per screen pixel. */
  readonly mmPerPx: number;
  readonly formatLength: (mm: number) => string;
}

/** The fields a Layout tool shows, in Tab order, and the dimension lines that tie them to the preview. */
export function layoutEntryFields(input: LayoutEntryInput): { fields: LayoutEntryField[]; segments: LayoutEntrySegment[] } {
  const { kind, anchor, cursor, locks, mmPerPx, formatLength } = input;
  const off = ENTRY_DIMENSION_OFFSET_PX * mmPerPx;
  if (kind === 'single') {
    return input.value === undefined ? { fields: [], segments: [] } : { fields: [{ id: LAYOUT_POINTER_FIELD, label: input.label, value: input.value }], segments: [] };
  }
  if (kind === 'arc') return arcFields(input, off);
  if (!anchor || !cursor) return { fields: [], segments: [] };
  if (kind === 'line') {
    const len = Math.hypot(cursor[0] - anchor[0], cursor[1] - anchor[1]);
    const fields: LayoutEntryField[] = [];
    const segments: LayoutEntrySegment[] = [];
    if (len > 1e-9) {
      const ux = (cursor[0] - anchor[0]) / len, uy = (cursor[1] - anchor[1]) / len;
      // Left of the line as seen on the page.
      const side: Point = [uy, -ux];
      const dim = lengthDimension(anchor, cursor, side, off);
      segments.push(...dim.segments);
      fields.push({ id: 'length', label: 'Length', value: formatLength(len), at: dim.at, away: side, locked: locks.length !== undefined });
      const angle = pageAngle(anchor, cursor);
      const r = Math.min(len * 0.5, 60 * mmPerPx);
      segments.push([anchor, [anchor[0] + r * 1.2, anchor[1]]]);
      const arc = angleArc(anchor, r, 0, angle);
      segments.push(...arc.segments);
      fields.push({ id: 'angle', label: 'Angle', value: `${formatAngle(angle)}°`, at: arc.at, away: arc.away, locked: locks.angle !== undefined });
    } else {
      fields.push({ id: 'length', label: 'Length', value: formatLength(0), locked: locks.length !== undefined });
      fields.push({ id: 'angle', label: 'Angle', value: '0°', locked: locks.angle !== undefined });
    }
    return { fields, segments };
  }
  if (kind === 'box') {
    const [a, b] = input.corners ?? [anchor, cursor];
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    // Outside the edges through the first corner, away from the opposite one.
    const up: Point = [0, -sideOf(b[1] - a[1])];
    const left: Point = [-sideOf(b[0] - a[0]), 0];
    const wd = lengthDimension(a, [b[0], a[1]], up, off);
    const hd = lengthDimension(a, [a[0], b[1]], left, off);
    return {
      fields: [
        { id: 'width', label: 'Width', value: formatLength(w), at: wd.at, away: up, locked: locks.width !== undefined },
        { id: 'height', label: 'Height', value: formatLength(h), at: hd.at, away: left, locked: locks.height !== undefined },
      ],
      segments: w > 1e-9 || h > 1e-9 ? [...(w > 1e-9 ? wd.segments : []), ...(h > 1e-9 ? hd.segments : [])] : [],
    };
  }
  if (kind === 'radius') {
    const r = Math.hypot(cursor[0] - anchor[0], cursor[1] - anchor[1]);
    if (r <= 1e-9) return { fields: [{ id: 'radius', label: 'Radius', value: formatLength(0) }], segments: [] };
    const dir: Point = [(cursor[0] - anchor[0]) / r, (cursor[1] - anchor[1]) / r];
    const far: Point = [anchor[0] + dir[0] * (r + 16 * mmPerPx), anchor[1] + dir[1] * (r + 16 * mmPerPx)];
    return { fields: [{ id: 'radius', label: 'Radius', value: formatLength(r), at: far, away: dir }], segments: [[anchor, far]] };
  }
  return { fields: [], segments: [] };
}

/**
 * An arc tool's field for its current step: Arc and Pie take a Radius after the center and then an
 * Angle; 2 Point Arc a chord Length and then a Bulge; 3 Point Arc the Length of its first chord.
 */
function arcFields(input: LayoutEntryInput, off: number): { fields: LayoutEntryField[]; segments: LayoutEntrySegment[] } {
  const { arc, cursor, mmPerPx, formatLength } = input;
  const none = { fields: [], segments: [] };
  if (!arc || !cursor || !arc.points.length) return none;
  const [a, b] = arc.points;
  const circular = arc.tool === 'arc' || arc.tool === 'pie';
  if (arc.points.length === 1) {
    if (circular) return layoutEntryFields({ ...input, kind: 'radius', anchor: a!, arc: undefined });
    const length = layoutEntryFields({ ...input, kind: 'line', anchor: a!, arc: undefined });
    return { fields: length.fields.filter(f => f.id === 'length'), segments: length.segments.slice(0, 3) };
  }
  if (circular) {
    const radius = Math.hypot(b![0] - a![0], b![1] - a![1]);
    const sweepDeg = (arc.sweep * 180) / Math.PI;
    const value = `${formatAngle(Math.abs(sweepDeg))}°`;
    if (radius <= 1e-9 || Math.abs(sweepDeg) < 1e-6) return { fields: [{ id: 'angle', label: 'Angle', value }], segments: [] };
    const r = Math.min(radius * 0.6, Math.max(radius * 0.3, 60 * mmPerPx));
    const dim = angleArc(a!, r, pageAngle(a!, b!), sweepDeg);
    // The field sits just outside the arc's rim, clear of the arc, with a leader from the angle's gray arc.
    const at: Point = [a![0] + dim.away[0] * (radius + 6 * mmPerPx), a![1] + dim.away[1] * (radius + 6 * mmPerPx)];
    return { fields: [{ id: 'angle', label: 'Angle', value, at, away: dim.away }], segments: [...dim.segments, [dim.at, at]] };
  }
  if (arc.tool !== 'arc2') return none;
  // Bulge: the arc's height over its chord, measured from the chord's midpoint toward the pointer.
  const dx = b![0] - a![0], dy = b![1] - a![1], length = Math.hypot(dx, dy);
  if (length <= 1e-9) return none;
  const n: Point = [-dy / length, dx / length];
  const mid: Point = [(a![0] + b![0]) / 2, (a![1] + b![1]) / 2];
  const bulge = (cursor[0] - mid[0]) * n[0] + (cursor[1] - mid[1]) * n[1];
  const side = bulge < 0 ? -1 : 1;
  const apex: Point = [mid[0] + n[0] * bulge, mid[1] + n[1] * bulge];
  const at: Point = [apex[0] + n[0] * side * off * 0.5, apex[1] + n[1] * side * off * 0.5];
  return {
    fields: [{ id: 'bulge', label: 'Bulge', value: formatLength(Math.abs(bulge)), at, away: [n[0] * side, n[1] * side] }],
    segments: Math.abs(bulge) > 1e-9 ? [[mid, at], [a!, b!]] : [],
  };
}

/** Two extension lines and a dimension line for a→b, `offset` along unit `side`, with its midpoint. */
function lengthDimension(a: Point, b: Point, side: Point, offset: number): { segments: LayoutEntrySegment[]; at: Point } {
  const s = (p: Point, k: number): Point => [p[0] + side[0] * k, p[1] + side[1] * k];
  const da = s(a, offset), db = s(b, offset);
  return {
    segments: [[a, s(a, offset * 1.25)], [b, s(b, offset * 1.25)], [da, db]],
    at: [(da[0] + db[0]) / 2, (da[1] + db[1]) / 2],
  };
}

/** Arc of `radius` about `center` from `start` through `sweep` degrees (clockwise on the page), with its midpoint. */
function angleArc(center: Point, radius: number, start: number, sweep: number): { segments: LayoutEntrySegment[]; at: Point; away: Point } {
  const at = (deg: number): Point => [center[0] + radius * Math.cos((deg * Math.PI) / 180), center[1] + radius * Math.sin((deg * Math.PI) / 180)];
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / 6));
  const segments: LayoutEntrySegment[] = [];
  for (let i = 0; i < n; i++) segments.push([at(start + (sweep * i) / n), at(start + (sweep * (i + 1)) / n)]);
  const mid = start + sweep / 2;
  const rad = (mid * Math.PI) / 180;
  return { segments, at: at(mid), away: [Math.cos(rad), Math.sin(rad)] };
}

function formatAngle(deg: number): string {
  return (Math.round(deg * 10) / 10).toFixed(1);
}

/** Millimeters of a typed length, or undefined when the value is not a length. */
export function entryMm(v: VcbValue | undefined): number | undefined {
  return v?.kind === 'length' ? v.meters * 1000 : undefined;
}

/** Degrees of a typed angle (`45`, `45°`, `45deg`); undefined otherwise. */
export function entryDeg(v: VcbValue | undefined): number | undefined {
  if (!v) return undefined;
  if (v.kind === 'angle') return v.degrees;
  if (v.kind === 'length' && v.unit === null) return v.raw;
  return undefined;
}
