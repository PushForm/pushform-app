// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Id, MaterialId } from '@pushform/core';
import type { CommonAttrs } from './common';
import type { NativeCatalogUnknownFields } from './document';

/**
 * Imported geometry kept as packed arrays rather than editable faces: what a large CAD import
 * holds until one of its parts is made editable. A mesh part is never a Body (it may be open or
 * self-touching); it is drawn, picked and placed whole, and shared by every placement of its
 * definition. The arrays are immutable: a change replaces the geometry object.
 */
export interface MeshPart extends CommonAttrs {
  nativeUnknownFields?: NativeCatalogUnknownFields;
  id: Id;
  name: string;
  /** The file format and originating system the part came from, for Entity Info and reports. */
  source: MeshPartSource;
  geometry: MeshPartGeometry;
  /** Material of the source faces that have no color of their own; null = the placement's, else the default. */
  materialId: MaterialId | null;
}

export interface MeshPartSource {
  /** Format name as the import report names it (`STEP`, `STL`, …). */
  format: string;
  /** Originating system the file names, or empty. */
  system: string;
}

/** Packed geometry in meters, Z up, in the part's definition coordinates. */
export interface MeshPartGeometry {
  /** xyz per vertex. */
  positions: Float64Array;
  /** Three vertex indices per triangle, counterclockwise seen from outside. */
  triangles: Uint32Array;
  /** The source face (0 … faceCount − 1) each triangle came from. */
  triangleFace: Uint32Array;
  faceCount: number;
  /** Per source face, its material id, or 0 for none (the part's material). */
  faceMaterials: Uint32Array;
  /** `edgeCount + 1` offsets into `edgePositions` (in points), each edge a polyline. */
  edgeOffsets: Uint32Array;
  /** xyz per edge point. */
  edgePositions: Float64Array;
  /** Per edge: bit 1 soft, bit 2 smooth. */
  edgeFlags: Uint8Array;
}

export const MESH_PART_EDGE_SOFT = 1;
export const MESH_PART_EDGE_SMOOTH = 2;

/** Input limits for mesh parts (MOD3810.01): one part, and all the parts of a document. */
export const MAX_MESH_PART_TRIANGLES = 16_777_216;
export const MAX_DOCUMENT_MESH_PART_TRIANGLES = 67_108_864;

export function meshPartTriangleCount(geometry: MeshPartGeometry): number { return geometry.triangles.length / 3; }
export function meshPartEdgeCount(geometry: MeshPartGeometry): number { return Math.max(0, geometry.edgeOffsets.length - 1); }

/**
 * Structural checks on packed geometry: array shapes agree, indices are in range, offsets ascend,
 * and every number is finite. Throws with the first problem.
 */
export function validateMeshPartGeometry(g: MeshPartGeometry): void {
  const fail = (message: string): never => { throw new Error(`Invalid mesh part geometry: ${message}.`); };
  if (!(g.positions instanceof Float64Array) || !(g.triangles instanceof Uint32Array) || !(g.triangleFace instanceof Uint32Array) ||
    !(g.faceMaterials instanceof Uint32Array) || !(g.edgeOffsets instanceof Uint32Array) || !(g.edgePositions instanceof Float64Array) ||
    !(g.edgeFlags instanceof Uint8Array)) fail('wrong array types');
  if (g.positions.length % 3 || g.triangles.length % 3 || g.edgePositions.length % 3) fail('array lengths are not multiples of 3');
  const vertices = g.positions.length / 3, triangles = g.triangles.length / 3;
  if (triangles > MAX_MESH_PART_TRIANGLES) fail(`more than ${MAX_MESH_PART_TRIANGLES} triangles`);
  if (g.triangleFace.length !== triangles) fail('one source face per triangle is required');
  if (!Number.isInteger(g.faceCount) || g.faceCount < 0 || g.faceMaterials.length !== g.faceCount) fail('face count does not match face materials');
  for (const index of g.triangles) if (index >= vertices) fail('triangle index out of range');
  for (const face of g.triangleFace) if (face >= g.faceCount) fail('source face out of range');
  for (const value of g.positions) if (!Number.isFinite(value)) fail('vertex position is not finite');
  for (const value of g.edgePositions) if (!Number.isFinite(value)) fail('edge point is not finite');
  const edges = g.edgeOffsets.length ? g.edgeOffsets.length - 1 : 0, points = g.edgePositions.length / 3;
  if (g.edgeFlags.length !== edges) fail('one flag per edge is required');
  if (edges && (g.edgeOffsets[0] !== 0 || g.edgeOffsets[edges] !== points)) fail('edge offsets must span the edge points');
  for (let e = 0; e < edges; e++) if (g.edgeOffsets[e + 1]! < g.edgeOffsets[e]! + 2) fail('an edge needs at least two points');
  if (!edges && points) fail('edge points without edges');
}

/** Local bounds of the geometry, or null when it has no vertices. */
export function meshPartBounds(g: MeshPartGeometry): Box3 | null {
  const p = g.positions;
  if (!p.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p[i + k]!;
    if (v < min[k]!) min[k] = v;
    if (v > max[k]!) max[k] = v;
  }
  return { min, max };
}
