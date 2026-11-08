// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { LENGTH_TOL, meshBox, type FaceLocalId, type MeshData, type TagId } from '@pushform/core';
import { buildFaceLayer, buildFaceRecords, deriveEdges, type FaceLayerBuild } from './BodyBuilder';

const TAG = 1 as TagId;

const full = (m: MeshData, tag: TagId = TAG, weldTol = LENGTH_TOL): FaceLayerBuild => buildFaceLayer(m, tag, null, weldTol);

/** Asserts reuse from `prior` matches the full rebuild of `mesh` exactly: values, key order and next face id. */
function expectSame(mesh: MeshData, prior: FaceLayerBuild, tag: TagId = TAG): FaceLayerBuild {
  const incremental = buildFaceLayer(mesh, tag, prior.analysis);
  const fresh = full(mesh, tag);
  expect([...incremental.faces]).toStrictEqual([...fresh.faces]);
  expect([...incremental.edges]).toStrictEqual([...fresh.edges]);
  expect(incremental.nextFaceId).toBe(fresh.nextFaceId);
  return incremental;
}

/** A closed plate with `n` x `n` square studs on top, each a top face and four walls: a body with many independent faces. */
function studPlate(n: number): MeshData {
  const verts: number[] = [], tris: number[] = [], faceId: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], id: number): void => {
    const base = verts.length / 3;
    verts.push(...a, ...b, ...c, ...d);
    tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faceId.push(id, id);
  };
  const size = n * 2 + 1;
  // bottom, sides and top grid (with holes under the studs), as separate faces per quad to keep the mesh easy to read
  let next = 6;
  quad([0, 0, 0], [0, size, 0], [size, size, 0], [size, 0, 0], 0);
  quad([0, 0, 0], [size, 0, 0], [size, 0, 1], [0, 0, 1], 1);
  quad([size, 0, 0], [size, size, 0], [size, size, 1], [size, 0, 1], 2);
  quad([size, size, 0], [0, size, 0], [0, size, 1], [size, size, 1], 3);
  quad([0, size, 0], [0, 0, 0], [0, 0, 1], [0, size, 1], 4);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (x % 2 === 1 && y % 2 === 1) {
        const id = next;
        next += 5;
        quad([x, y, 2], [x + 1, y, 2], [x + 1, y + 1, 2], [x, y + 1, 2], id);
        quad([x, y, 1], [x + 1, y, 1], [x + 1, y, 2], [x, y, 2], id + 1);
        quad([x + 1, y, 1], [x + 1, y + 1, 1], [x + 1, y + 1, 2], [x + 1, y, 2], id + 2);
        quad([x + 1, y + 1, 1], [x, y + 1, 1], [x, y + 1, 2], [x + 1, y + 1, 2], id + 3);
        quad([x, y + 1, 1], [x, y, 1], [x, y, 2], [x, y + 1, 2], id + 4);
      } else {
        quad([x, y, 1], [x + 1, y, 1], [x + 1, y + 1, 1], [x, y + 1, 1], 5);
      }
    }
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(faceId) };
}

const movedVertex = (mesh: MeshData, index: number, delta: readonly [number, number, number]): MeshData => {
  const verts = new Float64Array(mesh.verts);
  verts[index * 3]! += delta[0];
  verts[index * 3 + 1]! += delta[1];
  verts[index * 3 + 2]! += delta[2];
  return { verts, tris: mesh.tris, faceId: mesh.faceId };
};

const withFaceId = (mesh: MeshData, tri: number, id: number): MeshData => {
  const faceId = new Uint32Array(mesh.faceId);
  faceId[tri] = id;
  return { verts: mesh.verts, tris: mesh.tris, faceId };
};

/** The mesh with triangles `i` and `j` swapped. */
const swappedTriangles = (mesh: MeshData, i: number, j: number): MeshData => {
  const tris = new Uint32Array(mesh.tris), faceId = new Uint32Array(mesh.faceId);
  for (let k = 0; k < 3; k++) {
    tris[i * 3 + k] = mesh.tris[j * 3 + k]!;
    tris[j * 3 + k] = mesh.tris[i * 3 + k]!;
  }
  faceId[i] = mesh.faceId[j]!;
  faceId[j] = mesh.faceId[i]!;
  return { verts: mesh.verts, tris, faceId };
};

const rng = (seed: number) => (): number => {
  seed = Math.imul(seed ^ 0x6d2b79f5, seed | 1);
  return ((seed ^ (seed >>> 7)) >>> 0) / 4294967296;
};

describe('buildFaceLayer reuse', () => {
  it('reuses every record when the mesh is the same', () => {
    const mesh = meshBox([0, 0, 0], [1, 2, 3]);
    const before = full(mesh);
    const after = expectSame(mesh, before);
    for (const [id, face] of after.faces) expect(face).toBe(before.faces.get(id));
    const polylines = new Set([...before.edges.values()].map((e) => e.polyline));
    for (const edge of after.edges.values()) expect(polylines.has(edge.polyline)).toBe(true);
  });

  it('equals the separate full builders', () => {
    const mesh = studPlate(2);
    const layer = full(mesh);
    expect([...layer.faces]).toStrictEqual([...buildFaceRecords(mesh, TAG).faces]);
    expect([...layer.edges]).toStrictEqual([...deriveEdges(mesh, TAG)]);
  });

  it('rebuilds only the faces a moved vertex touches', () => {
    const mesh = studPlate(3);
    const before = full(mesh);
    const moved = movedVertex(mesh, mesh.verts.length / 3 - 1, [0, 0, 0.25]);
    const after = expectSame(moved, before);
    let reused = 0;
    for (const [id, face] of after.faces) if (face === before.faces.get(id)) reused++;
    expect(reused).toBeGreaterThan(after.faces.size - 8);
    expect(reused).toBeLessThan(after.faces.size);
  });

  it('never reuses a record built under a different tag or tolerance', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const before = full(mesh);
    const retagged = buildFaceLayer(mesh, 2 as TagId, before.analysis);
    expect([...retagged.faces.values()].every((f) => f.tagId === (2 as TagId))).toBe(true);
    expect(retagged.faces.get(0 as FaceLocalId)).not.toBe(before.faces.get(0 as FaceLocalId));
    const retoleranced = buildFaceLayer(mesh, TAG, before.analysis, LENGTH_TOL * 10);
    expect(retoleranced.faces.get(0 as FaceLocalId)).not.toBe(before.faces.get(0 as FaceLocalId));
  });

  it('matches a full rebuild when triangles are reordered', () => {
    const mesh = studPlate(2);
    const before = full(mesh);
    expectSame(swappedTriangles(mesh, 0, mesh.faceId.length - 1), before);
    expectSame(swappedTriangles(mesh, 4, 5), before);
  });

  it('matches a full rebuild when a triangle changes face', () => {
    const mesh = studPlate(2);
    expectSame(withFaceId(mesh, 3, mesh.faceId[0]!), full(mesh));
    expectSame(withFaceId(mesh, 3, 999), full(mesh));
  });

  it('matches a full rebuild across signed zeros', () => {
    const verts = new Float64Array(meshBox([0, 0, 0], [1, 1, 1]).verts);
    const zero: MeshData = { ...meshBox([0, 0, 0], [1, 1, 1]), verts };
    const negated = new Float64Array(verts);
    for (let i = 0; i < negated.length; i++) if (negated[i] === 0) negated[i] = -0;
    expectSame({ ...zero, verts: negated }, full(zero));
    expectSame(zero, full({ ...zero, verts: negated }));
  });

  it('matches a full rebuild with welded and collapsed geometry', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    // a vertex within the weld tolerance of another: the two weld together and triangles can collapse
    const welded = movedVertex(mesh, 0, [LENGTH_TOL / 4, 0, 0]);
    const before = full(mesh);
    expectSame(welded, before);
    const collapsed = movedVertex(mesh, 1, [
      mesh.verts[0]! - mesh.verts[3]!,
      mesh.verts[1]! - mesh.verts[4]!,
      mesh.verts[2]! - mesh.verts[5]!,
    ]);
    expectSame(collapsed, before);
    expectSame(collapsed, full(collapsed));
  });

  it('rebuilds a face whose triangles are unchanged when a neighbour along a straight run changes', () => {
    // The top is split along one side into two triangle fans meeting at a mid-point vertex; the sides are two faces
    // meeting there, so the mid-point stays in the top's loop. Merging those two sides makes it redundant.
    const mesh: MeshData = {
      verts: new Float64Array([0, 0, 1, 1, 0, 1, 2, 0, 1, 2, 2, 1, 0, 2, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0]),
      tris: new Uint32Array([0, 1, 4, 1, 3, 4, 1, 2, 3, 0, 5, 1, 1, 5, 7, 1, 7, 2, 2, 7, 6]),
      faceId: new Uint32Array([0, 0, 0, 1, 1, 2, 2]),
    };
    const merged: MeshData = { ...mesh, faceId: new Uint32Array([0, 0, 0, 1, 1, 1, 1]) };
    const before = full(mesh);
    expect(before.faces.get(0 as FaceLocalId)!.loops[0]).toHaveLength(5);
    const after = expectSame(merged, before);
    expect(after.faces.get(0 as FaceLocalId)!.loops[0]).toHaveLength(4);
  });

  it('rebuilds a face when a weld moves the position a corner resolves to', () => {
    // Index 0 is a spare vertex: moving it next to a corner makes it that corner's welded representative, so the
    // boundary uses its position even though no triangle of any face changed.
    const box = meshBox([0, 0, 0], [1, 1, 1]);
    const withSpare = (x: number, y: number, z: number): MeshData => ({
      verts: new Float64Array([x, y, z, ...box.verts]),
      tris: new Uint32Array([...box.tris].map((v) => v + 1)),
      faceId: box.faceId,
    });
    const before = full(withSpare(5, 5, 5));
    const corner = [box.verts[0]!, box.verts[1]!, box.verts[2]!] as const;
    const after = expectSame(withSpare(corner[0] + LENGTH_TOL / 10, corner[1], corner[2]), before);
    const allPoints = [...after.faces.values()].flatMap((f) => f.loops.flat());
    expect(allPoints.some((p) => p[0] === corner[0] + LENGTH_TOL / 10 && p[1] === corner[1] && p[2] === corner[2])).toBe(true);
  });

  it('matches a full rebuild for randomized edits of a body', () => {
    const base = studPlate(2);
    const random = rng(1234);
    let current = base, prior = full(current);
    for (let round = 0; round < 80; round++) {
      let mesh: MeshData = current;
      const kind = Math.floor(random() * 4);
      if (kind === 0) mesh = movedVertex(mesh, Math.floor(random() * (mesh.verts.length / 3)), [random() * 0.5, random() * 0.5, random() * 0.5]);
      else if (kind === 1) mesh = swappedTriangles(mesh, Math.floor(random() * mesh.faceId.length), Math.floor(random() * mesh.faceId.length));
      else if (kind === 2) mesh = withFaceId(mesh, Math.floor(random() * mesh.faceId.length), Math.floor(random() * 40));
      prior = expectSame(mesh, prior);
      current = mesh;
    }
  });
});
