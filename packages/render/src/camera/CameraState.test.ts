// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA,
  cameraDistance,
  cameraFrameBox,
  cameraOrbit,
  cameraPan,
  cameraProject,
  cameraRay,
  cameraSetProjection,
  cameraStandardView,
  cameraZoom,
  focalLengthToFov,
} from './CameraState';
import type { CameraState } from './CameraState';

const box = { min: [-1, -2, 0] as const, max: [3, 1, 2] as const };
const corners = (): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
  return out;
};

describe('CameraState', () => {
  it('orbit keeps the eye-target distance and stays gravity aligned', () => {
    const s0 = DEFAULT_CAMERA;
    const d0 = cameraDistance(s0);
    const s1 = cameraOrbit(s0, s0.target, 0.7, -0.3);
    expect(cameraDistance(s1)).toBeCloseTo(d0, 9);
    expect(s1.up).toEqual([0, 0, 1]);
    // Pivot away from the target: distance still preserved (rigid rotation).
    const s2 = cameraOrbit(s0, [5, 5, 0], 1.2, 0.4);
    expect(cameraDistance(s2)).toBeCloseTo(d0, 9);
    // Elevation is clamped: never flips over the pole.
    const s3 = cameraOrbit(s0, s0.target, 0, -10);
    const f = [s3.target[0] - s3.eye[0], s3.target[1] - s3.eye[1], s3.target[2] - s3.eye[2]];
    const len = Math.hypot(f[0]!, f[1]!, f[2]!);
    expect(f[2]! / len).toBeGreaterThan(-1);
    expect(f[2]! / len).toBeLessThan(-0.99);
  });

  it('free orbit rotates the up vector and keeps distance', () => {
    const s = cameraOrbit(DEFAULT_CAMERA, DEFAULT_CAMERA.target, 0.3, 0.2, { free: true });
    expect(cameraDistance(s)).toBeCloseTo(cameraDistance(DEFAULT_CAMERA), 9);
    expect(Math.hypot(...s.up)).toBeCloseTo(1, 9);
    expect(s.up).not.toEqual([0, 0, 1]);
  });

  it('zoom extents frames a box in perspective and parallel projection', () => {
    for (const projection of ['perspective', 'parallel'] as const) {
      const base: CameraState = { ...DEFAULT_CAMERA, projection };
      const aspect = 1.6;
      const s = cameraFrameBox(base, box, aspect);
      expect(s.target).toEqual([1, -0.5, 1]);
      for (const c of corners()) {
        const p = cameraProject(s, c, aspect);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        expect(p.depth).toBeGreaterThan(0);
      }
      // Reasonably tight: the box should fill a good part of the view.
      const xs = corners().map((c) => Math.abs(cameraProject(s, c, aspect).x));
      const ys = corners().map((c) => Math.abs(cameraProject(s, c, aspect).y));
      expect(Math.max(...xs, ...ys)).toBeGreaterThan(0.4);
    }
  });

  it('zoom keeps the anchor point under the cursor', () => {
    const aspect = 1.5;
    const s0 = DEFAULT_CAMERA;
    const ray = cameraRay(s0, 0.4, -0.3, aspect);
    const anchor: [number, number, number] = [
      ray.origin[0] + ray.dir[0] * 12,
      ray.origin[1] + ray.dir[1] * 12,
      ray.origin[2] + ray.dir[2] * 12,
    ];
    const before = cameraProject(s0, anchor, aspect);
    const s1 = cameraZoom(s0, 0.6, anchor);
    const after = cameraProject(s1, anchor, aspect);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(cameraDistance(s1)).toBeCloseTo(cameraDistance(s0) * 0.6, 9);

    const o0 = cameraSetProjection(s0, 'parallel');
    const o1 = cameraZoom(o0, 0.5, anchor);
    const ob = cameraProject(o0, anchor, aspect);
    const oa = cameraProject(o1, anchor, aspect);
    expect(oa.x).toBeCloseTo(ob.x, 6);
    expect(oa.y).toBeCloseTo(ob.y, 6);
    expect(o1.orthoHeight).toBeCloseTo(o0.orthoHeight * 0.5, 9);
  });

  it('pan moves the scene with the cursor', () => {
    const aspect = 1;
    const s0 = DEFAULT_CAMERA;
    const p = s0.target;
    const before = cameraProject(s0, p, aspect);
    const s1 = cameraPan(s0, 100, 0, 500);
    const after = cameraProject(s1, p, aspect);
    // 100 px right of a 500 px tall (and wide) viewport = +0.4 NDC.
    expect(after.x - before.x).toBeCloseTo(0.4, 6);
    expect(after.y - before.y).toBeCloseTo(0, 6);
  });

  it('standard views keep the distance and projection switch preserves the view size', () => {
    const s = cameraStandardView(DEFAULT_CAMERA, 'top');
    expect(cameraDistance(s)).toBeCloseTo(cameraDistance(DEFAULT_CAMERA), 9);
    expect(s.eye[2]).toBeGreaterThan(s.target[2]);
    expect(s.up).toEqual([0, 1, 0]);
    const iso = cameraStandardView(DEFAULT_CAMERA, 'iso');
    expect(iso.eye[0]).toBeGreaterThan(iso.target[0]);
    expect(iso.eye[1]).toBeLessThan(iso.target[1]);
    expect(iso.eye[2]).toBeGreaterThan(iso.target[2]);

    const aspect = 1.3;
    const ortho = cameraSetProjection(DEFAULT_CAMERA, 'parallel');
    const pt: [number, number, number] = [1, 0.5, 0.5];
    // A point near the target projects to about the same place in both projections.
    const a = cameraProject(DEFAULT_CAMERA, pt, aspect);
    const b = cameraProject(ortho, pt, aspect);
    expect(a.x).toBeCloseTo(b.x, 1);
    expect(a.y).toBeCloseTo(b.y, 1);
    const back = cameraSetProjection(ortho, 'perspective');
    expect(cameraDistance(back)).toBeCloseTo(cameraDistance(DEFAULT_CAMERA), 9);
  });

  it('converts focal length to field of view', () => {
    expect(focalLengthToFov(18, 1)).toBeCloseTo(90, 5);
    expect(focalLengthToFov(50, 1.5)).toBeGreaterThan(20);
    expect(focalLengthToFov(50, 1.5)).toBeLessThan(30);
  });
});
