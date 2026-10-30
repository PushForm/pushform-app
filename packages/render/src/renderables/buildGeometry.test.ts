// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, meshBox } from '@pushform/core';
import type { MeshData } from '@pushform/core';
import { EDGE_FLAG_BOUNDARY, EDGE_FLAG_HIDDEN, EDGE_FLAG_SMOOTH, EDGE_FLAG_SOFT } from '../types';
import type { RenderBodyEdge, RenderMaterial } from '../types';
import { MeshLambertMaterial, ShaderLib } from 'three';
import { patchSelectTint } from './BodyRenderable';
import { buildBodyEdgeSegments, buildFaceArrays, buildFaceGeometry, extractEdgeSegments, extractEdges, meshFaceNormals, transformedVerts, writeFaceUv } from './buildGeometry';

describe('buildGeometry', () => {
  it('builds unwelded geometry with faceId/flags attributes', () => {
    const mesh = meshBox([0, 0, 0], [1, 2, 3]);
    const g = buildFaceGeometry(mesh, M4_IDENTITY, [0, 0, 0]);
    expect(g.getAttribute('position').count).toBe(36);
    expect(g.getAttribute('normal').count).toBe(36);
    expect(g.getAttribute('faceId').count).toBe(36);
    expect(g.getAttribute('flags').count).toBe(36);
    // top face normal points +z
    const n = g.getAttribute('normal');
    expect(n.getZ(6)).toBeCloseTo(1);
  });

  it('extracts 12 merged edges from a box (no triangulation diagonals)', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const world = transformedVerts(mesh, M4_IDENTITY, [0, 0, 0]);
    const segs = extractEdges(mesh, world);
    expect(segs.length / 6).toBe(12);
    for (let i = 0; i < segs.length; i += 6) {
      const len = Math.hypot(segs[i + 3]! - segs[i]!, segs[i + 4]! - segs[i + 1]!, segs[i + 5]! - segs[i + 2]!);
      expect(len).toBeCloseTo(1);
    }
  });

  it('applies transform and floating origin', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] as unknown as typeof M4_IDENTITY;
    const world = transformedVerts(mesh, t, [10, 20, 0]);
    expect([world[0], world[1], world[2]]).toEqual([0, 0, 30]);
  });
});

describe('extractEdgeSegments', () => {
  it('carries unit normals of both adjacent faces and no boundary flag on a closed box', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const world = transformedVerts(mesh, M4_IDENTITY, [0, 0, 0]);
    const segs = extractEdgeSegments(mesh, world);
    const n = segs.positions.length / 6;
    expect(n).toBe(12);
    expect(segs.normalA.length).toBe(n * 3);
    expect(segs.normalB.length).toBe(n * 3);
    for (let i = 0; i < n; i++) {
      expect(segs.flags[i]).toBe(0);
      const a = [segs.normalA[i * 3]!, segs.normalA[i * 3 + 1]!, segs.normalA[i * 3 + 2]!];
      const b = [segs.normalB[i * 3]!, segs.normalB[i * 3 + 1]!, segs.normalB[i * 3 + 2]!];
      expect(Math.hypot(...a)).toBeCloseTo(1);
      expect(Math.hypot(...b)).toBeCloseTo(1);
      // box faces meet at right angles
      expect(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!).toBeCloseTo(0);
    }
  });

  it('flags open-boundary segments', () => {
    // a single quad (two triangles, one faceId) has 4 boundary edges and no interior diagonal
    const mesh = {
      verts: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      tris: new Uint32Array([0, 1, 2, 0, 2, 3]),
      faceId: new Uint32Array([0, 0]),
    };
    const segs = extractEdgeSegments(mesh, transformedVerts(mesh, M4_IDENTITY, [0, 0, 0]));
    expect(segs.positions.length / 6).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(segs.flags[i]).toBe(1);
      expect(segs.normalB[i * 3 + 2]).toBe(0);
      expect(segs.normalA[i * 3 + 2]).toBeCloseTo(1);
    }
  });
});

/** A closed cylinder: `segments` side quads (one faceId each), top = faceId `segments`, bottom = `segments + 1`. */
function meshCylinder(segments: number, radius = 1, height = 2): MeshData {
  const verts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    verts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    verts.push(Math.cos(a) * radius, Math.sin(a) * radius, height);
  }
  const cb = verts.length / 3;
  verts.push(0, 0, 0);
  const ct = verts.length / 3;
  verts.push(0, 0, height);
  const tris: number[] = [];
  const faceId: number[] = [];
  for (let i = 0; i < segments; i++) {
    const b0 = i * 2, t0 = i * 2 + 1, b1 = ((i + 1) % segments) * 2, t1 = ((i + 1) % segments) * 2 + 1;
    tris.push(b0, b1, t1, b0, t1, t0); // outward
    faceId.push(i, i);
    tris.push(ct, t0, t1); // top (+z)
    faceId.push(segments);
    tris.push(cb, b1, b0); // bottom (-z)
    faceId.push(segments + 1);
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(faceId) };
}

describe('buildFaceArrays smooth groups', () => {
  const mesh = meshCylinder(24);
  const sideIds = Array.from({ length: 24 }, (_, i) => i);

  it('keeps flat normals without groups', () => {
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0]);
    // the three vertices of each side triangle share the face normal
    const t = 0; // first side triangle (faceId 0)
    for (let k = 1; k < 3; k++) {
      expect(a.normals[t * 9 + k * 3]).toBeCloseTo(a.normals[t * 9]!);
      expect(a.normals[t * 9 + k * 3 + 1]).toBeCloseTo(a.normals[t * 9 + 1]!);
    }
  });

  it('averages side normals across the group (radial at each vertex) while top/bottom stay flat', () => {
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { smoothGroups: [{ faceIds: sideIds }] });
    const triCount = mesh.tris.length / 3;
    const seen = new Set<string>();
    for (let t = 0; t < triCount; t++) {
      const f = mesh.faceId[t]!;
      for (let k = 0; k < 3; k++) {
        const o = t * 9 + k * 3;
        const n = [a.normals[o]!, a.normals[o + 1]!, a.normals[o + 2]!];
        const p = [a.positions[o]!, a.positions[o + 1]!, a.positions[o + 2]!];
        if (f < 24) {
          // side: the normal is the unit radial direction of the vertex, no z component
          const r = Math.hypot(p[0]!, p[1]!);
          expect(n[2]).toBeCloseTo(0, 6);
          expect(n[0]).toBeCloseTo(p[0]! / r, 6);
          expect(n[1]).toBeCloseTo(p[1]! / r, 6);
          seen.add(((Math.round(Math.atan2(n[1]!, n[0]!) / (Math.PI / 12)) + 24) % 24).toString());
        } else {
          // caps: flat, including the rim vertices shared with the sides
          expect(Math.abs(n[2]!)).toBeCloseTo(1, 6);
          expect(n[2]! > 0).toBe(f === 24);
        }
      }
    }
    expect(seen.size).toBe(24); // normals vary smoothly around the side
  });

  it('weld is per group: vertices shared with a face outside the group keep its own normal', () => {
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { smoothGroups: [{ faceIds: [0, 1] }] });
    // face 2 is outside the group → flat, same as faces 0/1 at the shared ring vertex would differ
    const triOfFace2 = Array.from(mesh.faceId).indexOf(2);
    const o = triOfFace2 * 9;
    const n0 = [a.normals[o]!, a.normals[o + 1]!];
    const n1 = [a.normals[o + 3]!, a.normals[o + 4]!];
    expect(n0[0]).toBeCloseTo(n1[0]!);
    expect(n0[1]).toBeCloseTo(n1[1]!);
  });
});

describe('buildBodyEdgeSegments', () => {
  const mesh = meshBox([0, 0, 0], [1, 1, 1]);
  const world = transformedVerts(mesh, M4_IDENTITY, [0, 0, 0]);
  const normals = meshFaceNormals(mesh, world);
  const [fa, fb] = [...normals.keys()];
  const edges: RenderBodyEdge[] = [
    { points: [[0, 0, 0], [1, 0, 0]], soft: false, smooth: false, hidden: false, faceA: fa!, faceB: fb! },
    { points: [[0, 0, 0], [0.5, 0, 1], [1, 0, 1]], soft: true, smooth: true, hidden: false, faceA: fa!, faceB: fb! },
    { points: [[0, 1, 0], [1, 1, 0]], soft: false, smooth: false, hidden: true, faceA: fa!, faceB: fb! },
    { points: [[0, 0, 1], [0, 1, 1]], soft: false, smooth: false, hidden: false, faceA: fa!, faceB: 999 },
  ];

  it('draws only hard visible edges by default and carries both face normals', () => {
    const s = buildBodyEdgeSegments(edges, normals, M4_IDENTITY, [0, 0, 0]);
    expect(s.edges.positions.length / 6).toBe(2);
    expect(s.hiddenEdges.positions.length).toBe(0);
    const na = normals.get(fa!)!, nb = normals.get(fb!)!;
    expect([s.edges.normalA[0], s.edges.normalA[1], s.edges.normalA[2]]).toEqual([na[0], na[1], na[2]]);
    expect([s.edges.normalB[0], s.edges.normalB[1], s.edges.normalB[2]]).toEqual([nb[0], nb[1], nb[2]]);
    expect(s.edges.flags[0]).toBe(0);
    // unknown second face → boundary (always a profile)
    expect(s.edges.flags[1]! & EDGE_FLAG_BOUNDARY).toBe(EDGE_FLAG_BOUNDARY);
    expect(s.edges.normalB[3 + 2]).toBe(0);
  });

  it('routes soft/hidden edges to the dashed batch in hidden-geometry mode, one segment per polyline span', () => {
    const s = buildBodyEdgeSegments(edges, normals, M4_IDENTITY, [0, 0, 0], { showHidden: true });
    expect(s.edges.positions.length / 6).toBe(2);
    expect(s.hiddenEdges.positions.length / 6).toBe(3); // 2 spans of the soft polyline + 1 hidden
    expect(s.hiddenEdges.flags[0]! & EDGE_FLAG_SOFT).toBe(EDGE_FLAG_SOFT);
    expect(s.hiddenEdges.flags[0]! & EDGE_FLAG_SMOOTH).toBe(EDGE_FLAG_SMOOTH);
    expect(s.hiddenEdges.flags[2]! & EDGE_FLAG_HIDDEN).toBe(EDGE_FLAG_HIDDEN);
  });

  it('applies the body transform and the floating origin to the polyline points', () => {
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] as unknown as typeof M4_IDENTITY;
    const s = buildBodyEdgeSegments([edges[0]!], normals, t, [10, 0, 0]);
    expect(Array.from(s.edges.positions)).toEqual([0, 20, 30, 1, 20, 30]);
  });
});

describe('writeFaceUv', () => {
  const tex = { widthM: 2, heightM: 4 } as RenderMaterial;

  it('writes (s′, t′) and the divisor minus one for a projective placement, so (s′/q, t′/q) is exact per fragment', () => {
    const out = [0, 0], q = [9];
    writeFaceUv(out, 0, { kind: 'projective', matrix: [1, 0, 0, 0, 1, 0, 0.5, 0, 1] }, tex, 2, 1, q, 0);
    expect(out).toEqual([2, 1]);
    expect(q[0]).toBeCloseTo(1); // q = 0.5·2 + 1 = 2
    expect([out[0]! / (1 + q[0]!), out[1]! / (1 + q[0]!)]).toEqual([1, 0.5]);
    // Other placements divide by nothing: q − 1 = 0.
    writeFaceUv(out, 0, { kind: 'affine', matrix: [1, 0, 0, 0, 1, 0] }, tex, 2, 1, q, 0);
    expect(q[0]).toBe(0);
  });

  it('maps a sized placement to the texture frame, then divides by the size of the texture shown', () => {
    const out = [0, 0];
    writeFaceUv(out, 0, { kind: 'sized', matrix: [0, 1, 0, -1, 0, 0] }, tex, 2, 1);
    expect(out).toEqual([0.5, -0.5]);
  });

  it('carries the divisor as the uvq attribute, and the face shader divides the map coordinates by it', () => {
    const g = buildFaceGeometry(meshBox([0, 0, 0], [1, 1, 1]), M4_IDENTITY, [0, 0, 0]);
    expect(g.getAttribute('uvq').itemSize).toBe(1);
    const material = new MeshLambertMaterial();
    patchSelectTint(material);
    const shader = { uniforms: {}, vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain('vMapUv = ( mapTransform * vec3( MAP_UV, vPfUvQ ) ).xy;');
    expect(shader.fragmentShader).toContain('texture2D( map, vMapUv / vPfUvQ )');
  });
});
