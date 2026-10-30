// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, m4mul, m4transformDir, m4transformPoint, M4_IDENTITY, type Mat4, type Vec3 } from '@pushform/core';
import type { LayoutEntity, LayoutPathHandle } from '@pushform/layout';
import {
  arcPoint, curveEnds, dxfNotes, parseDxf, resolveColor,
  type DxfCurve, type DxfDrawing, type DxfItem, type DxfLayer, type DxfUnit,
} from './dxf';

// DXF import into Layout: model space as native paths, fills and text in one group, at the largest
// standard drawing scale that fits the page.

/** Margin left around a drawing that is reduced to fit the page, as for images, in paper millimeters. */
const PAGE_MARGIN_MM = 20;
/** Paper millimeters per point. */
const MM_PER_PT = 25.4 / 72;
/** AutoCAD's default lineweight, used for by-default and unresolved lineweights, in millimeters. */
const DEFAULT_LINEWEIGHT_MM = 0.25;
/** A linetype dot is drawn as a dash this long, in paper millimeters. */
const DOT_MM = 0.1;
/** A dash pattern shorter than this in paper millimeters reads as a solid line and is drawn as one. */
const MIN_PATTERN_MM = 0.3;
/** Arial's cap height, and its baseline below the top of a text line, as fractions of the font size. */
const CAP_HEIGHT_EM = 0.716, BASELINE_EM = 0.8;
/** Estimated average character width as a fraction of the font size, for text box widths. */
const CHAR_WIDTH_EM = 0.55;
/** Layout's text line height as a multiple of the font size. */
const LINE_HEIGHT_EM = 1.25;
/** Most objects one import creates. */
export const MAX_DXF_LAYOUT_OBJECTS = 100_000;
/** Deepest block nesting followed. */
const MAX_BLOCK_DEPTH = 32;

/** Drawing scale denominators tried in turn, for metric and for imperial drawings (architectural and engineering scales). */
const METRIC_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
const IMPERIAL_SCALES = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 120, 192, 240, 360, 384, 480, 600, 720, 960, 1200, 2400, 4800, 6000, 12000];
const IMPERIAL_UNITS: ReadonlySet<DxfUnit> = new Set(['in', 'ft', 'yd', 'mi', 'µin', 'mil', 'usft', 'usin', 'usyd', 'usmi']);

export interface DxfLayoutImport {
  /** Objects in paper millimeters with clipboard group ids, ready to paste. */
  entities: LayoutEntity[];
  /** The drawing scale's denominator: 50 is 1:50. */
  scale: number;
  /** The unit the drawing was read in, and whether the file recorded it. */
  unit: DxfUnit; unitRecorded: boolean;
  warnings: string[];
}

interface Inherited { layer: string | null; color: [number, number, number] | null; linetype: string | null; lineweight: number | null }
interface Placed { item: Exclude<DxfItem, { kind: 'insert' }>; transform: Mat4; groups: number[]; inherited: Inherited }

const hex = (rgb: readonly number[]): string => `#${rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;

/** Every item of model space with the transform from its block to the drawing, and the insert groups that hold it. */
function placeItems(drawing: DxfDrawing, warn: (message: string) => void): Placed[] {
  const out: Placed[] = [];
  let nextGroup = 2, cycles = 0, deep = 0;
  const visit = (items: DxfItem[], transform: Mat4, groups: number[], inherited: Inherited, path: string[]): void => {
    for (const item of items) {
      if (item.kind !== 'insert') { out.push({ item, transform, groups, inherited }); continue; }
      const block = drawing.blocks.get(item.block);
      if (!block || block.xref) continue;
      if (path.includes(item.block)) { cycles++; continue; }
      if (path.length >= MAX_BLOCK_DEPTH) { deep++; continue; }
      const layer = item.layer === '0' && inherited.layer ? inherited.layer : item.layer;
      const color = resolveColor(item.color, drawing.layers.get(layer), inherited.color);
      const linetype = item.linetype.toUpperCase() === 'BYBLOCK' ? inherited.linetype : item.linetype.toUpperCase() === 'BYLAYER' ? drawing.layers.get(layer)?.linetype ?? null : item.linetype;
      const lineweight = item.lineweight === -2 ? inherited.lineweight : item.lineweight === -1 ? drawing.layers.get(layer)?.lineweight ?? null : item.lineweight;
      visit(block.items, m4mul(transform, item.transform) as unknown as Mat4, [...groups, nextGroup++], { layer, color, linetype, lineweight }, [...path, item.block]);
    }
  };
  visit(drawing.items, M4_IDENTITY, [], { layer: null, color: null, linetype: null, lineweight: null }, []);
  if (cycles) warn(`${cycles} block insert${cycles === 1 ? ' that places its own block is' : 's that place their own blocks are'} not imported.`);
  if (deep) warn(`${deep} block insert${deep === 1 ? ' is' : 's are'} nested more than ${MAX_BLOCK_DEPTH} levels deep and not imported.`);
  return out;
}

/** Points along a curve for measuring its extent. */
function samplePoints(curve: DxfCurve): Vec3[] {
  if (curve.kind !== 'arc') return curve.kind === 'line' ? [curve.a, curve.b] : curve.points;
  const n = Math.max(4, Math.ceil((curve.end - curve.start) / (Math.PI / 8)));
  return Array.from({ length: n + 1 }, (_, i) => arcPoint(curve, curve.start + (curve.end - curve.start) * i / n));
}

/** A paper path through connected curves (paper coordinates, y down), with arcs as cubic Béziers of at most 90°. */
function paperPath(curves: DxfCurve[], closed: boolean, paper: (p: Vec3) => [number, number], paperDir: (d: Vec3) => [number, number]):
  { points: [number, number][]; handles: LayoutPathHandle[]; closed: boolean } | null {
  const points: [number, number][] = [], handles: LayoutPathHandle[] = [];
  const same = (a: [number, number], b: [number, number]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= LENGTH_TOL * 1000;
  const moveTo = (p: [number, number]): void => {
    if (!points.length || !same(points.at(-1)!, p)) { points.push(p); handles.push({}); }
  };
  for (const curve of curves) {
    moveTo(paper(curveEnds(curve)[0]));
    if (curve.kind === 'line') { moveTo(paper(curve.b)); continue; }
    if (curve.kind === 'points') { for (const p of curve.points.slice(1)) moveTo(paper(p)); continue; }
    const pieces = Math.max(1, Math.ceil((curve.end - curve.start) / (Math.PI / 2) - LENGTH_TOL));
    for (let k = 0; k < pieces; k++) {
      const t0 = curve.start + (curve.end - curve.start) * k / pieces, t1 = curve.start + (curve.end - curve.start) * (k + 1) / pieces;
      const handle = 4 / 3 * Math.tan((t1 - t0) / 4);
      const d0 = paperDir([-curve.u[0] * Math.sin(t0) + curve.v[0] * Math.cos(t0), -curve.u[1] * Math.sin(t0) + curve.v[1] * Math.cos(t0), 0]);
      const d1 = paperDir([-curve.u[0] * Math.sin(t1) + curve.v[0] * Math.cos(t1), -curve.u[1] * Math.sin(t1) + curve.v[1] * Math.cos(t1), 0]);
      const from = points.at(-1)!, to = paper(arcPoint(curve, t1));
      handles[handles.length - 1]!.out = [from[0] + d0[0] * handle, from[1] + d0[1] * handle];
      points.push(to); handles.push({ in: [to[0] - d1[0] * handle, to[1] - d1[1] * handle] });
    }
  }
  let isClosed = false;
  if (points.length > 2 && same(points[0]!, points.at(-1)!)) {
    const last = handles.pop()!; points.pop();
    if (last.in) handles[0]!.in = last.in;
    isClosed = true;
  } else if (closed && points.length > 2) isClosed = true;
  if (points.length < 2) return null;
  // A path of two points that is closed is one segment back and forth; it is drawn open.
  if (isClosed && points.length < 3) isClosed = false;
  return { points, handles, closed: isClosed };
}

/** A linetype's dash pattern in paper millimeters, or null for a solid line. */
function dashPattern(pattern: number[] | undefined, length: number): number[] | undefined {
  if (!pattern?.length) return undefined;
  const runs: { dash: boolean; mm: number }[] = [];
  for (const element of pattern) {
    const dash = element >= 0, mm = element === 0 ? DOT_MM : Math.abs(element) * length;
    if (runs.length && runs.at(-1)!.dash === dash) runs.at(-1)!.mm += mm;
    else runs.push({ dash, mm });
  }
  if (!runs[0]!.dash) runs.push(runs.shift()!);
  if (runs.length > 1 && runs.at(-1)!.dash) runs[0]!.mm += runs.pop()!.mm;
  const out = runs.map(run => run.mm);
  if (out.length < 2 || out.length % 2 || out.reduce((a, b) => a + b, 0) < MIN_PATTERN_MM || out.some(mm => !(mm > 0))) return undefined;
  return out;
}

/**
 * Convert a DXF file's model space to Layout objects for a page of `pageSize` millimeters. The drawing keeps
 * its true scale at the largest standard scale (1:1, 1:2, 1:5 … or 1:1, 1:2, 1:4 … 1:48 … for imperial drawings) at
 * which it fits the page less a margin. Objects share one group; each block insert is a group inside it.
 */
export function dxfLayoutEntities(bytes: Uint8Array, pageSize: readonly [number, number]): DxfLayoutImport {
  const drawing = parseDxf(bytes), warnings: string[] = [], skipped = new Map<string, number>();
  const skip = (type: string): void => { skipped.set(type, (skipped.get(type) ?? 0) + 1); };
  const unit: DxfUnit = drawing.units?.unit ?? (drawing.measurement === 'imperial' ? 'in' : 'mm');
  const meters = drawing.units?.meters ?? (unit === 'in' ? 0.0254 : 0.001);
  const placed = placeItems(drawing, message => warnings.push(message));
  const layerOf = (p: Placed): string => p.item.layer === '0' && p.inherited.layer ? p.inherited.layer : p.item.layer;
  const visible = (p: Placed): boolean => {
    const name = layerOf(p), layer = drawing.layers.get(name);
    return (layer?.visible ?? true) && name.toLowerCase() !== 'defpoints';
  };
  const shown = placed.filter(visible);

  // Extent in drawing units, seen from above.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (p: Vec3): void => { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); };
  for (const { item, transform } of shown) {
    const at = (p: Vec3): Vec3 => m4transformPoint(transform, p);
    if (item.kind === 'path') for (const curve of item.curves) samplePoints(curve).forEach(p => extend(at(p)));
    else if (item.kind === 'face') item.corners.forEach(p => extend(at(p)));
    else if (item.kind === 'fill') for (const loop of item.loops) for (const curve of loop) samplePoints(curve).forEach(p => extend(at(p)));
    else extend(at(item.anchor));
  }
  if (!Number.isFinite(minX)) throw new Error('This DXF file has no lines, curves, fills or text in model space to import.');
  const widthMm = (maxX - minX) * meters * 1000, heightMm = (maxY - minY) * meters * 1000;
  const roomX = Math.max(1, pageSize[0] - PAGE_MARGIN_MM), roomY = Math.max(1, pageSize[1] - PAGE_MARGIN_MM);
  const scales = IMPERIAL_UNITS.has(unit) ? IMPERIAL_SCALES : METRIC_SCALES;
  const scale = scales.find(d => widthMm / d <= roomX && heightMm / d <= roomY) ?? Math.ceil(Math.max(widthMm / roomX, heightMm / roomY));
  const k = meters * 1000 / scale;

  const entities: LayoutEntity[] = [];
  const add = (entity: LayoutEntity): void => {
    if (entities.length >= MAX_DXF_LAYOUT_OBJECTS) throw new Error(`This DXF drawing has more than ${MAX_DXF_LAYOUT_OBJECTS.toLocaleString('en-US')} objects to import, which is more than a Layout page holds.`);
    entities.push(entity);
  };
  for (const p of shown) {
    const { item, transform, groups, inherited } = p;
    const name = layerOf(p), layer: DxfLayer | undefined = drawing.layers.get(name);
    const color = hex(resolveColor(item.color, layer, inherited.color));
    const membership = { groupId: 1, ...(groups.length ? { nestedGroupIds: groups } : {}) };
    const paper = (q: Vec3): [number, number] => { const w = m4transformPoint(transform, q); return [w[0] * k, -w[1] * k]; };
    const paperDir = (d: Vec3): [number, number] => { const w = m4transformDir(transform, d); return [w[0] * k, -w[1] * k]; };
    const lineweight = item.lineweight === -2 ? inherited.lineweight : item.lineweight === -1 ? layer?.lineweight ?? null : item.lineweight;
    const strokeWeightPt = (lineweight !== null && lineweight >= 0 ? lineweight / 100 : DEFAULT_LINEWEIGHT_MM) / MM_PER_PT;
    const linetypeName = item.linetype.toUpperCase() === 'BYBLOCK' ? inherited.linetype : item.linetype.toUpperCase() === 'BYLAYER' ? layer?.linetype ?? null : item.linetype;
    const dashes = dashPattern(linetypeName ? drawing.linetypes.get(linetypeName.toUpperCase()) : undefined, drawing.linetypeScale * (item.linetypeScale || 1) * k);
    const stroke = { strokeColor: color, strokeWeightPt, ...(dashes ? { strokeDashMm: dashes } : {}) };
    if (item.kind === 'path') {
      const path = paperPath(item.curves, item.closed, paper, paperDir);
      if (!path) continue;
      add({ id: 0, layerId: 0, kind: 'path', points: path.points, closed: path.closed, ...(path.handles.some(h => h.in || h.out) ? { handles: path.handles } : {}),
        style: { ...stroke, fillColor: null }, ...membership });
    } else if (item.kind === 'face') {
      const path = paperPath(item.corners.map((a, i) => ({ kind: 'line' as const, a, b: item.corners[(i + 1) % item.corners.length]! })), true, paper, paperDir);
      if (!path) continue;
      add({ id: 0, layerId: 0, kind: 'path', points: path.points, closed: path.closed, style: { ...stroke, fillColor: item.filled ? color : null }, ...membership });
    } else if (item.kind === 'fill') {
      const loops = item.loops.map(loop => paperPath(loop, true, paper, paperDir)).filter((loop): loop is NonNullable<typeof loop> => !!loop && loop.closed);
      if (!loops.length) continue;
      const points = loops.flatMap(loop => loop.points), handles = loops.flatMap(loop => loop.handles);
      const starts = loops.reduce<number[]>((list, loop, i) => [...list, i ? list.at(-1)! + loops[i - 1]!.points.length : 0], []);
      add({ id: 0, layerId: 0, kind: 'path', points, closed: true, ...(handles.some(h => h.in || h.out) ? { handles } : {}),
        ...(loops.length > 1 ? { contourStarts: starts } : {}), style: { strokeColor: color, strokeWeightPt: 0, fillColor: color }, ...membership });
    } else {
      const anchor = paper(item.anchor), x = paperDir(item.x), y = paperDir(item.y);
      const heightMm = Math.hypot(y[0], y[1]);
      if (!(heightMm > 0) || !(Math.hypot(x[0], x[1]) > 0)) { skip(item.source); continue; }
      const em = heightMm / CAP_HEIGHT_EM, lines = item.text.split('\n');
      const width = Math.max(...lines.map(line => line.length)) * CHAR_WIDTH_EM * em * item.widthFactor, height = lines.length * LINE_HEIGHT_EM * em;
      // The anchor's place in the unrotated box: across by alignment, down by the vertical justification.
      const across = item.align === 'center' ? width / 2 : item.align === 'right' ? width : 0;
      const down = item.vertical === 'top' ? (BASELINE_EM - CAP_HEIGHT_EM) * em : item.vertical === 'middle' ? height / 2
        : item.vertical === 'bottom' ? height : BASELINE_EM * em;
      const angle = Math.atan2(x[1], x[0]), along: [number, number] = [Math.cos(angle), Math.sin(angle)], below: [number, number] = [-Math.sin(angle), Math.cos(angle)];
      const center: [number, number] = [anchor[0] + along[0] * (width / 2 - across) + below[0] * (height / 2 - down),
        anchor[1] + along[1] * (width / 2 - across) + below[1] * (height / 2 - down)];
      const rotationDeg = angle * 180 / Math.PI;
      add({ id: 0, layerId: 0, kind: 'text', closed: false, points: [[center[0] - width / 2, center[1] - height / 2], [center[0] + width / 2, center[1] + height / 2]],
        text: { content: item.text, fontFamily: 'Arial', fontSizePt: em / MM_PER_PT, color, bold: false, italic: false, underline: item.underline,
          align: item.align, vertical: 'top', bounded: false, leader: 'none', endpoint: 'none', ...(rotationDeg ? { rotationDeg } : {}) },
        ...membership });
    }
  }
  if (!entities.length) throw new Error('This DXF file has no lines, curves, fills or text in model space to import.');
  const hidden = placed.length - shown.length;
  if (hidden) warnings.push(`${hidden} entit${hidden === 1 ? 'y on a layer that is off, frozen or Defpoints is' : 'ies on layers that are off, frozen or Defpoints are'} not imported.`);
  return { entities, scale, unit, unitRecorded: drawing.units !== null, warnings: [...dxfNotes(drawing, skipped), ...warnings] };
}
