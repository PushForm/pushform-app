// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { linearToSrgb, srgbToLinear, studioColor } from './studioLighting';
it('round-trips dark and light display colors through linear light', () => {
  for (const c of [0, .01, .04, .18, .5, .96, 1]) expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 10);
});
it('keeps black black and preserves material color ordering without clipping', () => {
  const n = [-Math.SQRT1_2, -1 / Math.sqrt(6), 1 / Math.sqrt(3)] as const;
  for (const preset of ['soft', 'bright'] as const) {
    expect(studioColor([0,0,0], n, preset)).toEqual([0,0,0]);
    const wood = studioColor([.89,.83,.73], n, preset);
    expect(wood[0]).toBeGreaterThan(wood[1]); expect(wood[1]).toBeGreaterThan(wood[2]);
    const white = studioColor([1,1,1], n, preset);
    expect(white[0]).toBeGreaterThan(.9); expect(white[0]).toBeLessThanOrEqual(1);
    expect(white[0]).toBe(white[1]); expect(white[1]).toBe(white[2]);
  }
});
