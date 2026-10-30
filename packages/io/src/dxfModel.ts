// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL, RATIO_TOL, basisToLocal, planeBasis, v3cross, v3dot, v3len, v3normalize, type Mat4, type Vec3 } from '@pushform/core';
import { tessellateCurve } from '@pushform/geom';
import type { Definition, SkpModel } from 'openskp';
import { arcPoint, curveEnds, dxfNotes, parseDxf, resolveColor, type DxfCurve, type DxfDrawing, type DxfItem } from './dxf';
import {
  INCH, MESH_UNITS, buildMeshGeometry, finishMeshImport, meshCountNotes, meshDefinition,
  type MeshCounts, type MeshGeometry, type MeshImportOptions, type MeshLineMeta,
} from './meshImport';
import type { ImportFormat, ImportProgress, SketchUpImport } from './sketchup';

// DXF model import: model space and its blocks through the shared mesh conversion, with arcs and
// circles kept as curves and layers as tags.

export const DXF_FORMAT: ImportFormat = { kind: 'dxf', name: 'DXF', notes: [
  'DXF import: lines, polylines, arcs, circles, ellipses, splines, 3D faces, 2D solids, polyface and polygon meshes, blocks and layers are imported. Text, dimensions, hatches, points, images, ACIS solids and paper space layouts are not.',
] };

/** Segments of a full circle. */
const CIRCLE_SEGMENTS = 24;
const RELEASES: Record<string, string> = { AC1006: 'R10', AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004',
  AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };

/** The AutoCAD release that wrote the file, for the import report's source version. */
export function dxfVersion(drawing: DxfDrawing): string {
  if (!drawing.version) return 'DXF';
  const release = RELEASES[drawing.version];
  return release ? `AutoCAD ${release} DXF (${drawing.version})` : `DXF (${drawing.version})`;
}

/** A reader curve record, as PushForm's patched reader gives them, in inches. */
interface ReaderCurve {
  id: number; edges: number; polygon: boolean;
  arc: { center: Vec3; normal: Vec3; xaxis: Vec3; yaxis: Vec3; startAngle: number; endAngle: number } | null;
}

/** Whether an elliptical arc is circular: perpendicular axes of one length. */
function circular(curve: Extract<DxfCurve, { kind: 'arc' }>): boolean {
  const a = v3len(curve.u), b = v3len(curve.v);
  return a > 0 && Math.abs(a - b) <= RATIO_TOL * a && Math.abs(v3dot(curve.u, curve.v)) <= RATIO_TOL * a * b;
}

/** Segments for an arc of this radius and sweep: 24 per turn, fewer where segments would be shorter than the merge tolerance. */
function arcSegments(radius: number, sweep: number, full: boolean): number {
  let n = Math.max(full ? 3 : 1, Math.ceil(CIRCLE_SEGMENTS * sweep / (2 * Math.PI) - RATIO_TOL));
  while (n > (full ? 3 : 1) && 2 * radius * Math.sin(sweep / (2 * n)) < 2 * MERGE_TOL) n--;
  return 2 * radius * Math.sin(sweep / (2 * n)) < 2 * MERGE_TOL ? 0 : n;
}

/** The geometry of one definition: lines with their curve and layer, faces, and its curve records. */
class DefinitionGeometry {
  readonly geometry: MeshGeometry = { polygons: [], lines: [], lineMeta: [] };
  readonly curves: ReaderCurve[] = [];
  constructor(private readonly meters: number, private readonly tagOf: (layer: string) => string) {}

  private line(a: Vec3, b: Vec3, meta: MeshLineMeta): void {
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return;
    this.geometry.lines.push([a, b]); this.geometry.lineMeta!.push(meta);
  }
  private chain(points: Vec3[], meta: MeshLineMeta): void {
    for (let i = 0; i + 1 < points.length; i++) this.line(points[i]!, points[i + 1]!, meta);
  }
  private m(p: Vec3): Vec3 { return [p[0] * this.meters, p[1] * this.meters, p[2] * this.meters]; }

  curve(curve: DxfCurve, layer: string): void {
    const tag = this.tagOf(layer), meta: MeshLineMeta = tag ? { layer: tag } : {};
    if (curve.kind === 'line') { this.line(this.m(curve.a), this.m(curve.b), meta); return; }
    if (curve.kind === 'arc' && circular(curve)) {
      const center = this.m(curve.center), radius = v3len(curve.u) * this.meters, sweep = curve.end - curve.start;
      const full = sweep >= 2 * Math.PI - RATIO_TOL, normal = v3normalize(v3cross(curve.u, curve.v));
      const segments = arcSegments(radius, sweep, full);
      if (!segments) return;
      const startPoint = this.m(curveEnds(curve)[0]);
      // Points where PushForm's own tessellation of this arc puts them, so the curve keeps its arc geometry.
      const basis = planeBasis(center, normal), local = basisToLocal(basis, startPoint), startAngle = Math.atan2(local[1], local[0]);
      const points: Vec3[] = tessellateCurve({ kind: full ? 'circle' : 'arc', center, normal, radius, startAngle, endAngle: startAngle + (full ? 2 * Math.PI : sweep), segments });
      if (full) points.push(points[0]!);
      const id = this.curves.length + 1, inches = (v: Vec3): Vec3 => [v[0] / INCH, v[1] / INCH, v[2] / INCH];
      this.curves.push({ id, edges: segments, polygon: false, arc: { center: inches(center), normal, xaxis: inches(basis.u.map(c => c * radius) as unknown as Vec3),
        yaxis: inches(basis.v.map(c => c * radius) as unknown as Vec3), startAngle, endAngle: startAngle + (full ? 2 * Math.PI : sweep) } });
      this.chain(points, { ...meta, curve: id });
      return;
    }
    // Ellipses and splines are sampled into freehand curves.
    let points: Vec3[];
    if (curve.kind === 'arc') {
      const sweep = curve.end - curve.start, n = Math.max(2, Math.ceil(CIRCLE_SEGMENTS * 2 * sweep / (2 * Math.PI)));
      points = Array.from({ length: n + 1 }, (_, i) => {
        const t = curve.start + sweep * i / n;
        return this.m(arcPoint(curve, t));
      });
    } else points = curve.points.map(p => this.m(p));
    const distinct = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1], p[2] - points[i - 1]![2]) > MERGE_TOL);
    if (distinct.length < 2) return;
    const id = this.curves.length + 1;
    this.curves.push({ id, edges: distinct.length - 1, polygon: false, arc: null });
    this.chain(distinct, { ...meta, curve: id });
  }

  face(corners: Vec3[]): void {
    if (corners.length >= 3) this.geometry.polygons.push({ corners: corners.map(p => ({ position: this.m(p), normal: null, uv: null })), material: null });
  }
}

/** Placement of a block as the reader's column-major values, with translation in inches. */
function placement(transform: Mat4, meters: number): number[] {
  const out = [...transform];
  out[12] = out[12]! * meters / INCH; out[13] = out[13]! * meters / INCH; out[14] = out[14]! * meters / INCH;
  return out;
}

/**
 * Read a DXF file's model space as a model. A drawing without units is read in `options.unit`, or millimeters.
 */
export async function readDxf(bytes: Uint8Array, options?: MeshImportOptions, onProgress?: (p: ImportProgress) => void): Promise<SketchUpImport> {
  onProgress?.({ stage: 'Reading DXF drawing', current: 0, total: 1 });
  const drawing = parseDxf(bytes);
  const meters = drawing.units?.meters ?? MESH_UNITS.find(u => u.unit === (options?.unit ?? 'mm'))!.meters;
  const warnings = new Set<string>(), skipped = new Map<string, number>(), counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  const skip = (type: string): void => { skipped.set(type, (skipped.get(type) ?? 0) + 1); };
  const usedTags = new Set<string>();
  // Layer 0 is Untagged; anything else becomes a tag of that name.
  const tagOf = (layer: string): string => { if (layer === '0') return ''; usedTags.add(layer); return layer; };

  const definitions = new Map<number, Definition>(), keys = new Map<string, number | null>();
  let cycles = 0;
  const build = (def: Definition, items: DxfItem[], path: Set<string>): boolean => {
    const geometry = new DefinitionGeometry(meters, tagOf);
    for (const item of items) {
      if (item.kind === 'path') for (const curve of item.curves) geometry.curve(curve, item.layer);
      else if (item.kind === 'face') geometry.face(item.corners);
      else if (item.kind === 'fill') skip('HATCH');
      else if (item.kind === 'text') skip(item.source);
      else if (item.source === 'DIMENSION') skip('DIMENSION');
      else {
        const key = definitionFor(item.block, path);
        if (key === undefined) { cycles++; continue; }
        if (key === null) continue;
        def.instances.push({ name: '', refIdx: key, guid: '', matrix: placement(item.transform, meters), materialId: null, hidden: false,
          layer: tagOf(item.layer), properties: {} });
      }
    }
    buildMeshGeometry(def, geometry.geometry, counts, () => false, new Map(), { paintBacks: true });
    (def as Definition & { curves?: ReaderCurve[] }).curves = geometry.curves;
    return def.faces.length > 0 || def.edges.length > 0 || def.instances.length > 0;
  };
  /** The definition of a block, built once; null when the block holds nothing imported, undefined when it contains itself. */
  const definitionFor = (name: string, path: Set<string>): number | null | undefined => {
    if (path.has(name)) return undefined;
    if (keys.has(name)) return keys.get(name)!;
    const block = drawing.blocks.get(name);
    if (!block || block.xref) { keys.set(name, null); return null; }
    const key = definitions.size, def = meshDefinition(key, name.replace(/^\*/, ''), false);
    const filled = build(def, block.items, new Set([...path, name]));
    keys.set(name, filled ? key : null);
    if (filled) definitions.set(key, def);
    return filled ? key : null;
  };
  const root = meshDefinition(-1, '', false);
  build(root, drawing.items, new Set());
  onProgress?.({ stage: 'Reading DXF drawing', current: 1, total: 1 });

  for (const note of dxfNotes(drawing, skipped)) warnings.add(note);
  if (cycles) warnings.add(`${cycles} block insert${cycles === 1 ? ' that places its own block is' : 's that place their own blocks are'} not imported.`);
  if (!drawing.units) warnings.add(`The drawing does not record its units; it is read in ${MESH_UNITS.find(u => u.meters === meters)?.label.toLowerCase() ?? 'millimeters'}.`);
  meshCountNotes(counts, message => warnings.add(message));
  const layers = [...usedTags].map(name => {
    const layer = drawing.layers.get(name), [r, g, b] = resolveColor(layer?.color ?? { aci: 7 }, layer, null);
    return { name, color: { r, g, b }, hidden: !(layer?.visible ?? true) };
  });
  const model = { version: dxfVersion(drawing), definitions, root, layers, pages: [], scenesUnread: 0, dimensions: [], materials: [],
    materialsById: new Map(), styles: [], units: null, unitsOptions: null, sectionDisplay: null } as unknown as SkpModel;
  return finishMeshImport(model, new Map(), DXF_FORMAT, warnings, onProgress);
}
