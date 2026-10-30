// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { buildHighlightGeometry, loopBasis } from './HighlightLayer';
import { GUIDE_EXTENT } from './GuideLayer';

describe('buildHighlightGeometry', () => {
  it('triangulates face loops, expands edge polylines and collects body ids', () => {
    const g = buildHighlightGeometry(
      [
        { kind: 'face', key: '/1', faceId: 2, loops: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]] },
        { kind: 'edge', points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
        { kind: 'sketchEdge', id: 7, a: [0, 0, 1], b: [1, 0, 1] },
        { kind: 'sketchVertex', p: [3, 3, 3] },
        { kind: 'body', key: '/9' },
        { kind: 'instance', key: '3', bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
        { kind: 'sketchFace', id: 4, loops: [[[0, 0, 2], [1, 0, 2], [0, 1, 2]]] },
      ],
      [1, 0, 0],
    );
    expect(g.facePositions.length).toBe((6 + 3) * 3);
    // 2 polyline segments + 1 sketch edge + the 12 edges of the instance box
    expect(g.edgePositions.length / 6).toBe(3 + 12);
    expect(Array.from(g.vertexPositions)).toEqual([2, 3, 3]);
    expect([...g.bodyKeys]).toEqual(['/9']);
    expect([...g.instanceKeys]).toEqual(['3']);
    expect([...g.sketchFaceIds]).toEqual([4]);
    // origin applied to face triangles
    const xs = Array.from(g.facePositions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(-1);
  });

  it('highlights guides: infinite lines as long segments, finite ones as-is, points as vertex markers', () => {
    const g = buildHighlightGeometry(
      [
        { kind: 'guide', id: 1, p: [0, 0, 1], dir: [3, 0, 0] },
        { kind: 'guide', id: 2, p: [0, 0, 0], dir: [1, 0, 0], end: [1, 0, 0] },
        { kind: 'guide', id: 3, p: [2, 2, 2], dir: null },
      ],
      [0, 0, 0],
    );
    expect(g.edgePositions.length / 6).toBe(2);
    expect(Array.from(g.edgePositions.slice(0, 6))).toEqual([-GUIDE_EXTENT, 0, 1, GUIDE_EXTENT, 0, 1]);
    expect(Array.from(g.edgePositions.slice(6, 12))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(Array.from(g.vertexPositions)).toEqual([2, 2, 2]);
  });

  it('derives a basis from a vertical loop and ignores degenerate ones', () => {
    const b = loopBasis([[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]]);
    expect(b).not.toBeNull();
    expect(Math.abs(b!.n[0])).toBeCloseTo(1);
    expect(loopBasis([[0, 0, 0], [1, 1, 1], [2, 2, 2]])).toBeNull();
  });
});
