// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { v3add, v3cross, v3dist, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import type { VcbValue } from '../vcb/parse';
import type { OverlayPrimitive } from './overlay';
import type { EntryField, ToolContext } from './Tool';
import { worldPerPixelAt } from './toolUtil';

/** Colour of the dimension lines and arcs that tie value fields to the preview. */
export const DIMENSION_COLOR = '#9aa0a6';

/** Screen gap between a measured edge and its dimension line. */
export const DIMENSION_OFFSET_PX = 28;

/** World size of `px` CSS pixels at `p` (0 without a context). */
export function pxAt(ctx: ToolContext | null, p: Vec3, px: number): number {
  if (!ctx) return 0;
  return px * worldPerPixelAt(ctx.camera.getState(), ctx.camera.viewportSize().height, p);
}

export interface Dimension {
  readonly overlay: OverlayPrimitive[];
  /** Centre of the dimension line, where the field sits. */
  readonly at: Vec3;
}

/**
 * Linear dimension for the edge a→b, drawn `offset` world units away along `side` (a unit vector
 * perpendicular to the edge): two extension lines and the dimension line between them.
 */
export function lengthDimension(a: Vec3, b: Vec3, side: Vec3, offset: number): Dimension {
  const shift = v3scale(side, offset);
  const da = v3add(a, shift);
  const db = v3add(b, shift);
  const overhang = v3scale(side, offset * 0.25);
  return {
    overlay: [
      { kind: 'polyline', points: [a, v3add(da, overhang)], color: DIMENSION_COLOR, width: 1 },
      { kind: 'polyline', points: [b, v3add(db, overhang)], color: DIMENSION_COLOR, width: 1 },
      { kind: 'polyline', points: [da, db], color: DIMENSION_COLOR, width: 1 },
    ],
    at: v3scale(v3add(da, db), 0.5),
  };
}

/** Unit vector in the plane with normal `n`, perpendicular to a→b, on its left (n × dir); null for a degenerate edge. */
export function leftOf(a: Vec3, b: Vec3, n: Vec3): Vec3 | null {
  if (v3dist(a, b) < 1e-12) return null;
  const s = v3cross(n, v3sub(b, a));
  return v3len(s) < 1e-12 ? null : v3normalize(s);
}

/**
 * Angle dimension about `center` in the plane spanned by unit vectors `u` and `v`: an arc of
 * `radius` from angle `start` through `sweep` (radians, counterclockwise from u toward v), with the
 * field centred at the arc's middle angle, `labelRadius` from the centre (the arc itself by default).
 */
export function angleDimension(center: Vec3, u: Vec3, v: Vec3, radius: number, start: number, sweep: number, labelRadius = radius): Dimension {
  const at = (t: number, r: number): Vec3 => v3add(center, v3add(v3scale(u, Math.cos(t) * r), v3scale(v, Math.sin(t) * r)));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 32)));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(at(start + (sweep * i) / n, radius));
  return { overlay: [{ kind: 'polyline', points: pts, color: DIMENSION_COLOR, width: 1 }], at: at(start + sweep / 2, labelRadius) };
}

/** Field helper: a length or angle field with the given live value. */
export function field(id: string, label: string, kind: EntryField['kind'], value: string | undefined, at: Vec3 | undefined, locked = false): EntryField {
  return { id, label, kind, value: value ?? '', at, locked };
}

/** The single value of a tool that measures with one number, shown beside the pointer. */
export function pointerField(label: string, kind: EntryField['kind'], value: string | undefined): EntryField {
  return field('value', label, kind, value, undefined);
}

/** Meters of a typed length value, or null when the value is not a length. */
export function entryLength(v: VcbValue | null | undefined): number | null {
  return v && v.kind === 'length' ? v.meters : null;
}

/** Degrees of a typed angle: `45`, `45°`, `45deg` or a `rise:run` slope; null otherwise. */
export function entryDegrees(v: VcbValue | null | undefined): number | null {
  if (!v) return null;
  if (v.kind === 'angle' || v.kind === 'slope') return v.degrees;
  if (v.kind === 'length' && v.unit === null) return v.raw;
  return null;
}
