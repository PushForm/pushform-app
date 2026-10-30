// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, meshSignedVolume, type FaceLocalId, type MeshData, type Vec3 } from '@pushform/core';
import { createDocument } from '../Document';
import { bodyFromMesh } from './BodyBuilder';
import { foldAndTriangulate, movedPolyMesh, polyMeshFromBody, polyVertexAt, polyVerticesForRef, transformVertices } from './PolyMesh';
import type { Body } from '../entities/body';

function makeBox(min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]): Body {
  const doc = createDocument();
  const id = doc.transact('box', (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    return bodyFromMesh(d, meshBox(min, max), { container: root.entities }).id;
  }).value;
  return doc.rootDefinition.entities.bodies.get(id)!;
}

/** Closed and consistently oriented: every directed edge used once and matched by its reverse. */
function closedMeshProblems(mesh: MeshData): string[] {
  const problems: string[] = [];
  const directed = new Map<string, number>();
  const t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
    if (a === b || b === c || a === c) problems.push(`triangle ${i / 3} degenerate`);
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) directed.set(`${p}>${q}`, (directed.get(`${p}>${q}`) ?? 0) + 1);
  }
  for (const [key, n] of directed) {
    const [p, q] = key.split('>');
    if (n !== 1) problems.push(`${key} used ${n}x`);
    if (!directed.has(`${q}>${p}`)) problems.push(`${key} has no twin`);
  }
  return problems;
}

const faceCount = (mesh: MeshData): number => new Set(mesh.faceId).size;

describe('polyMeshFromBody', () => {
  it('welds a box into 8 vertices and 6 quads with outward normals', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    expect(poly.verts).toHaveLength(8);
    expect(poly.faces).toHaveLength(6);
    expect(poly.nextFaceId).toBe(6);
    for (const f of poly.faces) {
      expect(f.loops).toHaveLength(1);
      expect(f.loops[0]).toHaveLength(4);
    }
    const top = poly.faces.find((f) => f.faceId === (1 as FaceLocalId))!;
    expect(top.normal).toEqual([0, 0, 1]);
    for (const i of top.loops[0]!) expect(poly.verts[i]![2]).toBe(1);
  });

  it('round-trips an unmoved box through foldAndTriangulate', () => {
    const body = makeBox();
    const r = foldAndTriangulate(polyMeshFromBody(body));
    expect(closedMeshProblems(r.mesh)).toEqual([]);
    expect(r.mesh.tris.length / 3).toBe(12);
    expect(faceCount(r.mesh)).toBe(6);
    expect(meshSignedVolume(r.mesh)).toBeCloseTo(1, 9);
    expect(r.nextFaceId).toBe(6);
    expect([...r.faceOrigin.entries()]).toHaveLength(6);
  });
});

describe('polyVerticesForRef', () => {
  it('resolves vertices, edges and faces', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const v = polyVerticesForRef(body, poly, [1, 0, 1]);
    expect(v).toHaveLength(1);
    expect(poly.verts[v[0]!]).toEqual([1, 0, 1]);
    // Edge between the top (1) and the -y face (2): the top-front edge, two endpoints.
    const edgeKey = [...body.edges.keys()].find((k) => k.startsWith('1:2:'))!;
    const e = polyVerticesForRef(body, poly, { kind: 'edge', path: [], id: body.id, edgeKey });
    expect(e).toHaveLength(2);
    for (const i of e) {
      expect(poly.verts[i]![1]).toBe(0);
      expect(poly.verts[i]![2]).toBe(1);
    }
    const f = polyVerticesForRef(body, poly, { kind: 'face', path: [], id: body.id, faceId: 1 as FaceLocalId, region: null });
    expect(f).toHaveLength(4);
    expect(polyVertexAt(poly, [5, 5, 5])).toBe(-1);
  });
});

describe('foldAndTriangulate', () => {
  it('a uniformly raised top edge keeps every face planar (6 faces, volume 1.15)', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const edge = polyVerticesForRef(body, poly, { kind: 'edge', path: [], id: body.id, edgeKey: [...body.edges.keys()].find((k) => k.startsWith('1:2:'))! });
    const moved = new Map(edge.map((i) => [i, [poly.verts[i]![0], poly.verts[i]![1], poly.verts[i]![2] + 0.3] as Vec3]));
    const r = foldAndTriangulate(movedPolyMesh(poly, moved), { moved: moved.keys() });
    expect(closedMeshProblems(r.mesh)).toEqual([]);
    expect(faceCount(r.mesh)).toBe(6);
    expect(meshSignedVolume(r.mesh)).toBeCloseTo(1.15, 9);
  });

  it('a top edge raised unevenly folds the top into two pieces (7 faces, original id on the larger)', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const a = polyVertexAt(poly, [0, 0, 1]), b = polyVertexAt(poly, [1, 0, 1]);
    const moved = new Map<number, Vec3>([
      [a, [0, 0, 1.3]],
      [b, [1, 0, 1.15]],
    ]);
    const r = foldAndTriangulate(movedPolyMesh(poly, moved), { moved: [a, b] });
    expect(closedMeshProblems(r.mesh)).toEqual([]);
    expect(faceCount(r.mesh)).toBe(7);
    expect(r.nextFaceId).toBe(7);
    expect(r.faceOrigin.get(6 as FaceLocalId)).toBe(1);
    expect(r.faceOrigin.get(1 as FaceLocalId)).toBe(1);
    expect(meshSignedVolume(r.mesh)).toBeGreaterThan(1);
    // Both pieces tilt upward: outward normals keep a positive z.
    for (let t = 0; t < r.mesh.faceId.length; t++) {
      if (r.mesh.faceId[t] !== 1 && r.mesh.faceId[t] !== 6) continue;
      const [i, j, k] = [r.mesh.tris[t * 3]!, r.mesh.tris[t * 3 + 1]!, r.mesh.tris[t * 3 + 2]!];
      const p = (v: number): Vec3 => [r.mesh.verts[v * 3]!, r.mesh.verts[v * 3 + 1]!, r.mesh.verts[v * 3 + 2]!];
      const [p0, p1, p2] = [p(i), p(j), p(k)];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      expect(e1[0]! * e2[1]! - e1[1]! * e2[0]!).toBeGreaterThan(0);
    }
  });

  it('a vertex raised alone folds the top; the vertical faces it lies on stay planar (7 faces)', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const v = polyVertexAt(poly, [1, 0, 1]);
    const r = foldAndTriangulate(movedPolyMesh(poly, new Map([[v, [1, 0, 1.3] as Vec3]])), { moved: [v] });
    expect(closedMeshProblems(r.mesh)).toEqual([]);
    expect(faceCount(r.mesh)).toBe(7);
    expect(r.faceOrigin.get(6 as FaceLocalId)).toBe(1);
    expect(meshSignedVolume(r.mesh)).toBeGreaterThan(1);
  });

  it('merges vertices that land on each other: box -> wedge (5 faces, volume 0.5)', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const moved = new Map<number, Vec3>([
      [polyVertexAt(poly, [0, 0, 1]), [0, 1, 1]],
      [polyVertexAt(poly, [1, 0, 1]), [1, 1, 1]],
    ]);
    const r = foldAndTriangulate(movedPolyMesh(poly, moved), { moved: moved.keys() });
    expect(closedMeshProblems(r.mesh)).toEqual([]);
    expect(r.mesh.verts.length / 3).toBe(6);
    expect(faceCount(r.mesh)).toBe(5);
    expect([...new Set(r.mesh.faceId)].sort()).toEqual([0, 2, 3, 4, 5]);
    expect(meshSignedVolume(r.mesh)).toBeCloseTo(0.5, 9);
  });

  it('transformVertices applies a matrix to the chosen vertices only', () => {
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const top = polyVerticesForRef(body, poly, { kind: 'face', path: [], id: body.id, faceId: 1 as FaceLocalId, region: null });
    const lifted = transformVertices(poly, top, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]);
    for (const i of top) expect(lifted.verts[i]![2]).toBe(3);
    expect(lifted.verts.filter((p) => p[2] === 0)).toHaveLength(4);
    const r = foldAndTriangulate(lifted);
    expect(meshSignedVolume(r.mesh)).toBeCloseTo(3, 9);
    expect(faceCount(r.mesh)).toBe(6);
  });

  it('a vertex pushed through the opposite face still yields a mesh (the kernel rejects it)', () => {
    // The -y and +x faces turn into planar bow-ties; their earcut leaves open edges, which the
    // kernel's autofold reports as NotManifold. This layer never judges validity.
    const body = makeBox();
    const poly = polyMeshFromBody(body);
    const v = polyVertexAt(poly, [1, 0, 1]);
    const r = foldAndTriangulate(movedPolyMesh(poly, new Map([[v, [1, 0, -0.5] as Vec3]])), { moved: [v] });
    expect(r.mesh.tris.length).toBeGreaterThan(0);
    expect(faceCount(r.mesh)).toBe(7);
    expect(closedMeshProblems(r.mesh).length).toBeGreaterThan(0);
  });
});
