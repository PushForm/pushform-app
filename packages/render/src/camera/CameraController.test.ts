// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Vec3 } from '@pushform/core';
import { CameraController } from './CameraController';
import { DEFAULT_CAMERA, cameraProject, cameraSetProjection } from './CameraState';

const box: Box3 = { min: [0, 0, 0], max: [4, 2, 1] };
const corners = (b: Box3): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
};

describe('CameraController framing with a top inset', () => {
  for (const projection of ['perspective', 'parallel'] as const) {
    it(`keeps a ${projection} framed box below the inset, centred in the clear area`, () => {
      const c = new CameraController(projection === 'parallel' ? cameraSetProjection(DEFAULT_CAMERA, 'parallel') : DEFAULT_CAMERA);
      c.setSize(1000, 600);
      c.setFrameInsetTop(120);
      c.zoomBox(box);
      const toScreenY = (p: Vec3) => (1 - cameraProject(c.getState(), p, c.aspect).y) * 300;
      const ys = corners(box).map(toScreenY);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(120 - 1e-6);
      expect(Math.max(...ys)).toBeLessThanOrEqual(600 + 1e-6);
      // the box's centre is at the middle of the clear area
      expect(toScreenY([2, 1, 0.5])).toBeCloseTo(120 + 480 / 2, 0);
    });
  }

  it('frames as before without an inset', () => {
    const a = new CameraController();
    const b = new CameraController();
    for (const c of [a, b]) c.setSize(1000, 600);
    b.setFrameInsetTop(0);
    a.zoomBox(box);
    b.zoomBox(box);
    expect(b.getState()).toEqual(a.getState());
  });
});
