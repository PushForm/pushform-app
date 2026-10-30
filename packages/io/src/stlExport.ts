// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4determinant, m4identity, m4transformPoint, v3cross, v3len, v3scale, v3sub, type Id, type MMat4, type Vec3 } from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';
import { pathKey, sketchFaceLoops, tagVisible, walkInstances, type ComponentDefinition, type DocumentState, type EntityRef } from '@pushform/model';

// STL export: the visible model's faces as world-space triangles, in a chosen unit.

export const STL_EXTENSION = '.stl';
export type StlUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type StlFormat = 'binary' | 'ascii';
/** Units an STL can be written in, with how many of each make a meter. STL files carry no unit of their own. */
export const STL_UNITS: readonly { unit: StlUnit; label: string; perMeter: number }[] = [
  { unit: 'mm', label: 'Millimeters', perMeter: 1000 },
  { unit: 'cm', label: 'Centimeters', perMeter: 100 },
  { unit: 'm', label: 'Meters', perMeter: 1 },
  { unit: 'in', label: 'Inches', perMeter: 1 / 0.0254 },
  { unit: 'ft', label: 'Feet', perMeter: 1 / 0.3048 },
];

export interface StlExportOptions {
  unit: StlUnit;
  format: StlFormat;
  /** Export only these entities (and everything inside selected groups and components); null or absent exports the whole model. */
  selection?: readonly EntityRef[] | null | undefined;
  /** The model's name, written into the file's header. */
  name?: string | undefined;
}
export interface StlExport {
  bytes: Uint8Array;
  triangles: number;
  /** Notes for the person exporting, such as faces that are not part of a solid. */
  notes: string[];
}

/** The file name for a model's STL export: its name with `.stl` in place of `.pf`. */
export function stlFileName(name: string): string {
  return `${name.replace(/\.pf$/i, '') || 'Model'}${STL_EXTENSION}`;
}

/**
 * Write the visible model, or the selected part of it, as an STL file. Hidden entities and those on hidden tags are
 * left out with everything inside them; a solid keeps all of its faces, including hidden ones, so it stays closed.
 * Faces of solids face outward and sheet faces face their front side, also through mirrored placements.
 */
export function exportStl(state: DocumentState, options: StlExportOptions): StlExport {
  const scale = STL_UNITS.find(u => u.unit === options.unit)?.perMeter;
  if (scale === undefined) throw new Error(`Unknown STL unit: ${options.unit}`);
  const selected = options.selection ? selectionScope(options.selection) : null;
  const triangles: number[] = [];
  let sheets = 0;
  const emit = (a: Vec3, b: Vec3, c: Vec3, matrix: MMat4, mirrored: boolean): void => {
    const world = (point: Vec3): Vec3 => v3scale(m4transformPoint(matrix, point), scale);
    const p = world(a), q = world(b), r = world(c);
    if (mirrored) triangles.push(...p, ...r, ...q);
    else triangles.push(...p, ...q, ...r);
  };
  const exportContainer = (definition: ComponentDefinition, path: readonly Id[], matrix: MMat4, whole: boolean): void => {
    const mirrored = m4determinant(matrix) < 0, entities = definition.entities, key = pathKey(path);
    for (const body of entities.bodies.values()) {
      if (body.hidden || !tagVisible(state, body.tagId)) continue;
      const wholeBody = whole || !!selected?.bodies.has(`${key}|${body.id}`);
      const faces = wholeBody ? null : selected?.faces.get(`${key}|${body.id}`);
      if (!wholeBody && !faces) continue;
      const { verts, tris, faceId } = body.mesh;
      const at = (i: number): Vec3 => [verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!];
      for (let t = 0; t + 2 < tris.length; t += 3) {
        if (faces && !faces.has(faceId[t / 3]!)) continue;
        emit(at(tris[t]!), at(tris[t + 1]!), at(tris[t + 2]!), matrix, mirrored);
      }
    }
    for (const face of entities.sketch.faces.values()) {
      if (face.hidden || !tagVisible(state, face.tagId)) continue;
      if (!whole && !selected?.sketchFaces.has(`${key}|${face.id}`)) continue;
      const tri = triangulatePlanarFace(sketchFaceLoops(entities.sketch, face), face.basis);
      const at = (i: number): Vec3 => [tri.positions[i * 3]!, tri.positions[i * 3 + 1]!, tri.positions[i * 3 + 2]!];
      for (let t = 0; t + 2 < tri.indices.length; t += 3) emit(at(tri.indices[t]!), at(tri.indices[t + 1]!), at(tri.indices[t + 2]!), matrix, mirrored);
      sheets++;
    }
  };

  // A hidden placement hides everything inside it; a selected one exports everything inside it.
  const root = state.definitions.get(state.rootDefinitionId);
  if (!root) throw new Error('The model has no root definition.');
  exportContainer(root, [], m4identity(), selected === null);
  const hidden = new Set<string>(), wholeAt = new Map<string, boolean>([[pathKey([]), selected === null]]);
  for (const visit of walkInstances(state)) {
    const key = pathKey(visit.path), parent = pathKey(visit.path.slice(0, -1));
    if (hidden.has(parent) || visit.instance.hidden || !tagVisible(state, visit.instance.tagId)) { hidden.add(key); continue; }
    const whole = !!wholeAt.get(parent) || !!selected?.instances.has(key);
    wholeAt.set(key, whole);
    exportContainer(visit.definition, visit.path, visit.matrix, whole);
  }

  const count = triangles.length / 9;
  if (!count) throw new Error(selected ? 'The selection has no visible faces to export.' : 'The model has no visible faces to export.');
  const name = (options.name ?? 'Model').replace(/[^\x20-\x7e]/g, '_').trim() || 'Model';
  const notes: string[] = [];
  if (sheets) notes.push(`${sheets} face${sheets === 1 ? ' is' : 's are'} not part of a solid; 3D printers usually need closed solids.`);
  return { bytes: options.format === 'ascii' ? asciiStl(triangles, name) : binaryStl(triangles, name), triangles: count, notes };
}

/** Selected entities by container path key: whole placements, bodies, body faces, and sheet faces. */
function selectionScope(refs: readonly EntityRef[]) {
  const scope = { instances: new Set<string>(), bodies: new Set<string>(), faces: new Map<string, Set<number>>(), sketchFaces: new Set<string>() };
  for (const ref of refs) {
    const key = pathKey(ref.path);
    if (ref.kind === 'instance') scope.instances.add(pathKey([...ref.path, ref.id]));
    else if (ref.kind === 'body') scope.bodies.add(`${key}|${ref.id}`);
    else if (ref.kind === 'face') {
      const faces = scope.faces.get(`${key}|${ref.id}`) ?? scope.faces.set(`${key}|${ref.id}`, new Set()).get(`${key}|${ref.id}`)!;
      faces.add(ref.faceId);
    } else if (ref.kind === 'sketchFace') scope.sketchFaces.add(`${key}|${ref.id}`);
  }
  return scope;
}

/** The facet normal: unit length by the right-hand rule, or zero for a triangle without area. */
function facetNormal(t: readonly number[], i: number): Vec3 {
  const a: Vec3 = [t[i]!, t[i + 1]!, t[i + 2]!], b: Vec3 = [t[i + 3]!, t[i + 4]!, t[i + 5]!], c: Vec3 = [t[i + 6]!, t[i + 7]!, t[i + 8]!];
  const n = v3cross(v3sub(b, a), v3sub(c, a)), length = v3len(n);
  return length > 0 ? v3scale(n, 1 / length) : [0, 0, 0];
}

/**
 * Binary STL: an 80-byte header, the triangle count, then per triangle its normal and three corners as 32-bit
 * floats (the format's own precision) and a zero attribute word. The header never starts with "solid", which
 * readers take as the mark of an ASCII file.
 */
function binaryStl(triangles: readonly number[], name: string): Uint8Array {
  const count = triangles.length / 9, bytes = new Uint8Array(84 + count * 50), view = new DataView(bytes.buffer);
  const header = `PushForm STL: ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const at = 84 + t * 50, n = facetNormal(triangles, t * 9);
    for (let k = 0; k < 3; k++) view.setFloat32(at + k * 4, n[k]!, true);
    for (let k = 0; k < 9; k++) view.setFloat32(at + 12 + k * 4, triangles[t * 9 + k]!, true);
  }
  return bytes;
}

/** ASCII STL with nine significant digits per coordinate. */
function asciiStl(triangles: readonly number[], name: string): Uint8Array {
  const f = (v: number): string => (Object.is(v, -0) ? 0 : v).toExponential(8);
  const lines = [`solid ${name}`];
  for (let i = 0; i < triangles.length; i += 9) {
    const n = facetNormal(triangles, i);
    lines.push(`  facet normal ${n.map(f).join(' ')}`, '    outer loop');
    for (let k = 0; k < 9; k += 3) lines.push(`      vertex ${f(triangles[i + k]!)} ${f(triangles[i + k + 1]!)} ${f(triangles[i + k + 2]!)}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return new TextEncoder().encode(lines.join('\n'));
}
