// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { basisToLocal, planeBasis, type Vec2 } from '@pushform/core';
import type { UvMapping } from './entities/attrs';
import {
  uvApplyProjective, uvAt, uvClone, uvMappingEquals, uvProjectiveFromPoints, uvProjectiveInvert, uvProjectiveMapping, uvRebase, uvToAffine,
  type UvProjective,
} from './uv';

const close = (a: Vec2, b: Vec2): void => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe('projective and sized texture placements', () => {
  const src: [Vec2, Vec2, Vec2, Vec2] = [[0, 0], [2, 0], [2.5, 1.5], [-0.2, 1]];
  const dst: [Vec2, Vec2, Vec2, Vec2] = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('sends four points to four points, and back', () => {
    const m = uvProjectiveFromPoints(src, dst)!;
    src.forEach((p, i) => close(uvApplyProjective(m, p[0], p[1]), dst[i]!));
    const inv = uvProjectiveInvert(m)!;
    dst.forEach((p, i) => close(uvApplyProjective(inv, p[0], p[1]), src[i]!));
    // A distorted quadrilateral needs the divisor; a parallelogram does not.
    expect(uvProjectiveMapping(m).kind).toBe('projective');
    const parallelogram = uvProjectiveFromPoints([[0, 0], [2, 0], [2.5, 1], [0.5, 1]], dst)!;
    const mapping = uvProjectiveMapping(parallelogram);
    expect(mapping.kind).toBe('affine');
    close(uvAt(mapping, 1, 1, 2.5, 1), [1, 1]);
    expect(uvProjectiveFromPoints([[0, 0], [1, 0], [2, 0], [3, 0]], dst)).toBeNull();
  });

  it('evaluates every kind; sized divides by the texture shown', () => {
    const projective: UvMapping = { kind: 'projective', matrix: [...uvProjectiveFromPoints(src, dst)!] as unknown as UvProjective };
    close(uvAt(projective, 5, 5, 2.5, 1.5), [1, 1]);
    const sized: UvMapping = { kind: 'sized', matrix: [0, 1, 0.5, -1, 0, 0] };
    close(uvAt(sized, 2, 4, 1, 1), [1.5 / 2, -1 / 4]);
    close(uvAt(sized, 0.5, 0.5, 1, 1), [3, -2]);
    close(uvAt({ kind: 'auto' }, 2, 4, 1, 1), [0.5, 0.25]);
    expect(uvToAffine(sized, 2, 4)).toEqual([0, 0.5, 0.25, -0.25, 0, 0]);
  });

  it('re-expresses projective and sized placements in another basis without changing what any point shows', () => {
    const from = planeBasis([0, 0, 0], [0, 0, 1]), to = planeBasis([1, 2, 0], [0, 0, -1]);
    const projective: UvMapping = { kind: 'projective', matrix: [...uvProjectiveFromPoints(src, dst)!] as unknown as UvProjective };
    const sized: UvMapping = { kind: 'sized', matrix: [0.3, 1, 0.5, -1, 0.2, 0] };
    for (const uv of [projective, sized]) {
      const moved = uvRebase(uv, from, to, null);
      expect(moved.kind).toBe(uv.kind);
      for (const p of [[0, 0, 0], [1, 1, 0], [2.5, -1, 0]] as const) {
        const [u, v] = basisToLocal(from, p), [u2, v2] = basisToLocal(to, p);
        close(uvAt(moved, 0.7, 0.3, u2, v2), uvAt(uv, 0.7, 0.3, u, v));
      }
    }
  });

  it('compares and copies matrices of every length', () => {
    const p: UvMapping = { kind: 'projective', matrix: [1, 0, 0, 0, 1, 0, 0.1, 0, 1] };
    const copy = uvClone(p);
    expect(uvMappingEquals(p, copy)).toBe(true);
    expect(copy).not.toBe(p);
    expect((copy as { matrix: readonly number[] }).matrix).not.toBe((p as { matrix: readonly number[] }).matrix);
    expect(uvMappingEquals(p, { kind: 'affine', matrix: [1, 0, 0, 0, 1, 0] })).toBe(false);
    expect(uvMappingEquals({ kind: 'sized', matrix: [1, 0, 0, 0, 1, 0] }, { kind: 'affine', matrix: [1, 0, 0, 0, 1, 0] })).toBe(false);
  });
});
