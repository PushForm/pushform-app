// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { MERGE_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { PackedPointIndex } from './packedPointIndex';
describe('packed point proximity index', () => {
  it('matches brute-force distances for deterministic clouds, planes and coincident points', () => {
    for (const flat of [false, true]) {
      const p = new Float64Array(9000); let seed = 123;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let i = 0; i < p.length; i++) p[i] = flat && i % 3 === 0 ? 0 : random() * 10 - 5;
      p.set(p.subarray(0, 3), 3); const before = p.slice(), rows = new Uint32Array(p.length / 3), index = new PackedPointIndex(p, rows);
      expect(rows.byteLength).toBe(12000); expect(p).toEqual(before); if (flat) expect(index.axis).not.toBe(0);
      for (let query = 0; query < 100; query++) {
        const at = query * 3, point: Vec3 = [p[at]!, p[at + 1]!, p[at + 2]!], radius = query % 4 === 0 ? 0 : query % 4 === 1 ? MERGE_TOL : query % 4 === 2 ? 1 : 100;
        const expected = []; for (let row = 0; row < rows.length; row++) if (Math.hypot(p[row * 3]! - point[0], p[row * 3 + 1]! - point[1], p[row * 3 + 2]! - point[2]) <= radius) expected.push(row);
        expect([...index.within(point, radius)].sort((a, b) => a - b)).toEqual(expected);
      }
    }
  });
  it('handles exact boundaries, negative zero, large coordinates and empty input', () => {
    const p = new Float64Array([-0, 0, 0, MERGE_TOL, 0, 0, -MERGE_TOL, 0, 0, 1e100, 2, 3]);
    const index = new PackedPointIndex(p, new Uint32Array(4));
    expect([...index.within([0, 0, 0])].sort()).toEqual([0, 1, 2]); expect([...index.within([1e100, 2, 3], 0)]).toEqual([3]);
    expect([...new PackedPointIndex(new Float64Array(), new Uint32Array()).within([0, 0, 0])]).toEqual([]);
  });
  it('rejects invalid construction, queries and cancellation', () => {
    expect(() => new PackedPointIndex(new Float64Array(2), new Uint32Array(1))).toThrow();
    expect(() => new PackedPointIndex(new Float64Array([0, NaN, 0]), new Uint32Array(1))).toThrow();
    const index = new PackedPointIndex(new Float64Array(3), new Uint32Array(1));
    expect(() => [...index.within([0, 0, 0], -1)]).toThrow(); expect(() => [...index.within([Infinity, 0, 0])]).toThrow();
    const controller = new AbortController(); controller.abort(); expect(() => new PackedPointIndex(new Float64Array(), new Uint32Array(), controller.signal)).toThrow();
  });
});
