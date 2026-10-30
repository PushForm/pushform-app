// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { create, parseSkp } from 'openskp';
import { MERGE_TOL, type Vec3 } from '@pushform/core';
import { createDocument, overlapRatio } from '@pushform/model';
import { applySketchUpImport, SourceSegmentIndex, type SourceSegmentMatch } from './sketchupDocument';
import { prepareSketchUp, type ImportedFace } from './sketchup';

/** The exhaustive scan the import used before segments were indexed; the index must report exactly this. */
function naiveMatches(face: ImportedFace, polyline: Vec3[]): SourceSegmentMatch[] {
  return face.loops.flatMap((loop, k) => loop.flatMap((p, j) => {
    const overlap = overlapRatio(polyline, [p, loop[(j + 1) % loop.length]!], MERGE_TOL);
    return overlap > 0 ? [{ overlap, flags: face.edgeFlags[k]![j]! }] : [];
  }));
}

/**
 * A closed prism whose top and bottom are regular polygons of `sides` edges, so every rim edge is shared
 * by three faces and the caps have many boundary segments. One cap side is split by an extra collinear
 * vertex, which the body merges back into one edge. The rims are polyline curves. Inches.
 */
function prismFixture(sides: number): Uint8Array {
  const builder = create();
  const ring = (z: number): [number, number, number][] => Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides;
    return [Math.round(Math.cos(angle) * 1e4) / 100, Math.round(Math.sin(angle) * 1e4) / 100, z];
  });
  const bottom = ring(0), top = ring(40);
  const [a, b] = [top[0]!, top[1]!];
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 40];
  builder.addPolyline(bottom, { closed: true });
  builder.addPolyline(top, { closed: true });
  builder.addFace([...bottom].reverse());
  builder.addFace([a, mid, ...top.slice(1)]);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // The first side shares the split rim edge, so both faces see the same two collinear source edges.
    builder.addFace([bottom[i]!, bottom[j]!, top[j]!, ...(i === 0 ? [mid] : []), top[i]!], { softEdges: true, smoothEdges: true });
  }
  return builder.toBytes();
}

describe('SketchUp source edge matching', () => {
  it('indexes high-degree face boundaries and reports the same segment coverage as the exhaustive scan', () => {
    const scene = prepareSketchUp(parseSkp(prismFixture(96).buffer as ArrayBuffer));
    const solid = scene.root.solids[0]!;
    expect(scene.root.solids).toHaveLength(1);
    expect(scene.root.sheets).toHaveLength(0);
    const byId = new Map(solid.faces.map(f => [f.id, f]));
    const caps = solid.faces.filter(f => f.loops[0]!.length >= 96);
    expect(caps).toHaveLength(2);
    expect(caps.map(f => f.loops[0]!.length).sort((x, y) => x - y)).toEqual([96, 97]);

    const doc = createDocument();
    const report = doc.transact('Open prism', draft => applySketchUpImport(draft, scene)).value;
    expect(report.bodies).toBe(1);
    const body = [...doc.rootDefinition.entities.bodies.values()][0]!;
    // Every rim edge is shared by a cap and a side; every vertical edge by two sides.
    expect(body.edges.size).toBe(96 * 3);
    let indexed = 0, exhaustive = 0, matched = 0, merged = 0;
    for (const edge of body.edges.values()) {
      const face = byId.get(edge.faceA)!;
      const index = new SourceSegmentIndex(face, MERGE_TOL);
      const expected = naiveMatches(face, edge.polyline);
      expect(index.matches(edge.polyline)).toEqual(expected);
      if (face.loops[0]!.length > SourceSegmentIndex.SMALL_FACE) indexed++; else exhaustive++;
      if (expected.length) matched++;
      if (expected.length > 1) merged++;
    }
    expect(indexed).toBeGreaterThan(0);
    expect(exhaustive).toBeGreaterThan(0);
    expect(matched).toBe(body.edges.size);
    // The split rim edge: one body edge covering two collinear source segments.
    expect(merged).toBe(1);
    // The flags the matches carry reach the body: vertical side edges are soft and smooth, rim edges are not.
    const vertical = [...body.edges.values()].filter(e => Math.abs(e.polyline[0]![2] - e.polyline[e.polyline.length - 1]![2]) > 0.5);
    expect(vertical).toHaveLength(96);
    expect(vertical.every(e => e.soft && e.smooth)).toBe(true);
    const rims = [...body.edges.values()].filter(e => !vertical.includes(e));
    expect(rims.every(e => !e.soft && !e.smooth)).toBe(true);
    // The unsplit rim keeps its curve. Splitting the other rim left the polyline's original edge loose,
    // so the reader already reported that curve and the body keeps only one.
    const curves = [...body.curves.values()];
    expect(curves).toHaveLength(1);
    expect(curves[0]!.edgeRefs).toHaveLength(96);
    expect(scene.root.edges).toHaveLength(1);
    expect(report.warnings.some(w => /1 curve\(s\) imported as separate edges/.test(w))).toBe(true);
  });

  it('keeps long diagonal edges on a face with many tiny segments cheap to index and match', () => {
    // Four long tilted edges spanning all three axes, plus a hole of 2,000 millimetre-scale segments: the
    // bucket walk must follow each edge rather than fill its whole bounding box of cells.
    const outer: Vec3[] = [[0, 0, 0], [10, 0.5, 1], [10.5, 10, 2], [0.5, 10.5, 1]];
    const hole: Vec3[] = Array.from({ length: 2000 }, (_, i) => {
      const a = (i / 2000) * Math.PI * 2;
      return [5 + 0.3 * Math.cos(a), 5 + 0.3 * Math.sin(a), 1 + 0.03 * Math.cos(a)] as Vec3;
    });
    const face: ImportedFace = {
      id: 1, sourceId: 1, normal: [0, 0, 1], front: null, back: null, frontUv: null, backUv: null, hidden: false,
      loops: [outer, hole],
      edgeFlags: [
        outer.map((_, edge) => ({ soft: false, smooth: false, hidden: false, edge, curve: null })),
        hole.map((_, j) => ({ soft: true, smooth: true, hidden: false, edge: 10 + j, curve: 1 })),
      ],
    };
    const started = performance.now();
    const index = new SourceSegmentIndex(face, MERGE_TOL);
    const polylines: Vec3[][] = [[outer[0]!, outer[1]!], [outer[2]!, outer[1]!], [outer[3]!, outer[0]!], [hole[0]!, hole[1]!], [[0, 0, 0], [10.5, 10, 2]]];
    for (const polyline of polylines) expect(index.matches(polyline)).toEqual(naiveMatches(face, polyline));
    expect(index.matches([outer[0]!, outer[1]!]).map(m => m.flags.edge)).toEqual([0]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('matches partial, reversed and collinear-merged edges like the exhaustive scan', () => {
    // A square face whose top side is split into three collinear source segments, plus a hole.
    const face: ImportedFace = {
      id: 1, sourceId: 1, normal: [0, 0, 1], front: null, back: null, frontUv: null, backUv: null, hidden: false,
      loops: [
        [[0, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0], [1, 3, 0], [0, 3, 0]],
        [[1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0]],
      ],
      edgeFlags: [
        [0, 1, 2, 3, 4, 5].map(edge => ({ soft: false, smooth: false, hidden: false, edge, curve: null })),
        [6, 7, 8, 9].map(edge => ({ soft: true, smooth: true, hidden: false, edge, curve: 7 })),
      ],
    };
    const polylines: Vec3[][] = [
      [[3, 3, 0], [0, 3, 0]], [[0, 3, 0], [3, 3, 0]], [[1.5, 3, 0], [2.5, 3, 0]], [[0, 0, 0], [1, 0, 0]],
      [[2, 1, 0], [1, 1, 0]], [[0, 0, 0], [3, 3, 0]], [[0, 0.5, 0], [3, 0.5, 0]], [[-1, 3, 0], [4, 3, 0]],
      [[0, 0, 0], [0, 0, 0]], [[3, 3 + MERGE_TOL / 2, 0], [0, 3 - MERGE_TOL / 2, 0]],
    ];
    for (const small of [true, false]) {
      // Both the exhaustive small-face path and the bucketed path must agree with the scan.
      const subject = small ? face : { ...face, loops: [...face.loops, ...Array.from({ length: 3 }, (_, k) =>
        [[10 + k, 10, 0], [11 + k, 10, 0], [11 + k, 11, 0]] as Vec3[])],
        edgeFlags: [...face.edgeFlags, ...Array.from({ length: 3 }, (_, k) =>
          [0, 1, 2].map(j => ({ soft: false, smooth: false, hidden: false, edge: 100 + k * 3 + j, curve: null })))] };
      const index = new SourceSegmentIndex(subject, MERGE_TOL);
      for (const polyline of polylines) expect(index.matches(polyline)).toEqual(naiveMatches(subject, polyline));
      expect(index.matches([[3, 3, 0], [0, 3, 0]]).map(m => m.flags.edge)).toEqual([2, 3, 4]);
      for (const overlap of index.matches([[-1, 3, 0], [4, 3, 0]]).map(m => m.overlap)) expect(overlap).toBeCloseTo(0.2, 12);
    }
  });
});
