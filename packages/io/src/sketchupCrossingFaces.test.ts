// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pushform/core';
import { addThroughSplits, insertSplits } from './sketchupCrossingFaces';

describe('crossing-face cuts', () => {
  it('adds a cut point to another edge that runs through it, within the merge tolerance', () => {
    const vertices = new Map<number, Vec3>([
      [1, [0, 0, 0]], [2, [4, 0, 0]], // the cut edge
      [3, [1, 5e-8, 0]], [4, [3, 5e-8, 0]], // an overlapping edge, 5e-8 m off it
      [5, [0, 1, 0]], [6, [4, 1, 0]], // a parallel edge, far from the cut
      [7, [2, 0, 0]], [8, [2, -1, 0]], // an edge ending at the cut point
    ]);
    const cut: Vec3 = [2, 0, 0];
    const splits = new Map<number, Vec3[]>([[10, [cut]]]);
    addThroughSplits(splits, [
      { id: 10, v1Id: 1, v2Id: 2 }, { id: 11, v1Id: 3, v2Id: 4 }, { id: 12, v1Id: 5, v2Id: 6 }, { id: 13, v1Id: 7, v2Id: 8 },
    ], vertices);
    expect(splits.get(10)).toEqual([cut]);
    expect(splits.get(11)).toEqual([cut]);
    expect(splits.has(12)).toBe(false);
    expect(splits.has(13)).toBe(false);
    // A sheet along the overlapping edge now shares the cut's vertex.
    const ring: Vec3[] = [[1, 5e-8, 0], [3, 5e-8, 0], [3, 1, 0], [1, 1, 0]];
    const piece = insertSplits([ring], [[11, 14, 15, 16]], splits);
    expect(piece.loops[0]).toEqual([[1, 5e-8, 0], cut, [3, 5e-8, 0], [3, 1, 0], [1, 1, 0]]);
    expect(piece.edges[0]).toEqual([11, 11, 14, 15, 16]);
  });
});
