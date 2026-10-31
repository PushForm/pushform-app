// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pushform/core';
import { meshPartFromGeometry, type MeshCounts, type MeshGeometry, type MeshPolygon } from './meshImport';

const counts = (): MeshCounts => ({ degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 });
const source = { format: 'OBJ', system: '' };
/** Two triangles sharing the edge (1,0,0)–(0,1,0), with optional vertex normals and smoothing masks. */
function pair(normals: [Vec3 | null, Vec3 | null], smoothing?: [number, number], material: [number | null, number | null] = [null, null]): MeshGeometry {
  const corner = (p: Vec3, n: Vec3 | null) => ({ position: p, normal: n, uv: null });
  const a: MeshPolygon = { material: material[0], corners: [corner([0, 0, 0], normals[0]), corner([1, 0, 0], normals[0]), corner([0, 1, 0], normals[0])], smoothing: smoothing?.[0] };
  const b: MeshPolygon = { material: material[1], corners: [corner([1, 0, 0], normals[1]), corner([1, 1, 1], normals[1]), corner([0, 1, 0], normals[1])], smoothing: smoothing?.[1] };
  return { polygons: [a, b], lines: [] };
}

describe('meshPartFromGeometry', () => {
  it('welds corners, fans polygons and keeps polygons apart as faces when nothing says they are smooth', () => {
    const part = meshPartFromGeometry(pair([null, null]), 'Pair', source, counts());
    expect(part.geometry.positions.length / 3).toBe(4);
    expect(part.geometry.triangles.length / 3).toBe(2);
    expect(part.geometry.faceCount).toBe(2);
    expect(Array.from(part.geometry.triangleFace)).toEqual([0, 1]);
    // Every polygon edge is a boundary: five distinct edges, the shared one once.
    expect(part.geometry.edgeOffsets.length - 1).toBe(5);
    expect(part.geometry.edgeFlags.length).toBe(5);
    expect(Array.from(part.faceMaterialKeys)).toEqual([-1, -1]);
  });

  it('joins polygons into one face across an edge whose vertex normals agree, or whose smoothing masks share a bit', () => {
    const n: Vec3 = [0, 0, 1];
    const smooth = meshPartFromGeometry(pair([n, n]), 'Pair', source, counts());
    expect(smooth.geometry.faceCount).toBe(1);
    expect(smooth.geometry.edgeOffsets.length - 1).toBe(4);
    expect(meshPartFromGeometry(pair([n, [0, 0, -1]]), 'Pair', source, counts()).geometry.faceCount).toBe(2);
    expect(meshPartFromGeometry(pair([null, null], [1, 3]), 'Pair', source, counts()).geometry.faceCount).toBe(1);
    expect(meshPartFromGeometry(pair([null, null], [1, 2]), 'Pair', source, counts()).geometry.faceCount).toBe(2);
    // Different materials never join, however smooth the edge.
    const colored = meshPartFromGeometry(pair([n, n], undefined, [3, 5]), 'Pair', source, counts());
    expect(colored.geometry.faceCount).toBe(2);
    expect(Array.from(colored.faceMaterialKeys)).toEqual([3, 5]);
  });

  it('turns a quad into two triangles of one face, keeps lines as edges, and counts collapsed polygons', () => {
    const c = (p: Vec3) => ({ position: p, normal: null, uv: null });
    const geometry: MeshGeometry = { polygons: [
      { material: null, corners: [c([0, 0, 0]), c([1, 0, 0]), c([1, 1, 0]), c([0, 1, 0])] },
      { material: null, corners: [c([5, 5, 5]), c([5, 5, 5]), c([5, 5, 5])] },
    ], lines: [[[0, 0, 2], [1, 0, 2]]] };
    const tally = counts(), part = meshPartFromGeometry(geometry, 'Quad', source, tally);
    expect(part.geometry.triangles.length / 3).toBe(2);
    expect(part.geometry.faceCount).toBe(1);
    expect(tally.degenerate).toBe(1);
    // The line first, then the quad's four outline edges; the diagonal inside the face is not an edge.
    expect(part.geometry.edgeOffsets.length - 1).toBe(5);
    expect(Array.from(part.geometry.edgePositions.subarray(0, 6))).toEqual([0, 0, 2, 1, 0, 2]);
  });
});
