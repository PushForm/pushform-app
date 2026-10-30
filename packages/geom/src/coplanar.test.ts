// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type MeshData } from '@pushform/core';
import { facePlanesFromMesh, groupCoplanarFaces } from './coplanar';

describe('coplanar', () => {
  it('groups a box into 6 faces with outward planes', () => {
    const m = meshBox([0, 0, 0], [1, 2, 3]);
    const g = groupCoplanarFaces({ verts: m.verts, tris: m.tris, faceId: new Uint32Array(12) });
    expect(g.count).toBe(6);
    expect(Array.from(g.faceId)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(g.planes[1]!.n).toEqual([0, 0, 1]);
    expect(g.planes[1]!.d).toBeCloseTo(-3);
    const fp = facePlanesFromMesh(m);
    expect(fp.get(3)!.n[0]).toBeCloseTo(1);
    expect(fp.get(3)!.d).toBeCloseTo(-1);
  });
  it('keeps non-adjacent coplanar triangles as separate faces and welds duplicate vertices', () => {
    // two separate triangles in z=0 plus a copy of one sharing an edge via duplicated vertices
    const verts = new Float64Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // tri A
      5, 0, 0, 6, 0, 0, 5, 1, 0, // tri B (separate)
      1, 0, 0, 1, 1, 0, 0, 1, 0, // tri C adjacent to A along (1,0)-(0,1) with duplicated positions
    ]);
    const tris = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const mesh: MeshData = { verts, tris, faceId: new Uint32Array(3) };
    const g = groupCoplanarFaces(mesh);
    expect(g.count).toBe(2);
    expect(g.faceId[0]).toBe(g.faceId[2]);
    expect(g.faceId[1]).not.toBe(g.faceId[0]);
  });
});
