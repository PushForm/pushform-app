// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { M4_IDENTITY, m4mul, m4rotationAxis, m4scaling, m4translation, v3cross, v3len, v3normalize, type Mat4, type Vec3 } from '@pushform/core';

// AutoCAD DXF reading shared by model import and Layout import: the ASCII group-code file,
// its header units, layers, linetypes and blocks, and its entities as curves, faces, fills, text and block inserts.

export type DxfUnit = 'in' | 'ft' | 'mi' | 'mm' | 'cm' | 'm' | 'km' | 'µin' | 'mil' | 'yd' | 'Å' | 'nm' | 'µm' | 'dm' | 'dam' | 'hm' | 'Gm' | 'au' | 'ly' | 'pc' | 'usft' | 'usin' | 'usyd' | 'usmi';
/** `$INSUNITS` codes 1–25 with the meters one unit is. */
const INSUNITS: readonly (readonly [DxfUnit, number] | null)[] = [null,
  ['in', 0.0254], ['ft', 0.3048], ['mi', 1609.344], ['mm', 0.001], ['cm', 0.01], ['m', 1], ['km', 1000], ['µin', 0.0254e-6],
  ['mil', 0.0254e-3], ['yd', 0.9144], ['Å', 1e-10], ['nm', 1e-9], ['µm', 1e-6], ['dm', 0.1], ['dam', 10], ['hm', 100], ['Gm', 1e9],
  ['au', 149597870700], ['ly', 9.4607304725808e15], ['pc', 30856775814913676],
  ['usft', 1200 / 3937], ['usin', 100 / 3937], ['usyd', 3600 / 3937], ['usmi', 6336000 / 3937]];

/** A color as the file gives it: an AutoCAD Color Index (0 by block, 256 by layer), or a true color. */
export type DxfColor = { aci: number } | { rgb: [number, number, number] };
/** Lineweight in hundredths of a millimeter; -1 by layer, -2 by block, -3 the default. */
export interface DxfStyle { layer: string; color: DxfColor; linetype: string; linetypeScale: number; lineweight: number }

/**
 * A piece of a curve: a line, an elliptical arc `center + u·cos t + v·sin t` for t from `start` to `end` (a circle
 * when u and v are perpendicular and equally long; a full turn when `end - start` is 2π), or points along a smooth
 * curve such as a spline.
 */
export type DxfCurve =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'arc'; center: Vec3; u: Vec3; v: Vec3; start: number; end: number }
  | { kind: 'points'; points: Vec3[] };

export type DxfItem = DxfStyle & (
  /** Connected curves, end to start; `closed` when the last ends where the first starts. */
  | { kind: 'path'; curves: DxfCurve[]; closed: boolean; source: string }
  /** A 3D face or mesh face, or a filled 2D solid or trace. */
  | { kind: 'face'; corners: Vec3[]; filled: boolean; source: string }
  /** A solid-filled hatch: closed boundary loops filled even-odd. */
  | { kind: 'fill'; loops: DxfCurve[][] }
  /** Text from its anchor: `x` along the baseline and `y` up the text, both one text height long. */
  | { kind: 'text'; text: string; anchor: Vec3; x: Vec3; y: Vec3; align: 'left' | 'center' | 'right'; vertical: 'top' | 'middle' | 'bottom' | 'baseline';
    widthFactor: number; underline: boolean; source: string }
  /** A block placed by `transform` (block coordinates to the holder's); dimensions place their drawing this way too. */
  | { kind: 'insert'; block: string; transform: Mat4; source: string });

export interface DxfLayer { name: string; color: DxfColor; visible: boolean; linetype: string; lineweight: number }
export interface DxfBlock { name: string; items: DxfItem[]; xref: boolean }
export interface DxfDrawing {
  /** `$ACADVER`, such as AC1032, or null when the header does not say. */
  version: string | null;
  /** Drawing units from `$INSUNITS`, or null when unitless. */
  units: { unit: DxfUnit; meters: number } | null;
  /** `$MEASUREMENT`: which units the drawing was started in, or null when the header does not say. */
  measurement: 'imperial' | 'metric' | null;
  layers: Map<string, DxfLayer>;
  /** Linetype dash patterns in drawing units: positive dashes, negative gaps, zero dots. Continuous has none. */
  linetypes: Map<string, number[]>;
  linetypeScale: number;
  blocks: Map<string, DxfBlock>;
  /** Model space. */
  items: DxfItem[];
  /** Entities on paper space layouts, which are not read. */
  paperSpace: number;
  /** Entities that are not read, by type. */
  unsupported: Map<string, number>;
  /** Entities with an extrusion thickness, which is not read. */
  thick: number;
}

/** The meters one unit is, by unit, for units a file without units of its own can be read in. */
export function dxfUnitMeters(code: number): { unit: DxfUnit; meters: number } | null {
  const entry = INSUNITS[code];
  return entry ? { unit: entry[0], meters: entry[1] } : null;
}

const BINARY_SENTINEL = 'AutoCAD Binary DXF';

/** Whether the bytes are a DXF file: ASCII DXF starts with a group code 0 SECTION (after comments). */
export function isDxfBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (head.startsWith(BINARY_SENTINEL)) return true;
  const lines = head.split(/\r?\n/).map(line => line.trim());
  let i = 0;
  while (i < lines.length && !lines[i]) i++;
  while (lines[i] === '999') i += 2;
  return lines[i] === '0' && lines[i + 1] === 'SECTION';
}

export function isDxfFile(name: string): boolean { return /\.dxf$/i.test(name); }

/** Bytes of the header read for import options, which is usually a few kilobytes. */
const HEADER_SCAN_BYTES = 1 << 20;

/**
 * A DXF file's units and extent from its header alone, for the import options: null units when unitless,
 * and null extent when the header records none. A binary DXF reports its units as known, since it is not read.
 */
export function parseDxfHeader(bytes: Uint8Array): { units: { unit: DxfUnit; meters: number } | null; extent: { min: Vec3; max: Vec3 } | null } {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_SCAN_BYTES));
  if (text.startsWith(BINARY_SENTINEL)) return { units: { unit: 'mm', meters: 0.001 }, extent: null };
  const lines = text.split(/\r?\n/);
  let variable = '', units: { unit: DxfUnit; meters: number } | null = null;
  const min: number[] = [], max: number[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim()), value = lines[i + 1]!.trim();
    if (code === 0 && value === 'ENDSEC') break;
    if (code === 9) variable = value;
    else if (variable === '$INSUNITS' && code === 70) units = dxfUnitMeters(Number(value));
    else if ((variable === '$EXTMIN' || variable === '$EXTMAX') && (code === 10 || code === 20 || code === 30))
      (variable === '$EXTMIN' ? min : max)[(code - 10) / 10] = Number(value);
  }
  // An empty drawing's extent is recorded inverted, at ±1e20.
  const valid = [0, 1].every(k => Number.isFinite(min[k]) && Number.isFinite(max[k]) && max[k]! >= min[k]! && Math.abs(min[k]!) < 1e19 && Math.abs(max[k]!) < 1e19);
  return { units, extent: valid ? { min: [min[0]!, min[1]!, min[2] ?? 0], max: [max[0]!, max[1]!, max[2] ?? 0] } : null };
}

/** Text of the file: UTF-8 (AutoCAD 2007 and later), else the Windows code page older files are written in. */
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

type Pair = readonly [code: number, value: string];

/** Group code and value pairs; a malformed code ends the file. */
function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/), out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isInteger(code) || !lines[i]!.trim()) {
      if (!lines[i]!.trim() && !lines[i + 1]!.trim()) continue;
      throw new Error(`This DXF file is malformed near line ${i + 1}.`);
    }
    out.push([code, lines[i + 1]!]);
  }
  return out;
}

/** One entity or table record: its type and group codes (an embedded object, after code 101, is left out). */
class Rec {
  constructor(readonly type: string, readonly pairs: readonly Pair[]) {}
  str(code: number, fallback = ''): string { const p = this.pairs.find(q => q[0] === code); return p ? p[1].trim() : fallback; }
  raw(code: number): string | undefined { return this.pairs.find(q => q[0] === code)?.[1]; }
  num(code: number, fallback = 0): number { const p = this.pairs.find(q => q[0] === code); const n = p ? Number(p[1].trim()) : NaN; return Number.isFinite(n) ? n : fallback; }
  has(code: number): boolean { return this.pairs.some(q => q[0] === code); }
  point(code: number, fallback: Vec3 = [0, 0, 0]): Vec3 { return [this.num(code, fallback[0]), this.num(code + 10, fallback[1]), this.num(code + 20, fallback[2])]; }
  extrusion(): Vec3 { const n = this.point(210, [0, 0, 1]); return v3len(n) > 0 ? v3normalize(n) : [0, 0, 1]; }
}

/** The arbitrary axis algorithm's limit: a normal this close to Z takes its X axis from world Y. */
const ARBITRARY_AXIS_LIMIT = 1 / 64;

/** An object coordinate system's axes for an extrusion direction (DXF's arbitrary axis algorithm). */
export function ocsAxes(normal: Vec3): [Vec3, Vec3, Vec3] {
  const z = v3normalize(normal);
  const x = v3normalize(Math.abs(z[0]) < ARBITRARY_AXIS_LIMIT && Math.abs(z[1]) < ARBITRARY_AXIS_LIMIT ? v3cross([0, 1, 0], z) : v3cross([0, 0, 1], z));
  return [x, v3normalize(v3cross(z, x)), z];
}
function ocs(normal: Vec3): { point: (p: Vec3) => Vec3; dir: (d: Vec3) => Vec3; matrix: Mat4 } {
  const [x, y, z] = ocsAxes(normal);
  const dir = (d: Vec3): Vec3 => [x[0] * d[0] + y[0] * d[1] + z[0] * d[2], x[1] * d[0] + y[1] * d[1] + z[1] * d[2], x[2] * d[0] + y[2] * d[1] + z[2] * d[2]];
  return { point: dir, dir, matrix: [...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1] as unknown as Mat4 };
}

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const DEG = Math.PI / 180, TURN = 2 * Math.PI;

/** A circular arc in an OCS plane at an elevation, counterclockwise from `start` to `end` (radians) unless reversed. */
function ocsArc(frame: ReturnType<typeof ocs>, center: [number, number], elevation: number, radius: number, start: number, end: number, clockwise = false): DxfCurve {
  let sweep = clockwise ? start - end : end - start;
  sweep = ((sweep % TURN) + TURN) % TURN || TURN;
  const u = frame.dir([radius, 0, 0]), v = frame.dir([0, clockwise ? -radius : radius, 0]), at = clockwise ? -start : start;
  return { kind: 'arc', center: frame.point([center[0], center[1], elevation]), u, v, start: at, end: at + sweep };
}

/** The line or arc from one polyline vertex to the next, curving by the bulge (the tangent of a quarter of its angle). */
function bulgeSegment(frame: ReturnType<typeof ocs>, a: [number, number], b: [number, number], bulge: number, elevation: number): DxfCurve | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
  if (chord === 0) return null;
  if (!bulge || !Number.isFinite(bulge)) return { kind: 'line', a: frame.point([a[0], a[1], elevation]), b: frame.point([b[0], b[1], elevation]) };
  const offset = chord / 2 * (1 - bulge * bulge) / (2 * bulge);
  const center: [number, number] = [(a[0] + b[0]) / 2 - dy / chord * offset, (a[1] + b[1]) / 2 + dx / chord * offset];
  const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
  const from = Math.atan2(a[1] - center[1], a[0] - center[0]), sweep = 4 * Math.atan(Math.abs(bulge));
  return bulge > 0 ? ocsArc(frame, center, elevation, radius, from, from + sweep) : ocsArc(frame, center, elevation, radius, from, from - sweep, true);
}

/** Points along a NURBS curve by de Boor's algorithm; null when its knots do not match its control points. */
export function nurbsPoints(degree: number, knots: number[], control: Vec3[], weights: number[] | null, samples: number): Vec3[] | null {
  const n = control.length, p = degree;
  if (p < 1 || n <= p || knots.length !== n + p + 1) return null;
  const lo = knots[p]!, hi = knots[n]!;
  if (!(hi > lo)) return null;
  const w = (i: number): number => weights && weights[i]! > 0 ? weights[i]! : 1;
  const out: Vec3[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? hi : lo + (hi - lo) * s / samples;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]!) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => { const c = control[k - p + j]!, wj = w(k - p + j); return [c[0] * wj, c[1] * wj, c[2] * wj, wj]; });
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j, denominator = knots[i + p - r + 1]! - knots[i]!;
        const alpha = denominator === 0 ? 0 : (t - knots[i]!) / denominator;
        d[j] = d[j]!.map((value, m) => (1 - alpha) * d[j - 1]![m]! + alpha * value);
      }
    }
    const h = d[p]!;
    if (!(h[3]! !== 0)) return null;
    out.push([h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!]);
  }
  return out;
}

/** Samples per control point of a sampled spline. */
const SPLINE_SAMPLES_PER_POINT = 4;
const MAX_SPLINE_SAMPLES = 2048;

function splineCurve(degree: number, knots: number[], control: Vec3[], weights: number[] | null, fit: Vec3[], closed: boolean): DxfCurve | null {
  const samples = Math.min(MAX_SPLINE_SAMPLES, Math.max(16, control.length * SPLINE_SAMPLES_PER_POINT));
  let points = control.length ? nurbsPoints(degree, knots, control, weights, samples) : null;
  // Without usable control data the curve passes through its fit points.
  points ??= fit.length >= 2 ? [...fit] : control.length >= 2 ? [...control] : null;
  if (!points) return null;
  if (closed && points.length > 2) {
    const a = points[0]!, b = points.at(-1)!;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) points.push(a);
  }
  return { kind: 'points', points };
}

/** The point of an arc at parameter t. */
export function arcPoint(curve: Extract<DxfCurve, { kind: 'arc' }>, t: number): Vec3 {
  return add(curve.center, add(scale(curve.u, Math.cos(t)), scale(curve.v, Math.sin(t))));
}

/** The start and end point of a curve. */
export function curveEnds(curve: DxfCurve): [Vec3, Vec3] {
  if (curve.kind === 'line') return [curve.a, curve.b];
  if (curve.kind === 'points') return [curve.points[0]!, curve.points.at(-1)!];
  return [arcPoint(curve, curve.start), arcPoint(curve, curve.end)];
}

const TEXT_ESCAPES: Record<string, string> = { c: 'Ø', d: '°', p: '±', '%': '%' };
/** TEXT content with %% control codes resolved and \U+ escapes decoded; %%u toggles underline. */
function plainText(value: string): { text: string; underline: boolean } {
  let underline = false;
  const text = value.replace(/\\U\+([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%(\d{3}|[a-z%])/gi, (_, code: string) => {
      if (/^\d{3}$/.test(code)) return String.fromCharCode(Number(code));
      if (code.toLowerCase() === 'u' || code.toLowerCase() === 'o') { underline ||= code.toLowerCase() === 'u'; return ''; }
      return TEXT_ESCAPES[code.toLowerCase()] ?? '';
    });
  return { text, underline };
}

/** MTEXT content without its formatting codes: paragraphs become line breaks and stacked fractions read a/b. */
export function mtextPlain(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '{' || c === '}') continue;
    if (c !== '\\') { out += c; continue; }
    const code = value[++i];
    if (code === undefined) break;
    if (code === 'P' || code === 'X') out += '\n';
    else if (code === '~') out += ' ';
    else if (code === '\\' || code === '{' || code === '}') out += code;
    else if (code === 'U' && value[i + 1] === '+') { out += String.fromCharCode(parseInt(value.slice(i + 2, i + 6), 16)); i += 5; }
    else if (code === 'S') {
      const end = value.indexOf(';', i);
      out += value.slice(i + 1, end < 0 ? undefined : end).replace(/[#^]/, '/');
      i = end < 0 ? value.length : end;
    } else if ('LlOoKk'.includes(code)) continue;
    else {
      // Codes with an argument (\f font, \H height, \C color, \A alignment, \Q, \T, \W) run to their semicolon.
      const end = value.indexOf(';', i);
      i = end < 0 ? value.length : end;
    }
  }
  return out.replace(/%%([cdp%])/gi, (_, code: string) => TEXT_ESCAPES[code.toLowerCase()]!);
}

/** MTEXT attachment points 1–9: top/middle/bottom by left/center/right. */
const ATTACHMENTS: readonly ['left' | 'center' | 'right', 'top' | 'middle' | 'bottom'][] = [
  ['left', 'top'], ['center', 'top'], ['right', 'top'], ['left', 'middle'], ['center', 'middle'], ['right', 'middle'],
  ['left', 'bottom'], ['center', 'bottom'], ['right', 'bottom']];

function style(rec: Rec): DxfStyle {
  const rgb = rec.has(420) ? rec.num(420) : null;
  return {
    layer: rec.str(8, '0') || '0',
    color: rgb !== null ? { rgb: [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255] } : { aci: rec.num(62, 256) },
    linetype: rec.str(6, 'BYLAYER') || 'BYLAYER', linetypeScale: rec.num(48, 1), lineweight: rec.num(370, -1),
  };
}

/** A block placement: OCS, insertion point, rotation, scale and array offset, from the block's base point. */
function insertTransform(rec: Rec, base: Vec3, column: number, row: number): Mat4 {
  const frame = ocs(rec.extrusion()), p = rec.point(10), rotation = rec.num(50) * DEG;
  const s: Vec3 = [rec.num(41, 1) || 1, rec.num(42, 1) || 1, rec.num(43, 1) || 1];
  let m = m4mul(frame.matrix, m4translation(p));
  m = m4mul(m, m4rotationAxis([0, 0, 1], rotation));
  if (column || row) m = m4mul(m, m4translation([column * rec.num(44), row * rec.num(45), 0]));
  m = m4mul(m, m4scaling(s));
  return m4mul(m, m4translation([-base[0], -base[1], -base[2]])) as unknown as Mat4;
}

interface Reader { drawing: DxfDrawing; bases: Map<string, Vec3>; count: (type: string) => void }

/** Polyline vertices of a POLYLINE: 2D (OCS, with bulges), 3D, polyface mesh or polygon mesh. */
function readPolyline(head: Rec, vertices: Rec[], out: DxfItem[]): void {
  const flags = head.num(70), st = style(head);
  if (flags & 64) {
    // Polyface mesh: position vertices, then face records indexing them (1-based; negative marks an invisible edge).
    const positions = vertices.filter(v => v.num(70) & 64).map(v => v.point(10));
    for (const face of vertices.filter(v => (v.num(70) & 192) === 128)) {
      const corners = [71, 72, 73, 74].map(code => Math.abs(face.num(code))).filter(i => i > 0 && i <= positions.length).map(i => positions[i - 1]!);
      if (corners.length >= 3) out.push({ ...st, layer: face.str(8, st.layer) || st.layer, kind: 'face', corners, filled: false, source: 'POLYLINE' });
    }
    return;
  }
  if (flags & 16) {
    // Polygon mesh: an M by N grid, closed in M or N by flags 1 and 32.
    const m = head.num(71), n = head.num(72), grid = vertices.map(v => v.point(10));
    if (m < 2 || n < 2 || grid.length < m * n) return;
    const at = (i: number, j: number): Vec3 => grid[(i % m) * n + (j % n)]!;
    for (let i = 0; i < ((flags & 1) ? m : m - 1); i++) for (let j = 0; j < ((flags & 32) ? n : n - 1); j++)
      out.push({ ...st, kind: 'face', corners: [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], filled: false, source: 'POLYLINE' });
    return;
  }
  const closed = !!(flags & 1), curves: DxfCurve[] = [];
  if (flags & 8) {
    const points = vertices.map(v => v.point(10));
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) curves.push({ kind: 'line', a, b });
    }
  } else {
    const frame = ocs(head.extrusion()), elevation = head.point(10)[2];
    const points = vertices.map(v => ({ p: [v.num(10), v.num(20)] as [number, number], bulge: v.num(42) }));
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      const segment = bulgeSegment(frame, points[i]!.p, points[(i + 1) % points.length]!.p, points[i]!.bulge, elevation);
      if (segment) curves.push(segment);
    }
  }
  if (curves.length) out.push({ ...st, kind: 'path', curves, closed: closed && curves.length > 0, source: 'POLYLINE' });
}

function readLwPolyline(rec: Rec, out: DxfItem[]): void {
  const frame = ocs(rec.extrusion()), elevation = rec.num(38), closed = !!(rec.num(70) & 1);
  const points: { p: [number, number]; bulge: number }[] = [];
  for (const [code, value] of rec.pairs) {
    if (code === 10) points.push({ p: [Number(value), 0], bulge: 0 });
    else if (code === 20 && points.length) points.at(-1)!.p[1] = Number(value);
    else if (code === 42 && points.length) points.at(-1)!.bulge = Number(value);
  }
  const curves: DxfCurve[] = [];
  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const segment = bulgeSegment(frame, points[i]!.p, points[(i + 1) % points.length]!.p, points[i]!.bulge, elevation);
    if (segment) curves.push(segment);
  }
  if (curves.length) out.push({ ...style(rec), kind: 'path', curves, closed, source: 'LWPOLYLINE' });
}

function readSpline(rec: Rec, out: DxfItem[]): void {
  const knots: number[] = [], weights: number[] = [], control: [number, number, number][] = [], fit: [number, number, number][] = [];
  for (const [code, value] of rec.pairs) {
    const n = Number(value);
    if (code === 40) knots.push(n);
    else if (code === 41) weights.push(n);
    else if (code === 10) control.push([n, 0, 0]);
    else if (code === 20 && control.length) control.at(-1)![1] = n;
    else if (code === 30 && control.length) control.at(-1)![2] = n;
    else if (code === 11) fit.push([n, 0, 0]);
    else if (code === 21 && fit.length) fit.at(-1)![1] = n;
    else if (code === 31 && fit.length) fit.at(-1)![2] = n;
  }
  const curve = splineCurve(rec.num(71, 3), knots, control, weights.length === control.length ? weights : null, fit, !!(rec.num(70) & 1));
  if (curve) out.push({ ...style(rec), kind: 'path', curves: [curve], closed: !!(rec.num(70) & 1), source: 'SPLINE' });
}

/** HATCH boundary loops (OCS at the hatch's elevation); only solid-filled hatches are read. */
function readHatch(rec: Rec, out: DxfItem[], count: (type: string) => void): void {
  if (rec.num(70) !== 1) { count('HATCH (pattern)'); return; }
  const frame = ocs(rec.extrusion()), elevation = rec.point(10)[2], list = rec.pairs;
  const loops: DxfCurve[][] = [];
  let i = list.findIndex(p => p[0] === 91);
  if (i < 0) return;
  const paths = Number(list[i]![1]);
  i++;
  // Each value read in order; `take` returns the next value with this code, skipping others it does not know.
  const take = (code: number): number => {
    while (i < list.length && list[i]![0] !== code) {
      if (list[i]![0] === 92 || list[i]![0] === 75) return NaN;
      i++;
    }
    return i < list.length ? Number(list[i++]![1]) : NaN;
  };
  const point2 = (code: number): [number, number] => [take(code), take(code + 10)];
  for (let path = 0; path < paths && i < list.length; path++) {
    const type = take(92), loop: DxfCurve[] = [];
    if (!Number.isFinite(type)) break;
    if (type & 2) {
      const hasBulge = take(72), closed = take(73), count2 = take(93), points: { p: [number, number]; bulge: number }[] = [];
      for (let k = 0; k < count2; k++) points.push({ p: point2(10), bulge: hasBulge ? take(42) : 0 });
      for (let k = 0; k < points.length - (closed || points.length > 2 ? 0 : 1); k++) {
        const segment = bulgeSegment(frame, points[k]!.p, points[(k + 1) % points.length]!.p, points[k]!.bulge, elevation);
        if (segment) loop.push(segment);
      }
    } else {
      const edges = take(93);
      for (let e = 0; e < edges; e++) {
        const kind = take(72);
        if (kind === 1) {
          const a = point2(10), b = point2(11);
          loop.push({ kind: 'line', a: frame.point([a[0], a[1], elevation]), b: frame.point([b[0], b[1], elevation]) });
        } else if (kind === 2) {
          const c = point2(10), r = take(40), s = take(50) * DEG, t = take(51) * DEG, ccw = take(73);
          loop.push(ocsArc(frame, c, elevation, r, ccw ? s : -s, ccw ? t : -t, !ccw));
        } else if (kind === 3) {
          const c = point2(10), major = point2(11), ratio = take(40), s = take(50) * DEG, t = take(51) * DEG, ccw = take(73);
          const u = frame.dir([major[0], major[1], 0]), v = scale(frame.dir([-major[1], major[0], 0]), ccw ? ratio : -ratio);
          let sweep = ((t - s) % TURN + TURN) % TURN || TURN;
          if (Math.abs(t - s) >= TURN) sweep = TURN;
          // A clockwise edge runs the other way round: the same angles about a mirrored minor axis.
          loop.push({ kind: 'arc', center: frame.point([c[0], c[1], elevation]), u, v, start: s, end: s + sweep });
        } else if (kind === 4) {
          const degree = take(94); take(73); take(74);
          const knotCount = take(95), controlCount = take(96), knots: number[] = [], control: Vec3[] = [];
          for (let k = 0; k < knotCount; k++) knots.push(take(40));
          for (let k = 0; k < controlCount; k++) { const p = point2(10); control.push(frame.point([p[0], p[1], elevation])); }
          const curve = splineCurve(degree, knots, control, null, [], false);
          if (curve) loop.push(curve);
        } else break;
      }
    }
    if (loop.length) loops.push(loop);
  }
  if (loops.length) out.push({ ...style(rec), kind: 'fill', loops });
}

function readMesh(rec: Rec, out: DxfItem[]): void {
  const list = rec.pairs, vertices: Vec3[] = [];
  let i = list.findIndex(p => p[0] === 92);
  if (i < 0) return;
  const count = Number(list[i]![1]);
  for (i++; i < list.length && vertices.length < count; i++) {
    if (list[i]![0] === 10) vertices.push([Number(list[i]![1]), Number(list[i + 1]?.[1]), Number(list[i + 2]?.[1])]);
  }
  i = list.findIndex((p, k) => k >= i && p[0] === 93);
  if (i < 0) return;
  const size = Number(list[i]![1]), values: number[] = [];
  for (i++; i < list.length && values.length < size && list[i]![0] === 90; i++) values.push(Number(list[i]![1]));
  const st = style(rec);
  for (let k = 0; k < values.length;) {
    const n = values[k]!, corners = values.slice(k + 1, k + 1 + n).map(v => vertices[v]).filter((v): v is Vec3 => !!v);
    if (corners.length >= 3) out.push({ ...st, kind: 'face', corners, filled: false, source: 'MESH' });
    k += n + 1;
  }
}

function readText(rec: Rec, out: DxfItem[]): void {
  const frame = ocs(rec.extrusion()), height = rec.num(40), rotation = rec.num(50) * DEG;
  if (!(height > 0)) return;
  const { text, underline } = plainText(rec.raw(1) ?? '');
  if (!text.trim()) return;
  const h = rec.num(72), v = rec.num(rec.type === 'TEXT' ? 73 : 74);
  // Left, baseline text is placed at its first point; any other justification at its second.
  const anchor = (h || v) && rec.has(11) ? rec.point(11) : rec.point(10);
  const x = frame.dir([Math.cos(rotation) * height, Math.sin(rotation) * height, 0]);
  const y = frame.dir([-Math.sin(rotation) * height, Math.cos(rotation) * height, 0]);
  const align = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
  const vertical = h === 4 ? 'middle' : v === 1 ? 'bottom' : v === 2 ? 'middle' : v === 3 ? 'top' : 'baseline';
  out.push({ ...style(rec), kind: 'text', text, anchor: frame.point(anchor), x, y, align, vertical, widthFactor: rec.num(41, 1) || 1, underline, source: rec.type });
}

function readMText(rec: Rec, out: DxfItem[]): void {
  const height = rec.num(40);
  if (!(height > 0)) return;
  const text = mtextPlain(rec.pairs.filter(p => p[0] === 3).map(p => p[1]).join('') + (rec.raw(1) ?? ''));
  if (!text.trim()) return;
  const normal = rec.extrusion(), frame = ocs(normal);
  let x: Vec3 = rec.has(11) ? rec.point(11) : frame.dir([Math.cos(rec.num(50)), Math.sin(rec.num(50)), 0]);
  x = v3len(x) > 0 ? v3normalize(x) : frame.dir([1, 0, 0]);
  const y = v3normalize(v3cross(normal, x));
  const [align, vertical] = ATTACHMENTS[rec.num(71, 1) - 1] ?? ATTACHMENTS[0]!;
  out.push({ ...style(rec), kind: 'text', text, anchor: rec.point(10), x: scale(x, height), y: scale(y, height), align, vertical, widthFactor: 1, underline: false, source: 'MTEXT' });
}

/** The items of one entity list, joining POLYLINE vertices and INSERT attributes to their entity. */
function readEntities(records: Rec[], reader: Reader, out: DxfItem[], paper: boolean): void {
  for (let k = 0; k < records.length; k++) {
    const rec = records[k]!;
    // A POLYLINE's VERTEX records, and an INSERT's ATTRIB records, follow it up to their SEQEND.
    const following: Rec[] = [];
    if (rec.type === 'POLYLINE' || rec.type === 'INSERT' && rec.num(66) === 1) {
      while (k + 1 < records.length && records[k + 1]!.type !== 'SEQEND' && (records[k + 1]!.type === 'VERTEX' || records[k + 1]!.type === 'ATTRIB')) following.push(records[++k]!);
      if (records[k + 1]?.type === 'SEQEND') k++;
    }
    if (paper || rec.num(67) === 1) { if (rec.type !== 'VIEWPORT') reader.drawing.paperSpace++; continue; }
    if (rec.num(60) === 1) continue;
    if (rec.num(39) !== 0 && ['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'SOLID', 'TRACE', 'TEXT'].includes(rec.type)) reader.drawing.thick++;
    switch (rec.type) {
      case 'LINE': {
        const a = rec.point(10), b = rec.point(11);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) out.push({ ...style(rec), kind: 'path', curves: [{ kind: 'line', a, b }], closed: false, source: 'LINE' });
        break;
      }
      case 'LWPOLYLINE': readLwPolyline(rec, out); break;
      case 'POLYLINE': readPolyline(rec, following.filter(v => v.type === 'VERTEX'), out); break;
      case 'CIRCLE': case 'ARC': {
        const r = rec.num(40), c = rec.point(10);
        if (!(r > 0)) break;
        const full = rec.type === 'CIRCLE';
        const curve = ocsArc(ocs(rec.extrusion()), [c[0], c[1]], c[2], r, full ? 0 : rec.num(50) * DEG, full ? TURN : rec.num(51) * DEG);
        out.push({ ...style(rec), kind: 'path', curves: [curve], closed: full, source: rec.type });
        break;
      }
      case 'ELLIPSE': {
        const center = rec.point(10), major = rec.point(11), ratio = rec.num(40, 1), normal = rec.extrusion();
        if (!(v3len(major) > 0) || !(ratio > 0)) break;
        const start = rec.num(41), end = rec.num(42, TURN);
        let sweep = ((end - start) % TURN + TURN) % TURN || TURN;
        if (Math.abs(end - start) >= TURN) sweep = TURN;
        const v = scale(v3cross(normal, major), ratio);
        out.push({ ...style(rec), kind: 'path', curves: [{ kind: 'arc', center, u: major, v, start, end: start + sweep }], closed: sweep === TURN, source: 'ELLIPSE' });
        break;
      }
      case 'SPLINE': readSpline(rec, out); break;
      case '3DFACE': {
        const corners = [10, 11, 12, 13].map(code => rec.point(code));
        if (corners[3]![0] === corners[2]![0] && corners[3]![1] === corners[2]![1] && corners[3]![2] === corners[2]![2]) corners.pop();
        out.push({ ...style(rec), kind: 'face', corners, filled: false, source: '3DFACE' });
        break;
      }
      case 'SOLID': case 'TRACE': {
        // Corners run 1, 2, 4, 3 around the outline; a triangle repeats its third corner.
        const frame = ocs(rec.extrusion()), p = [10, 11, 12, 13].map(code => frame.point(rec.point(code)));
        const corners = [p[0]!, p[1]!, p[3]!, p[2]!].filter((c, i, all) => i === 0 || c.some((x, j) => x !== all[i - 1]![j]));
        out.push({ ...style(rec), kind: 'face', corners, filled: true, source: rec.type });
        break;
      }
      case 'TEXT': case 'ATTRIB': if (rec.type === 'TEXT' || !(rec.num(70) & 1)) readText(rec, out); break;
      case 'MTEXT': readMText(rec, out); break;
      case 'INSERT': {
        const block = rec.str(2), base = reader.bases.get(block) ?? [0, 0, 0];
        const columns = Math.max(1, Math.min(1000, rec.num(70, 1))), rows = Math.max(1, Math.min(1000, rec.num(71, 1)));
        for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++)
          out.push({ ...style(rec), kind: 'insert', block, transform: insertTransform(rec, base, c, r), source: 'INSERT' });
        // Attributes are placed in the holder's coordinates already.
        for (const attribute of following) if (attribute.type === 'ATTRIB' && !(attribute.num(70) & 1)) readText(attribute, out);
        break;
      }
      case 'DIMENSION': {
        // A dimension's drawing is an anonymous block placed at the origin.
        const block = rec.str(2);
        if (block) out.push({ ...style(rec), kind: 'insert', block, transform: M4_IDENTITY, source: 'DIMENSION' });
        break;
      }
      case 'LEADER': {
        const points: [number, number, number][] = [];
        for (const [code, value] of rec.pairs) {
          if (code === 10) points.push([Number(value), 0, 0]);
          else if (code === 20 && points.length) points.at(-1)![1] = Number(value);
          else if (code === 30 && points.length) points.at(-1)![2] = Number(value);
        }
        const curves: DxfCurve[] = [];
        for (let i = 0; i + 1 < points.length; i++) curves.push({ kind: 'line', a: points[i]!, b: points[i + 1]! });
        if (curves.length) out.push({ ...style(rec), kind: 'path', curves, closed: false, source: 'LEADER' });
        break;
      }
      case 'HATCH': readHatch(rec, out, reader.count); break;
      case 'MESH': readMesh(rec, out); break;
      case 'ATTDEF': case 'VIEWPORT': case 'SEQEND': case 'VERTEX': break;
      default: reader.count(rec.type);
    }
  }
}

/** Records of a section between its header pair and ENDSEC, split at each group code 0. */
function records(list: readonly Pair[], from: number): { recs: Rec[]; end: number } {
  const recs: Rec[] = [];
  let i = from;
  while (i < list.length && !(list[i]![0] === 0 && list[i]![1].trim() === 'ENDSEC')) {
    if (list[i]![0] !== 0) { i++; continue; }
    const type = list[i]![1].trim(), start = ++i;
    while (i < list.length && list[i]![0] !== 0) i++;
    let body = list.slice(start, i);
    const embedded = body.findIndex(p => p[0] === 101);
    if (embedded >= 0) body = body.slice(0, embedded);
    recs.push(new Rec(type, body));
  }
  return { recs, end: i };
}

/** Linetype elements: dash lengths (code 49) of a LTYPE record. */
function linetypePattern(rec: Rec): number[] {
  return rec.pairs.filter(p => p[0] === 49).map(p => Number(p[1])).filter(Number.isFinite);
}

/** Read an ASCII DXF file. Binary DXF is rejected with a message. */
export function parseDxf(bytes: Uint8Array): DxfDrawing {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, BINARY_SENTINEL.length)) === BINARY_SENTINEL)
    throw new Error('Binary DXF files are not supported. Save the drawing as an ASCII DXF and import it again.');
  const list = pairs(decode(bytes));
  const drawing: DxfDrawing = { version: null, units: null, measurement: null, layers: new Map(), linetypes: new Map(), linetypeScale: 1,
    blocks: new Map(), items: [], paperSpace: 0, unsupported: new Map(), thick: 0 };
  const reader: Reader = { drawing, bases: new Map(), count: type => drawing.unsupported.set(type, (drawing.unsupported.get(type) ?? 0) + 1) };
  let entities: Rec[] = [];
  const blockRecords: { head: Rec; body: Rec[] }[] = [];
  let sawSection = false;
  for (let i = 0; i < list.length; i++) {
    if (!(list[i]![0] === 0 && list[i]![1].trim() === 'SECTION')) continue;
    sawSection = true;
    const name = list[i + 1]?.[0] === 2 ? list[i + 1]![1].trim() : '';
    i += 2;
    if (name === 'HEADER') {
      let variable = '';
      for (; i < list.length && !(list[i]![0] === 0 && list[i]![1].trim() === 'ENDSEC'); i++) {
        const [code, value] = list[i]!;
        if (code === 9) { variable = value.trim(); continue; }
        if (variable === '$ACADVER' && code === 1) drawing.version = value.trim();
        else if (variable === '$INSUNITS' && code === 70) drawing.units = dxfUnitMeters(Number(value));
        else if (variable === '$MEASUREMENT' && code === 70) drawing.measurement = Number(value) === 1 ? 'metric' : 'imperial';
        else if (variable === '$LTSCALE' && code === 40 && Number(value) > 0) drawing.linetypeScale = Number(value);
      }
    } else if (name === 'TABLES') {
      const { recs, end } = records(list, i);
      i = end;
      for (const rec of recs) {
        if (rec.type === 'LAYER') {
          const color = rec.num(62, 7), rgb = rec.has(420) ? rec.num(420) : null, flags = rec.num(70);
          drawing.layers.set(rec.str(2), { name: rec.str(2), color: rgb !== null ? { rgb: [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255] } : { aci: Math.abs(color) || 7 },
            visible: color >= 0 && !(flags & 1), linetype: rec.str(6, 'CONTINUOUS'), lineweight: rec.num(370, -3) });
        } else if (rec.type === 'LTYPE') drawing.linetypes.set(rec.str(2).toUpperCase(), linetypePattern(rec));
      }
    } else if (name === 'BLOCKS') {
      const { recs, end } = records(list, i);
      i = end;
      for (let k = 0; k < recs.length; k++) {
        if (recs[k]!.type !== 'BLOCK') continue;
        const head = recs[k]!, body: Rec[] = [];
        while (k + 1 < recs.length && recs[k + 1]!.type !== 'ENDBLK') body.push(recs[++k]!);
        k++;
        blockRecords.push({ head, body });
        reader.bases.set(head.str(2), head.point(10));
      }
    } else if (name === 'ENTITIES') {
      const { recs, end } = records(list, i);
      i = end;
      entities = recs;
    } else {
      while (i < list.length && !(list[i]![0] === 0 && list[i]![1].trim() === 'ENDSEC')) i++;
    }
  }
  if (!sawSection) throw new Error('This file is not a DXF drawing.');
  for (const { head, body } of blockRecords) {
    const blockName = head.str(2), paper = /^\*paper_space/i.test(blockName);
    if (/^\*model_space/i.test(blockName)) continue;
    const items: DxfItem[] = [];
    readEntities(body, reader, items, paper);
    drawing.blocks.set(blockName, { name: blockName, items, xref: !!(head.num(70) & 4) });
  }
  readEntities(entities, reader, drawing.items, false);
  return drawing;
}

/** AutoCAD Color Index 1–255 as RGB (0–255); 7 (white or black) is black, as on paper. */
export function aciColor(index: number): [number, number, number] {
  const fixed: Record<number, [number, number, number]> = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255],
    6: [255, 0, 255], 7: [0, 0, 0], 8: [128, 128, 128], 9: [192, 192, 192], 250: [51, 51, 51], 251: [80, 80, 80], 252: [105, 105, 105],
    253: [130, 130, 130], 254: [190, 190, 190], 255: [255, 255, 255] };
  if (fixed[index]) return fixed[index];
  if (index < 10 || index > 249) return [0, 0, 0];
  // Indices 10–249 step through 24 hues 15° apart, each in five shades, full and half saturated.
  const hue = Math.floor((index - 10) / 10) * 15, k = (index - 10) % 10;
  const value = [255, 165, 127, 76, 38][Math.floor(k / 2)]!, saturation = k % 2 ? 0.5 : 1;
  const c = value * saturation, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = value - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.floor(r + m), Math.floor(g + m), Math.floor(b + m)];
}

/** An entity's color with by-layer and by-block resolved; `inherited` is the color of the insert that places it. */
export function resolveColor(color: DxfColor, layer: DxfLayer | undefined, inherited: [number, number, number] | null): [number, number, number] {
  if ('rgb' in color) return color.rgb;
  if (color.aci === 0) return inherited ?? [0, 0, 0];
  if (color.aci === 256 || color.aci < 0 || color.aci > 256) return layer ? ('rgb' in layer.color ? layer.color.rgb : aciColor(layer.color.aci)) : [0, 0, 0];
  return aciColor(color.aci);
}

/** Summary notes of what a drawing leaves out, shared by model and Layout import. */
export function dxfNotes(drawing: DxfDrawing, skipped: Map<string, number>): string[] {
  const notes: string[] = [];
  const all = new Map(drawing.unsupported);
  for (const [type, n] of skipped) all.set(type, (all.get(type) ?? 0) + n);
  if (all.size) {
    const total = [...all.values()].reduce((a, b) => a + b, 0);
    const list = [...all].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, n]) => `${n} ${type}`).join(', ');
    notes.push(`${total} entit${total === 1 ? 'y is' : 'ies are'} not imported: ${list}.`);
  }
  if (drawing.paperSpace) notes.push(`${drawing.paperSpace} entit${drawing.paperSpace === 1 ? 'y' : 'ies'} on paper space layouts ${drawing.paperSpace === 1 ? 'is' : 'are'} not imported; the model space drawing is.`);
  if (drawing.thick) notes.push(`${drawing.thick} entit${drawing.thick === 1 ? 'y has' : 'ies have'} a thickness, which is not imported.`);
  const xrefs = [...drawing.blocks.values()].filter(b => b.xref).length;
  if (xrefs) notes.push(`${xrefs} external reference${xrefs === 1 ? ' is' : 's are'} not imported.`);
  return notes;
}
