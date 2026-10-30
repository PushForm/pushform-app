// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { planarArrangement, ringSegmentRefs, type ArrangementSegment } from './planarArrangement';
import { signedArea } from './polygon2d';

let nextId = 1;
const seg = (ax: number, ay: number, bx: number, by: number, id = nextId++): ArrangementSegment => ({
  id,
  a: [ax, ay],
  b: [bx, by],
});
const square = (s: number, ox = 0, oy = 0): ArrangementSegment[] => [
  seg(ox, oy, ox + s, oy),
  seg(ox + s, oy, ox + s, oy + s),
  seg(ox + s, oy + s, ox, oy + s),
  seg(ox, oy + s, ox, oy),
];

describe('planarArrangement', () => {
  it('a square gives one CCW cell with 4 edges', () => {
    const segs = square(2);
    const arr = planarArrangement(segs, { tol: 1e-9 });
    expect(arr.vertices).toHaveLength(4);
    expect(arr.edges).toHaveLength(4);
    expect(arr.cells).toHaveLength(1);
    const c = arr.cells[0]!;
    expect(signedArea(c.outer)).toBeCloseTo(4);
    expect(c.holes).toHaveLength(0);
    expect(c.segIds.sort()).toEqual(segs.map((s) => s.id).sort());
    const refs = ringSegmentRefs(arr, c.outerEdges);
    expect(refs).toHaveLength(4);
    expect(refs.every((r) => r.forward)).toBe(true);
  });
  it('a diagonal splits a square into two cells; crossing lines split each other', () => {
    const segs = [...square(2), seg(0, 0, 2, 2)];
    const arr = planarArrangement(segs);
    expect(arr.cells).toHaveLength(2);
    for (const c of arr.cells) expect(c.area).toBeCloseTo(2);
    const x = planarArrangement([seg(0, 0, 2, 2), seg(0, 2, 2, 0)]);
    expect(x.vertices).toHaveLength(5);
    expect(x.edges).toHaveLength(4);
    expect(x.cells).toHaveLength(0);
  });
  it('T-junction snapping splits the crossed edge', () => {
    const arr = planarArrangement([...square(2), seg(1, 0 + 1e-10, 1, 2 - 1e-10)], { tol: 1e-6 });
    expect(arr.cells).toHaveLength(2);
    expect(arr.edges).toHaveLength(7);
  });
  it('an isolated inner loop becomes a hole and its own cell', () => {
    const outer = square(4);
    const inner = square(1, 1, 1);
    const arr = planarArrangement([...outer, ...inner]);
    expect(arr.cells).toHaveLength(2);
    const big = arr.cells.find((c) => c.holes.length === 1)!;
    const small = arr.cells.find((c) => c.holes.length === 0)!;
    expect(big).toBeDefined();
    expect(small.area).toBeCloseTo(1);
    expect(big.area).toBeCloseTo(15);
    expect(signedArea(big.holes[0]!)).toBeCloseTo(-1);
    expect(big.segIds).toHaveLength(8);
    expect(ringSegmentRefs(arr, big.holeEdges[0]!).every((r) => !r.forward)).toBe(true);
  });
  it('dangling edges are stripped as spurs and do not form cells', () => {
    const arr = planarArrangement([...square(2), seg(1, 1, 1.5, 1.5), seg(1.5, 1.5, 1.8, 1.2)]);
    expect(arr.cells).toHaveLength(1);
    expect(arr.cells[0]!.outer).toHaveLength(4);
    expect(arr.cells[0]!.segIds).toHaveLength(4);
    const tree = planarArrangement([seg(0, 0, 1, 0), seg(1, 0, 1, 1), seg(1, 0, 2, 0)]);
    expect(tree.cells).toHaveLength(0);
  });
  it('collinear overlapping segments merge into shared sub-edges', () => {
    const arr = planarArrangement([seg(0, 0, 2, 0), seg(1, 0, 3, 0)]);
    expect(arr.vertices).toHaveLength(4);
    expect(arr.edges).toHaveLength(3);
    const shared = arr.edges.find((e) => e.segs.length === 2)!;
    expect(shared).toBeDefined();
  });
  it('nested holes: a loop inside a hole is not a hole of the outer cell', () => {
    const arr = planarArrangement([...square(9), ...square(5, 2, 2), ...square(1, 4, 4)]);
    expect(arr.cells).toHaveLength(3);
    const areas = arr.cells.map((c) => c.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(1);
    expect(areas[1]).toBeCloseTo(24);
    expect(areas[2]).toBeCloseTo(56);
  });
  it('handles a few hundred random segments without throwing', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const segs: ArrangementSegment[] = [];
    for (let i = 0; i < 300; i++) segs.push(seg(rnd() * 10, rnd() * 10, rnd() * 10, rnd() * 10));
    const arr = planarArrangement(segs, { tol: 1e-7 });
    for (const c of arr.cells) expect(c.area).toBeGreaterThan(0);
    expect(arr.cells.length).toBeGreaterThan(50);
  });
});
