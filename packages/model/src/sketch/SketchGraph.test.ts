// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, MaterialId, PlaneBasis, Vec3 } from '@pushform/core';
import { basisToLocal, planeBasis } from '@pushform/core';
import { createDocument, type Document } from '../Document';
import { UndoStack } from '../UndoStack';
import type { UvMapping } from '../entities/attrs';
import { uvApply, uvRebaseSides, uvToAffine } from '../uv';
import { SketchGraph } from './SketchGraph';
import { reverseLoop, sketchFaceLoops, sketchFacePolygonUv } from './sketchFace';
import { polygonArea, signedArea } from '@pushform/geom';

function sketchOf(doc: Document) {
  return doc.rootDefinition.entities.sketch;
}
function draw(doc: Document, lines: [Vec3, Vec3][]): Id[][] {
  return doc.transact('draw', (d) => {
    const g = SketchGraph.for(d);
    return lines.map(([a, b]) => g.addEdge(a, b));
  }).value;
}
const rect: [Vec3, Vec3][] = [
  [[0, 0, 0], [4, 0, 0]],
  [[4, 0, 0], [4, 2, 0]],
  [[4, 2, 0], [0, 2, 0]],
  [[0, 2, 0], [0, 0, 0]],
];

describe('FaceFinder texture placements', () => {
  const st = (basis: PlaneBasis, uv: UvMapping, p: Vec3): number[] => {
    const l = basisToLocal(basis, p);
    return [...uvApply(uvToAffine(uv, 1, 1), l[0], l[1])];
  };
  const pinned: UvMapping = { kind: 'affine', matrix: [1, 0.5, 0.3, -0.2, 2, 0.1] };
  const pinnedBack: UvMapping = { kind: 'affine', matrix: [-1, 0, 0.7, 0, 3, 0] };

  it("keeps each side's texture coordinates when a line splits a face with its own basis", () => {
    const doc = createDocument();
    draw(doc, rect);
    // An imported face facing up, with its basis at another point of the plane.
    const front = 7 as MaterialId, back = 8 as MaterialId, basis = planeBasis([1, 1, 0], [0, 0, 1]);
    doc.transact('face up', (d) => {
      const f = [...d.definitions.get(d.rootDefinitionId)!.entities.sketch.faces.values()][0]!;
      Object.assign(f, { plane: { n: [0, 0, 1], d: 0 }, basis, loops: f.loops.map((l) => reverseLoop(l)), frontMaterialId: front, backMaterialId: back, uv: pinned, uvBack: pinnedBack });
    });
    draw(doc, [[[2, 0, 0], [2, 2, 0]]]);
    const sk = sketchOf(doc);
    expect(sk.faces.size).toBe(2);
    // The piece that takes over the face's attributes (the other piece starts unpainted).
    const pieces = [...sk.faces.values()].filter((f) => f.frontMaterialId === front);
    expect(pieces).toHaveLength(1);
    for (const f of pieces) {
      expect(f.plane.n[2]).toBeCloseTo(1);
      for (const p of sketchFaceLoops(sk, f).flat()) {
        st(f.basis, f.uv, p).forEach((x, i) => expect(x).toBeCloseTo(st(basis, pinned, p)[i]!, 9));
        st(f.basis, f.uvBack ?? f.uv, p).forEach((x, i) => expect(x).toBeCloseTo(st(basis, pinnedBack, p)[i]!, 9));
      }
    }
  });

  it('swaps and re-expresses the sides of a template facing the other way', () => {
    // What createFace does for a flipped template: the new front is the old back, in the new basis.
    const up = planeBasis([0, 0, 0], [0, 0, 1]), down = planeBasis([0, 0, 0], [0, 0, -1]);
    const r = uvRebaseSides({ uv: pinnedBack, uvBack: pinned }, up, down, null, null);
    for (const p of [[0, 0, 0], [3, 1, 0], [-2, 5, 0]] as Vec3[]) {
      st(down, r.uv, p).forEach((x, i) => expect(x).toBeCloseTo(st(up, pinnedBack, p)[i]!, 9));
      st(down, r.uvBack!, p).forEach((x, i) => expect(x).toBeCloseTo(st(up, pinned, p)[i]!, 9));
    }
  });
});

describe('SketchGraph + FaceFinder', () => {
  it('four lines forming a rectangle → 1 face, 4 edges, 4 vertices', () => {
    const doc = createDocument();
    draw(doc, rect.slice(0, 3));
    expect(sketchOf(doc).faces.size).toBe(0);
    draw(doc, rect.slice(3));
    const sk = sketchOf(doc);
    expect(sk.vertices.size).toBe(4);
    expect(sk.edges.size).toBe(4);
    expect(sk.faces.size).toBe(1);
    const face = [...sk.faces.values()][0]!;
    expect(face.loops).toHaveLength(1);
    expect(face.loops[0]).toHaveLength(4);
    expect(face.plane.n[2]).toBeCloseTo(-1); // ground faces point down
    const uv = sketchFacePolygonUv(sk, face);
    expect(signedArea(uv[0]!)).toBeCloseTo(8);
    expect(sketchFaceLoops(sk, face)[0]).toHaveLength(4);
    expect(sk.vertexHash.size).toBe(4);
  });

  it('merges endpoints within MERGE_TOL', () => {
    const doc = createDocument();
    draw(doc, [
      [[0, 0, 0], [1, 0, 0]],
      [[1, 1e-6, 0], [1, 1, 0]],
    ]);
    expect(sketchOf(doc).vertices.size).toBe(3);
  });

  it('a diagonal splits the rectangle into 2 faces', () => {
    const doc = createDocument();
    draw(doc, rect);
    draw(doc, [[[0, 0, 0], [4, 2, 0]]]);
    const sk = sketchOf(doc);
    expect(sk.edges.size).toBe(5);
    expect(sk.faces.size).toBe(2);
    for (const f of sk.faces.values()) {
      expect(f.loops[0]).toHaveLength(3);
      expect(polygonArea(sketchFacePolygonUv(sk, f))).toBeCloseTo(4);
    }
  });

  it('a line crossing an edge splits it in two (and itself at the crossing)', () => {
    const doc = createDocument();
    draw(doc, [[[0, 0, 0], [4, 0, 0]]]);
    const ids = draw(doc, [[[2, -1, 0], [2, 1, 0]]])[0]!;
    const sk = sketchOf(doc);
    expect(ids).toHaveLength(2);
    expect(sk.edges.size).toBe(4);
    expect(sk.vertices.size).toBe(5);
    // T-junction: a line ending on an edge splits it too
    draw(doc, [[[1, 0, 0], [1, 1, 0]]]);
    expect(sketchOf(doc).edges.size).toBe(6);
    // crossing through a rectangle face keeps the face valid (loops updated by the split)
    const doc2 = createDocument();
    draw(doc2, rect);
    draw(doc2, [[[2, -1, 0], [2, 3, 0]]]);
    const sk2 = sketchOf(doc2);
    expect(sk2.faces.size).toBe(2);
    expect(sk2.edges.size).toBe(9);
    for (const f of sk2.faces.values()) expect(polygonArea(sketchFacePolygonUv(sk2, f))).toBeCloseTo(4);
  });

  it('a small square inside the rectangle face adds a hole and an inner face', () => {
    const doc = createDocument();
    draw(doc, rect);
    const outerId = [...sketchOf(doc).faces.keys()][0]!;
    draw(doc, [
      [[1, 0.5, 0], [2, 0.5, 0]],
      [[2, 0.5, 0], [2, 1.5, 0]],
      [[2, 1.5, 0], [1, 1.5, 0]],
      [[1, 1.5, 0], [1, 0.5, 0]],
    ]);
    const sk = sketchOf(doc);
    expect(sk.faces.size).toBe(2);
    const outer = sk.faces.get(outerId)!;
    expect(outer).toBeDefined();
    expect(outer.loops).toHaveLength(2);
    expect(outer.loops[1]).toHaveLength(4);
    const uv = sketchFacePolygonUv(sk, outer);
    expect(signedArea(uv[0]!)).toBeCloseTo(8);
    expect(signedArea(uv[1]!)).toBeCloseTo(-1);
    const inner = [...sk.faces.values()].find((f) => f.id !== outerId)!;
    expect(inner.loops).toHaveLength(1);
    expect(polygonArea(sketchFacePolygonUv(sk, inner))).toBeCloseTo(1);
  });

  it('removing the diagonal heals the two triangles into one face; removing a side deletes it', () => {
    const doc = createDocument();
    draw(doc, rect);
    const diag = draw(doc, [[[0, 0, 0], [4, 2, 0]]])[0]![0]!;
    expect(sketchOf(doc).faces.size).toBe(2);
    doc.transact('erase', (d) => SketchGraph.for(d).removeEdge(diag));
    const sk = sketchOf(doc);
    expect(sk.edges.size).toBe(4);
    expect(sk.faces.size).toBe(1);
    expect(polygonArea(sketchFacePolygonUv(sk, [...sk.faces.values()][0]!))).toBeCloseTo(8);
    const side = [...sk.edges.keys()][0]!;
    doc.transact('erase', (d) => SketchGraph.for(d).removeEdge(side));
    expect(sketchOf(doc).faces.size).toBe(0);
    expect(sketchOf(doc).edges.size).toBe(3);
    expect(sketchOf(doc).vertices.size).toBe(4);
  });

  it('removeFace keeps edges; removing an inner hole edge heals the outer face', () => {
    const doc = createDocument();
    draw(doc, rect);
    const inner = draw(doc, [
      [[1, 0.5, 0], [2, 0.5, 0]],
      [[2, 0.5, 0], [2, 1.5, 0]],
      [[2, 1.5, 0], [1, 1.5, 0]],
      [[1, 1.5, 0], [1, 0.5, 0]],
    ]);
    const sk0 = sketchOf(doc);
    const innerFace = [...sk0.faces.values()].find((f) => f.loops.length === 1)!;
    doc.transact('del face', (d) => SketchGraph.for(d).removeFace(innerFace.id));
    expect(sketchOf(doc).faces.size).toBe(1);
    expect(sketchOf(doc).edges.size).toBe(8);
    doc.transact('erase', (d) => SketchGraph.for(d).removeEdge(inner[0]![0]!));
    const sk = sketchOf(doc);
    expect(sk.faces.size).toBe(1);
    const f = [...sk.faces.values()][0]!;
    expect(f.loops).toHaveLength(1);
    expect(polygonArea(sketchFacePolygonUv(sk, f))).toBeCloseTo(8);
    expect(sk.edges.size).toBe(7);
  });

  it('a vertical loop forms a face in its own plane; undo restores the sketch', () => {
    const doc = createDocument();
    const undo = new UndoStack(doc);
    undo.transact('wall', (d) => {
      const g = SketchGraph.for(d);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([2, 0, 0], [2, 0, 3]);
      g.addEdge([2, 0, 3], [0, 0, 3]);
      g.addEdge([0, 0, 3], [0, 0, 0]);
    });
    const sk = sketchOf(doc);
    expect(sk.faces.size).toBe(1);
    const f = [...sk.faces.values()][0]!;
    expect(Math.abs(f.plane.n[1])).toBeCloseTo(1);
    expect(polygonArea(sketchFacePolygonUv(sk, f))).toBeCloseTo(6);
    undo.undo();
    expect(sketchOf(doc).edges.size).toBe(0);
    expect(sketchOf(doc).vertexHash.size).toBe(0);
    undo.redo();
    expect(sketchOf(doc).faces.size).toBe(1);
  });
});
