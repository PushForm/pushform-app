// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, meshSignedVolume, meshTriangleNormal, meshBounds } from './mesh';

describe('mesh', () => {
  it('box volume and normals are outward', () => {
    const m = meshBox([0, 0, 0], [2, 3, 4]);
    expect(meshSignedVolume(m)).toBeCloseTo(24);
    expect(meshTriangleNormal(m, 2)).toEqual([0, 0, 1]);
    expect(meshTriangleNormal(m, 0)).toEqual([0, 0, -1]);
    expect(meshBounds(m).max).toEqual([2, 3, 4]);
  });
});
