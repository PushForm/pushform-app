// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { pointOnPathSegment, splitLayoutPathSegment } from './path';

it('splits a cubic without changing its shape', () => {
  const points: [number, number][] = [[0, 0], [100, 0]];
  const handles = [{ out: [20, 60] as [number, number] }, { in: [80, 60] as [number, number] }];
  const split = splitLayoutPathSegment(points, handles, false, 0, 0.4);
  expect(split.points).toHaveLength(3);
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    const original = pointOnPathSegment(points, handles, 0, false, t);
    const mapped = t <= 0.4
      ? pointOnPathSegment(split.points, split.handles, 0, false, t / 0.4)
      : pointOnPathSegment(split.points, split.handles, 1, false, (t - 0.4) / 0.6);
    expect(mapped[0]).toBeCloseTo(original[0], 7);
    expect(mapped[1]).toBeCloseTo(original[1], 7);
  }
});
