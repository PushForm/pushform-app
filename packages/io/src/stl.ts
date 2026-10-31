// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import {
  finishMeshImport, groupedMeshModel, meshCountNotes, meshPointConverter,
  type MeshCounts, type MeshExtent, type MeshGeometry, type MeshImportOptions, type MeshPartOptions,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';

// STL import: binary and ASCII triangle meshes through the shared mesh conversion. STL records no
// unit, axis, material or color, so faces take the default material.

export const STL_FORMAT: ImportFormat = { kind: 'stl', name: 'STL', notes: [
  'STL import: triangles are joined into faces. STL records no units, materials or colors, so the faces use the default material.',
] };

export function isStlModelFile(name: string): boolean { return /\.stl$/i.test(name); }

/** A binary STL: an 80-byte header and a triangle count that accounts for the whole file, 50 bytes a triangle. */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return 84 + count * 50 === bytes.length;
}

/** An ASCII STL: `solid`, then a facet or the end of the solid. Binary headers often also begin with `solid`. */
function isAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /^\s*solid\b/i.test(head) && /\b(facet\s+normal|endsolid)\b/i.test(head);
}

/** Whether the bytes are an STL model, binary or ASCII. */
export function isStlBytes(bytes: Uint8Array): boolean { return isBinaryStl(bytes) || isAsciiStl(bytes); }

/** The solids of an STL file: their names and triangles, as corner positions in the file's own units. */
function stlSolids(bytes: Uint8Array): { solids: { name: string; triangles: Vec3[][] }[]; malformed: number } {
  if (isBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(80, true);
    const triangles: Vec3[][] = [];
    // Each triangle: a normal (unused: the winding says which way it faces), three corners, two attribute bytes.
    for (let i = 0, at = 84; i < count; i++, at += 50) {
      const corner = (k: number): Vec3 => [view.getFloat32(at + 12 + k * 12, true), view.getFloat32(at + 16 + k * 12, true), view.getFloat32(at + 20 + k * 12, true)];
      triangles.push([corner(0), corner(1), corner(2)]);
    }
    return { solids: [{ name: '', triangles }], malformed: 0 };
  }
  const solids: { name: string; triangles: Vec3[][] }[] = [];
  let current: { name: string; triangles: Vec3[][] } | null = null, corners: Vec3[] = [], malformed = 0;
  const text = new TextDecoder().decode(bytes);
  for (let at = 0; at < text.length;) {
    const end = text.indexOf('\n', at), line = text.slice(at, end < 0 ? text.length : end).trim();
    at = end < 0 ? text.length : end + 1;
    const [keyword = '', ...rest] = line.split(/\s+/), word = keyword.toLowerCase();
    if (word === 'solid') { current = { name: rest.join(' '), triangles: [] }; solids.push(current); }
    else if (word === 'endsolid') current = null;
    else if (word === 'outer') corners = [];
    // A missing coordinate reads as NaN, which skips its triangle.
    else if (word === 'vertex') corners.push([Number(rest[0]), Number(rest[1]), Number(rest[2])]);
    else if (word === 'endloop') {
      if (corners.length < 3 || corners.some(p => !p.every(Number.isFinite))) malformed++;
      else {
        if (!current) { current = { name: '', triangles: [] }; solids.push(current); }
        // A loop of more than three corners, which some writers emit, is kept as one polygon.
        current.triangles.push(corners);
      }
      corners = [];
    }
  }
  return { solids, malformed };
}

/** The extent of the file's triangles in its own units. */
export function stlExtent(bytes: Uint8Array): MeshExtent | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const solid of stlSolids(bytes).solids) for (const triangle of solid.triangles) for (const p of triangle) for (let k = 0; k < 3; k++) {
    if (Number.isFinite(p[k]!)) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
  }
  return min.every(Number.isFinite) ? { min, max } : null;
}

/** Read an STL model in the given unit and up axis. */
export async function readStl(bytes: Uint8Array, options: MeshImportOptions, onProgress?: (p: ImportProgress) => void, parts: MeshPartOptions = {}): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('STL files larger than 128 MiB are not supported yet.');
  if (!isStlBytes(bytes)) throw new Error('Not an STL model: neither a binary STL nor an ASCII STL solid.');
  onProgress?.({ stage: 'Reading STL model', current: 0, total: 1 });
  const warnings = new Set<string>(), warn = (message: string): void => { warnings.add(message); };
  const convert = meshPointConverter(options);
  const counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  const { solids, malformed } = stlSolids(bytes);
  const unreadable = solids.reduce((n, solid) => n + solid.triangles.filter(t => !t.every(p => p.every(Number.isFinite))).length, 0);
  const groups = solids.map((solid, i) => {
    onProgress?.({ stage: 'Reading STL model', current: i, total: solids.length });
    const geometry: MeshGeometry = { polygons: solid.triangles.filter(t => t.every(p => p.every(Number.isFinite)))
      .map(triangle => ({ material: null, corners: triangle.map(p => ({ position: convert.point(p), normal: null, uv: null })) })), lines: [] };
    // Several solids become groups named as the file names them; a file's only solid is the model itself.
    return { name: solids.length > 1 ? solid.name || `Solid ${i + 1}` : '', geometry };
  });
  if (malformed + unreadable) warn(`${malformed + unreadable} triangle${malformed + unreadable === 1 ? ' with invalid data is' : 's with invalid data are'} skipped.`);
  const { model, placements, meshParts } = groupedMeshModel(groups, [], 'STL', counts, onProgress, { source: { format: 'STL', system: '' }, ...parts });
  meshCountNotes(counts, warn);
  return finishMeshImport(model, placements, STL_FORMAT, warnings, onProgress, { meshParts });
}
