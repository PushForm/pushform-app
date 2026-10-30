// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, meshSignedVolume, type FaceLocalId, type Id, type TagId } from '@pushform/core';
import { createDocument } from '../Document';
import { bodyFromMesh, carryEdgeProps, deriveEdges, overlapRatio } from './BodyBuilder';
import { applyKernelResult, findBody } from './Reconcile';
import { computeRegions, RegionCache, regionAt } from './Regions';
import { createImprintGraph, type Body } from '../entities/body';
import { signedArea } from '@pushform/geom';
import { facePolygonUv } from './Regions';

const TAG = 1 as TagId;

function makeBox(min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [2, 1, 1]) {
  const doc = createDocument();
  const id = doc.transact('box', (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    return bodyFromMesh(d, meshBox(min, max), { container: root.entities }).id;
  }).value;
  return { doc, id, body: () => doc.rootDefinition.entities.bodies.get(id)! };
}

describe('bodyFromMesh', () => {
  it('box → 6 faces, 12 edges, 4-vertex loops, cached volume', () => {
    const { body } = makeBox();
    const b = body();
    expect(b.faces.size).toBe(6);
    expect(b.edges.size).toBe(12);
    expect(b.nextFaceId).toBe(6);
    for (const f of b.faces.values()) {
      expect(f.loops).toHaveLength(1);
      expect(f.loops[0]).toHaveLength(4);
      const uv = facePolygonUv(f);
      expect(signedArea(uv[0]!)).toBeGreaterThan(0); // CCW about the outward normal
      // basis is right-handed and anchored on the plane
      expect(f.basis.n).toEqual(f.plane.n);
    }
    const top = b.faces.get(1 as FaceLocalId)!;
    expect(top.plane.n).toEqual([0, 0, 1]);
    expect(signedArea(facePolygonUv(top)[0]!)).toBeCloseTo(2);
    expect(b.props.volume).toBeCloseTo(meshSignedVolume(b.mesh));
    expect(b.props.volume).toBeCloseTo(2);
    expect(b.props.area).toBeCloseTo(2 * (2 + 2 + 1));
    for (const e of b.edges.values()) {
      expect(e.polyline).toHaveLength(2);
      expect(e.faceA).toBeLessThan(e.faceB);
      expect(e.key).toBe(`${e.faceA}:${e.faceB}:0`);
    }
  });

  it('regroupFaces derives faceIds from coplanarity', () => {
    const doc = createDocument();
    const m = meshBox([0, 0, 0], [1, 1, 1]);
    const body = doc.transact('b', (d) => bodyFromMesh(d, { ...m, faceId: new Uint32Array(12) }, { regroupFaces: true })).value;
    expect(body.faces.size).toBe(6);
    expect(body.edges.size).toBe(12);
  });

  it('derived edges chain collinear triangle edges into one run', () => {
    // a box whose top face edge is split by an extra vertex (T-vertex welded in)
    const m = meshBox([0, 0, 0], [2, 1, 1]);
    const verts = new Float64Array([...m.verts, 1, 0, 1]); // vertex 8 on the top -y edge
    // split the top face (4,5,6,7) and the -y face (0,1,5,4) at vertex 8 so the mesh stays index-manifold
    const tris = Array.from(m.tris);
    tris.splice(12, 6, 0, 1, 8, 1, 5, 8, 0, 8, 4); // -y face: 3 triangles
    tris.splice(6, 6, 4, 8, 7, 8, 6, 7, 8, 5, 6); // top face: 3 triangles
    const faceId = new Uint32Array([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5]);
    const edges = deriveEdges({ verts, tris: Uint32Array.from(tris), faceId }, TAG);
    expect(edges.size).toBe(12);
    const topFront = edges.get('1:2:0')!;
    expect(topFront.polyline).toHaveLength(3);
  });
});

describe('carryEdgeProps', () => {
  it('keeps a soft flag across a mesh replacement when the edge shifted along its line', () => {
    const oldEdges = deriveEdges(meshBox([0, 0, 0], [2, 1, 1]), TAG);
    const key = '1:2:0' as const; // top/-y edge along x
    oldEdges.get(key)!.soft = true;
    oldEdges.get(key)!.smooth = true;
    const newEdges = deriveEdges(meshBox([0.5, 0, 0], [2.5, 1, 1]), TAG);
    const carried = carryEdgeProps(oldEdges, newEdges);
    expect(newEdges.get(key)!.soft).toBe(true);
    expect(newEdges.get(key)!.smooth).toBe(true);
    // edges along x shifted by 25% (4 of them) still match; the x=0 / x=2 edges moved off their lines
    expect(carried).toBe(4);
    expect(overlapRatio([[0, 0, 0], [2, 0, 0]], [[0.5, 0, 0], [2.5, 0, 0]], 1e-6)).toBeCloseTo(0.75);
    expect(overlapRatio([[0, 0, 0], [2, 0, 0]], [[1.5, 0, 0], [3, 0, 0]], 1e-6)).toBeCloseTo(0.25);
    expect(overlapRatio([[0, 0, 0], [2, 0, 0]], [[0, 1, 0], [2, 1, 0]], 1e-6)).toBe(0);
    const far = deriveEdges(meshBox([1.5, 0, 0], [3.5, 1, 1]), TAG);
    expect(carryEdgeProps(oldEdges, far)).toBe(0);
    expect(far.get(key)!.soft).toBe(false);
  });
});

describe('applyKernelResult', () => {
  it('keeps surviving face records, inherits material for new faces, rederives edges, bumps version', () => {
    const { doc, id } = makeBox();
    doc.transact('paint', (d) => {
      const b = findBody(d as never, id)!.body as Body;
      b.faces.get(1 as FaceLocalId)!.frontMaterialId = 42 as never;
      b.edges.get('0:2:0')!.soft = true; // bottom/-y edge: unchanged by pulling the top
      b.edges.get('1:2:0')!.soft = true; // top/-y edge: moves up with the top, not collinear any more
      b.imprints.set(0 as FaceLocalId, createImprintGraph());
      b.imprints.set(5 as FaceLocalId, createImprintGraph());
    });
    // "push/pull" the top up by 1 and split the +x face into a new face id 6
    const m = meshBox([0, 0, 0], [2, 1, 2]);
    const faceId = Uint32Array.from(m.faceId);
    faceId[6] = 6; // one triangle of the +x face (face 3) becomes a new face 6 — not coplanar-merged here
    const result = {
      mesh: { verts: m.verts, tris: m.tris, faceId },
      faceOrigin: new Map([[6 as FaceLocalId, [{ runId: 7, faceId: 1 as FaceLocalId }]]]),
      selfRunId: 7,
    };
    const before = doc.rootDefinition.entities.bodies.get(id)!;
    doc.transact('pushpull', (d) => applyKernelResult(d, id, result));
    const b = doc.rootDefinition.entities.bodies.get(id)!;
    expect(b.version).toBe(before.version + 1);
    expect(b.faces.size).toBe(7);
    expect(b.nextFaceId).toBe(7);
    expect(b.faces.get(1 as FaceLocalId)!.frontMaterialId).toBe(42);
    expect(b.faces.get(6 as FaceLocalId)!.frontMaterialId).toBe(42); // copied from origin face 1
    expect(b.faces.get(1 as FaceLocalId)!.plane.d).toBeCloseTo(-2); // geometry recomputed
    expect(b.edges.get('0:2:0')!.soft).toBe(true); // same line, carried
    expect(b.edges.get('1:2:0')!.soft).toBe(false); // moved off its line, not carried
    expect(b.props.volume).toBeCloseTo(4);
    expect(b.imprints.has(0 as FaceLocalId)).toBe(true);
    expect(b.mesh).toBe(result.mesh);
    // a face that vanished takes its imprints with it
    const m2 = meshBox([0, 0, 0], [1, 1, 1]);
    const fid2 = Uint32Array.from(m2.faceId).map((f) => (f === 5 ? 9 : f));
    doc.transact('again', (d) => applyKernelResult(d, id, { mesh: { ...m2, faceId: fid2 }, faceOrigin: new Map() }));
    const b2 = doc.rootDefinition.entities.bodies.get(id)!;
    expect(b2.imprints.has(5 as FaceLocalId)).toBe(false);
    expect(b2.faces.has(9 as FaceLocalId)).toBe(true);
    expect(b2.nextFaceId).toBe(10);
  });
});

describe('regions', () => {
  it('a face without imprints is one region; an imprinted rectangle splits into two', () => {
    const { doc, id, body } = makeBox();
    let regions = computeRegions(body(), 1 as FaceLocalId);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.wholeFace).toBe(true);
    expect(regions[0]!.area).toBeCloseTo(2);
    const cache = new RegionCache();
    expect(cache.get(body(), 1 as FaceLocalId)).toBe(cache.get(body(), 1 as FaceLocalId));
    // imprint a line across the top face (u along x from the basis origin at z=1)
    doc.transact('imprint', (d) => {
      const b = findBody(d as never, id)!.body as Body;
      const g = createImprintGraph();
      const top = b.faces.get(1 as FaceLocalId)!;
      const uvOf = (p: [number, number, number]): [number, number] => {
        const r: [number, number, number] = [p[0] - top.basis.origin[0], p[1] - top.basis.origin[1], p[2] - top.basis.origin[2]];
        const dot = (a: readonly number[], c: readonly number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
        return [dot(r, top.basis.u), dot(r, top.basis.v)];
      };
      g.vertices.set(1, uvOf([1, 0, 1]));
      g.vertices.set(2, uvOf([1, 1, 1]));
      g.edges.set(1, { id: 1, a: 1, b: 2, soft: false, smooth: false, hidden: false, curveId: null });
      g.nextId = 3;
      g.version = 1;
      b.imprints.set(1 as FaceLocalId, g);
    });
    regions = cache.get(body(), 1 as FaceLocalId);
    expect(regions).toHaveLength(2);
    for (const r of regions) {
      expect(r.area).toBeCloseTo(1);
      expect(r.outer.some((ref) => ref.kind === 'imprint' && ref.edgeId === 1)).toBe(true);
      expect(r.outer.filter((ref) => ref.kind === 'loop')).toHaveLength(3);
    }
    const uv = facePolygonUv(body().faces.get(1 as FaceLocalId)!)[0]!;
    const cx = uv.reduce((s, p) => s + p[0]!, 0) / 4, cy = uv.reduce((s, p) => s + p[1]!, 0) / 4;
    const left = regionAt(regions, [cx - 0.5, cy]), right = regionAt(regions, [cx + 0.5, cy]);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(0);
    expect(left).not.toBe(right);
    expect(regionAt(regions, [cx + 5, cy])).toBe(-1);
  });
});

describe('findBody', () => {
  it('locates bodies in any definition', () => {
    const { doc, id } = makeBox();
    expect(findBody(doc.state, id)?.definition.id).toBe(doc.state.rootDefinitionId);
    expect(findBody(doc.state, 9999 as Id)).toBeUndefined();
  });
});
