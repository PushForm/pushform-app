// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { fogDistancesFor } from './FogPanel';

describe('fogDistancesFor', () => {
  it('puts the near distance halfway to the model and the far distance three times as far', () => {
    expect(fogDistancesFor([0, -20, 0], { min: [-1, -1, 0], max: [1, 1, 0] })).toEqual({ near: 10, far: 60 });
  });

  it('keeps the far distance at 10 m or more', () => {
    expect(fogDistancesFor([0, -2, 0], { min: [-1, -1, 0], max: [1, 1, 0] })).toEqual({ near: 1, far: 10 });
  });

  it('has nothing to measure without a model or when the eye is at its center', () => {
    expect(fogDistancesFor([0, -5, 0], null)).toBeNull();
    expect(fogDistancesFor([0, 0, 0], { min: [-1, -1, -1], max: [1, 1, 1] })).toBeNull();
  });
});
