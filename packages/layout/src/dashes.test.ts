// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LAYOUT_DASH_PATTERNS, layoutDashMm, matchLayoutDash, nearestLayoutDash } from './dashes';

const pt = 25.4 / 72;
const close = (actual: number[], expected: number[]) => { expect(actual).toHaveLength(expected.length); actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 9)); };

it('draws LayOut patterns in weights, scaling dashes and gaps but not dots, with a 0.75 pt unit floor', () => {
  close(layoutDashMm(1, 4), [48 * pt, 24 * pt]);
  close(layoutDashMm(3, 2, 1.5), [36 * pt, 18 * pt, 2 * pt, 18 * pt]);
  close(layoutDashMm(10, 1), [36 * pt, 10 * pt, 12 * pt, 10 * pt]);
  close(layoutDashMm(1, 0.25, 4), [36 * pt, 18 * pt]);
  close(layoutDashMm(99, 1), layoutDashMm(1, 1));
});

it('recognizes every pattern at any weight and scale, and nothing else', () => {
  for (const { id } of LAYOUT_DASH_PATTERNS) {
    for (const [weight, scale] of [[1, 1], [0.35, 2.5], [6, 0.1]] as const) {
      const match = matchLayoutDash(layoutDashMm(id, weight, scale), weight);
      expect(match?.id).toBe(id);
      expect(match?.scale).toBeCloseTo(scale, 9);
    }
  }
  expect(matchLayoutDash([4, 2, 1, 2], 1)).toBeNull();
  expect(matchLayoutDash(layoutDashMm(1, 1), 2)?.scale).toBeCloseTo(0.5, 9);
});

it('maps other dash lengths to the nearest LayOut pattern with the same repeat length', () => {
  const dotted = nearestLayoutDash([0.1, 1], 0.5);
  expect(dotted.id).toBe(2);
  const center = nearestLayoutDash([12, 3, 2, 3], 0.5), dashed = nearestLayoutDash([6, 2], 0.5);
  expect(center.id).toBe(3);
  expect(layoutDashMm(center.id, 0.5, center.scale).reduce((s, n) => s + n, 0)).toBeCloseTo(20);
  expect(dashed.id).toBe(1);
  expect(layoutDashMm(1, 0.5, dashed.scale).reduce((s, n) => s + n, 0)).toBeCloseTo(8);
  // Equal dashes and gaps are LayOut's short dash, so they match exactly.
  expect(nearestLayoutDash([5, 5], 0.5).id).toBe(12);
});
