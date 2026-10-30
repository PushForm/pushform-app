// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { planeBasis } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { EDGE_FLAG_BOUNDARY, EDGE_FLAG_SOFT } from '../types';
import type { RenderSketch } from '../types';
import { buildSketchGeometry } from './SketchRenderable';

const P: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 1, 0],
  [0, 1, 0],
];
const basis = planeBasis([0, 0, 0], [0, 0, 1]);

function rectSketch(opts: { soft?: boolean; hiddenFace?: boolean; free?: boolean } = {}): RenderSketch {
  const edges = [0, 1, 2, 3].map((i) => ({
    id: 10 + i,
    a: P[i]!,
    b: P[(i + 1) % 4]!,
    soft: i === 0 && !!opts.soft,
    smooth: false,
    hidden: false,
  }));
  if (opts.free) edges.push({ id: 20, a: [5, 5, 0], b: [6, 5, 0], soft: false, smooth: false, hidden: false });
  return {
    id: '',
    path: [],
    version: {},
    faces: [{ id: 1, loops: [P], basis, hidden: !!opts.hiddenFace }],
    edges,
  };
}

describe('buildSketchGeometry', () => {
  it('triangulates a rectangle into 2 triangles with the plane normal and default colors', () => {
    const g = buildSketchGeometry(rectSketch(), [0, 0, 0]);
    expect(g.positions.length).toBe(6 * 3);
    expect(g.normals.length).toBe(6 * 3);
    for (let i = 0; i < 6; i++) expect(g.normals[i * 3 + 2]).toBe(1);
    expect(g.faceIds.every((f) => f === 1)).toBe(true);
    expect(g.faceRanges.get(1)).toEqual([0, 6]);
    // front white, back SketchUp blue-grey
    expect([g.frontColors[0], g.frontColors[1], g.frontColors[2]]).toEqual([1, 1, 1]);
    expect(g.backColors[0]!).toBeLessThan(1);
  });

  it('marks face-boundary edges as profiles (BOUNDARY flag, zero second normal)', () => {
    const g = buildSketchGeometry(rectSketch({ free: true }), [0, 0, 0]);
    expect(g.edges.positions.length / 6).toBe(5);
    for (let i = 0; i < 4; i++) {
      expect(g.edges.flags[i]! & EDGE_FLAG_BOUNDARY).toBe(EDGE_FLAG_BOUNDARY);
      expect(g.edges.normalA[i * 3 + 2]).toBe(1);
      expect(g.edges.normalB[i * 3 + 2]).toBe(0);
    }
    // the free edge draws at the normal width: both normals equal, no boundary flag
    expect(g.edges.flags[4]).toBe(0);
    expect(g.edges.normalB[4 * 3 + 2]).toBe(1);
  });

  it('routes soft edges to the dashed batch only in hidden-geometry mode', () => {
    const off = buildSketchGeometry(rectSketch({ soft: true }), [0, 0, 0]);
    expect(off.edges.positions.length / 6).toBe(3);
    expect(off.hiddenEdges.positions.length).toBe(0);
    const on = buildSketchGeometry(rectSketch({ soft: true }), [0, 0, 0], { showHidden: true });
    expect(on.edges.positions.length / 6).toBe(3);
    expect(on.hiddenEdges.positions.length / 6).toBe(1);
    expect(on.hiddenEdges.flags[0]! & EDGE_FLAG_SOFT).toBe(EDGE_FLAG_SOFT);
  });

  it('skips hidden faces unless hidden geometry is shown, and applies the floating origin', () => {
    const off = buildSketchGeometry(rectSketch({ hiddenFace: true }), [0, 0, 0]);
    expect(off.positions.length).toBe(0);
    const on = buildSketchGeometry(rectSketch({ hiddenFace: true }), [1, 0, 0], { showHidden: true });
    expect(on.positions.length).toBe(18);
    const xs = Array.from(on.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(-1);
    expect(Math.max(...xs)).toBe(1);
  });
});

describe('smooth sheet shading', () => {
  // Two roof slopes meeting at a ridge along x, 0.5 above the eaves.
  const eaveA: Vec3[] = [[0, 0, 0], [2, 0, 0]], ridge: Vec3[] = [[2, 1, 0.5], [0, 1, 0.5]], eaveB: Vec3[] = [[2, 2, 0], [0, 2, 0]];
  const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const nA = unit([0, -0.5, 1]), nB = unit([0, 0.5, 1]);
  function roof(opts: { smooth?: boolean; soft?: boolean; flipB?: boolean } = {}): RenderSketch {
    const loopA = [...eaveA, ...ridge], loopB = [ridge[1]!, ridge[0]!, ...eaveB];
    const edge = (id: number, a: Vec3, b: Vec3, smooth = false, soft = false) => ({ id, a, b, soft, smooth, hidden: false });
    return {
      id: '', path: [], version: {},
      faces: [
        { id: 1, loops: [loopA], basis: planeBasis(loopA[0]!, nA), hidden: false },
        { id: 2, loops: [opts.flipB ? [...loopB].reverse() : loopB], basis: planeBasis(loopB[0]!, opts.flipB ? [-nB[0], -nB[1], -nB[2]] : nB), hidden: false },
      ],
      edges: [edge(1, ridge[0]!, ridge[1]!, opts.smooth, opts.soft), edge(2, eaveA[0]!, eaveA[1]!), edge(3, eaveB[0]!, eaveB[1]!)],
    };
  }
  /** Normals of face `id`'s vertices, keyed by vertex position. */
  function normalsAt(g: ReturnType<typeof buildSketchGeometry>, id: number): Map<string, number[]> {
    const [start, count] = g.faceRanges.get(id)!;
    const out = new Map<string, number[]>();
    for (let v = start; v < start + count; v++)
      out.set([0, 1, 2].map((k) => g.positions[v * 3 + k]).join(','), [0, 1, 2].map((k) => g.normals[v * 3 + k]!));
    return out;
  }
  const close = (a: number[] | undefined, b: readonly number[]) => b.forEach((x, i) => expect(a![i]).toBeCloseTo(x, 5));

  it('keeps faces flat unless a smooth edge joins them', () => {
    for (const sketch of [roof(), roof({ soft: true })]) {
      const g = buildSketchGeometry(sketch, [0, 0, 0]);
      for (const n of normalsAt(g, 1).values()) close(n, nA);
      for (const n of normalsAt(g, 2).values()) close(n, nB);
    }
  });

  it('averages normals along the smooth edge and leaves the far side flat', () => {
    const g = buildSketchGeometry(roof({ smooth: true }), [0, 0, 0]);
    const a = normalsAt(g, 1), b = normalsAt(g, 2);
    close(a.get('0,1,0.5'), [0, 0, 1]); close(a.get('2,1,0.5'), [0, 0, 1]);
    close(b.get('0,1,0.5'), [0, 0, 1]);
    close(a.get('0,0,0'), nA); close(b.get('2,2,0'), nB);
  });

  it('turns a neighbor that faces the other way before averaging', () => {
    const g = buildSketchGeometry(roof({ smooth: true, flipB: true }), [0, 0, 0]);
    close(normalsAt(g, 1).get('2,1,0.5'), [0, 0, 1]);
    close(normalsAt(g, 2).get('2,1,0.5'), [0, 0, -1]);
  });
});
