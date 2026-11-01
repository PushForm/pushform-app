// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { METERS_PER, parseLength } from '@pushform/core';
import type { LengthUnit } from '@pushform/core';

/**
 * Typed value (VCB) grammar, read by the viewport's value fields.
 *
 *   3'6"  2.5m  1 1/2"  10          length (bare number = default unit)
 *   35deg 35°                       angle in degrees
 *   1:4                             slope (rise:run) → angle
 *   3x  x3  *3  3*                  external array (N copies)
 *   /3  3/                          internal array (divide)
 *   [x,y,z]                         absolute coordinates (blank keeps current)
 *   <x,y,z>                         relative coordinates (blank keeps current)
 *   a,b  a,,c                       list (Rectangle length,width; Scale x,y,z)
 *   24s                             segments
 *   24r  r24                        radius
 *   24c  c24                        circumscribed (Polygon)
 *   50mm                            length with explicit unit (Zoom uses mm as focal length)
 */
export type VcbValue =
  | { kind: 'length'; meters: number; raw: number; unit: LengthUnit | null }
  | { kind: 'angle'; degrees: number }
  | { kind: 'slope'; rise: number; run: number; degrees: number }
  | { kind: 'array'; mode: 'external' | 'internal'; count: number }
  | { kind: 'absolute'; coords: readonly [number | null, number | null, number | null] }
  | { kind: 'relative'; coords: readonly [number | null, number | null, number | null] }
  | { kind: 'list'; values: readonly (VcbScalar | null)[] }
  | { kind: 'segments'; count: number }
  | { kind: 'radius'; meters: number }
  | { kind: 'circumscribed'; meters: number }
  | { kind: 'empty' };

export type VcbScalar = Extract<VcbValue, { kind: 'length' | 'angle' | 'slope' }>;
export type VcbKind = VcbValue['kind'];

export interface VcbParseError {
  readonly error: string;
  readonly input: string;
}

export type VcbParseResult = { ok: true; value: VcbValue } | { ok: false; error: VcbParseError };

const UNIT_RE = /(mm|cm|m|in|ft|yd|"|')\s*$/;

function detectUnit(s: string): LengthUnit | null {
  const m = s.trim().match(UNIT_RE);
  if (!m) return null;
  switch (m[1]) {
    case '"':
      return 'in';
    case "'":
      return 'ft';
    default:
      return m[1] as LengthUnit;
  }
}

function parseScalar(s: string, defaultUnit: LengthUnit): VcbScalar | null {
  // architectural "3'-6\"" is the same as "3' 6\""
  const t = s.trim().replace(/(\d)'\s*-\s*(?=\d)/, "$1' ");
  if (!t) return null;
  const angle = t.match(/^([+-]?\d*\.?\d+)\s*(deg|°|d)$/i);
  if (angle) return { kind: 'angle', degrees: parseFloat(angle[1]!) };
  const slope = t.match(/^([+-]?\d*\.?\d+)\s*:\s*(\d*\.?\d+)$/);
  if (slope) {
    const rise = parseFloat(slope[1]!),
      run = parseFloat(slope[2]!);
    return { kind: 'slope', rise, run, degrees: (Math.atan2(rise, run) * 180) / Math.PI };
  }
  const meters = parseLength(t, defaultUnit);
  if (meters === null) return null;
  const unit = detectUnit(t);
  const raw = unit ? meters / unitMeters(unit) : meters / unitMeters(defaultUnit);
  return { kind: 'length', meters, raw, unit };
}

const unitMeters = (u: LengthUnit): number => METERS_PER[u];

function parseCoords(
  body: string,
  defaultUnit: LengthUnit,
): readonly [number | null, number | null, number | null] | null {
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const out: (number | null)[] = [];
  for (const p of parts) {
    if (p === '') {
      out.push(null);
      continue;
    }
    const v = parseLength(p, defaultUnit);
    if (v === null) return null;
    out.push(v);
  }
  return [out[0] ?? null, out[1] ?? null, out[2] ?? null];
}

export function parseVcb(input: string, defaultUnit: LengthUnit = 'in'): VcbParseResult {
  const s = input.trim();
  const fail = (error: string): VcbParseResult => ({ ok: false, error: { error, input } });
  if (!s) return { ok: true, value: { kind: 'empty' } };

  // Arrays: 3x, x3, *3, 3*, /3, 3/
  let m = s.match(/^(\d+)\s*([x*/])$/i) ?? s.match(/^([x*/])\s*(\d+)$/i);
  if (m) {
    const [a, b] = [m[1]!, m[2]!];
    const op = /^\d+$/.test(a) ? b : a;
    const count = parseInt(/^\d+$/.test(a) ? a : b, 10);
    if (count < 1) return fail('Array count must be ≥ 1');
    return { ok: true, value: { kind: 'array', mode: op === '/' ? 'internal' : 'external', count } };
  }

  // Coordinates
  m = s.match(/^\[(.*)\]$/);
  if (m) {
    const coords = parseCoords(m[1]!, defaultUnit);
    return coords ? { ok: true, value: { kind: 'absolute', coords } } : fail('Expected [x,y,z]');
  }
  m = s.match(/^<(.*)>$/);
  if (m) {
    const coords = parseCoords(m[1]!, defaultUnit);
    return coords ? { ok: true, value: { kind: 'relative', coords } } : fail('Expected <x,y,z>');
  }

  // Suffix/prefix letters: 24s, 24r, r24, 24c, c24
  m = s.match(/^(\d+)\s*s$/i);
  if (m) return { ok: true, value: { kind: 'segments', count: parseInt(m[1]!, 10) } };
  m = s.match(/^([rc])\s*(.+)$/i) ?? s.match(/^(.+?)\s*([rc])$/i);
  if (m) {
    const letter = /^[rc]$/i.test(m[1]!) ? m[1]!.toLowerCase() : m[2]!.toLowerCase();
    const body = /^[rc]$/i.test(m[1]!) ? m[2]! : m[1]!;
    const meters = parseLength(body, defaultUnit);
    if (meters === null) return fail(`Expected a length before/after "${letter}"`);
    return { ok: true, value: { kind: letter === 'r' ? 'radius' : 'circumscribed', meters } };
  }

  // Lists: a,b  a,,c (blank keeps the current value)
  if (s.includes(',')) {
    const parts = s.split(',');
    const values: (VcbScalar | null)[] = [];
    for (const p of parts) {
      if (p.trim() === '') {
        values.push(null);
        continue;
      }
      const v = parseScalar(p, defaultUnit);
      if (!v) return fail(`Cannot parse "${p.trim()}"`);
      values.push(v);
    }
    return { ok: true, value: { kind: 'list', values } };
  }

  const scalar = parseScalar(s, defaultUnit);
  if (scalar) return { ok: true, value: scalar };
  return fail(`Cannot parse "${s}"`);
}
