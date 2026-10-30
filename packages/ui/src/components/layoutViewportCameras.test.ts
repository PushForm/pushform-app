// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { viewportPaperPoint, type LayoutViewportCamera } from '@pushform/layout';
import { initialViewportCamera, orbitViewportCamera, panViewportCamera, projectionViewportCamera, standardViewportCamera, zoomViewportCamera } from './layoutViewportCameras';

const frame: [number, number][] = [[10, 10], [110, 10], [110, 60], [10, 60]];
const perspective: LayoutViewportCamera = { eye: [10, -10, 8], target: [0, 0, 1], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
const parallel: LayoutViewportCamera = { eye: [0, 0, 50], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', fov: 35, scale: 1 / 50 };
const distance = (c: LayoutViewportCamera) => Math.hypot(c.eye[0] - c.target[0], c.eye[1] - c.target[1], c.eye[2] - c.target[2]);

it('changes projection without moving target-plane geometry or the camera direction', () => {
  const before = { ...parallel, shift: [0.2, -0.3] as [number, number] };
  const changed = projectionViewportCamera(before, 'perspective', frame);
  expect(changed.eye).toEqual(before.eye); expect(changed.target).toEqual(before.target);
  for (const p of [[0, 0, 0], [1, 1, 0]] as [number, number, number][]) {
    const a = viewportPaperPoint(frame, before, p)!, b = viewportPaperPoint(frame, changed, p)!;
    expect(b[0]).toBeCloseTo(a[0], 9); expect(b[1]).toBeCloseTo(a[1], 9);
  }
  const back = projectionViewportCamera(changed, 'parallel', frame);
  expect(back.scale).toBeCloseTo(before.scale, 12); expect(back.shift).toEqual(before.shift);
});

describe('viewport camera navigation', () => {
  it('orbits around the target at a constant distance and keeps a parallel scale', () => {
    const orbited = orbitViewportCamera(perspective, frame, [25, 0]);
    expect(orbited.target).toEqual(perspective.target);
    expect(distance(orbited)).toBeCloseTo(distance(perspective));
    expect(orbited.eye).not.toEqual(perspective.eye);
    expect(orbitViewportCamera(parallel, frame, [0, 10]).scale).toBeCloseTo(1 / 50);
  });

  it('pans so the model follows the pointer, also in a rotated frame', () => {
    const before = viewportPaperPoint(frame, parallel, [0, 0, 0])!;
    const after = viewportPaperPoint(frame, panViewportCamera(parallel, frame, [8, -4]), [0, 0, 0])!;
    expect(after[0] - before[0]).toBeCloseTo(8);
    expect(after[1] - before[1]).toBeCloseTo(-4);
    const rotated: [number, number][] = [[60, 10], [60, 110], [10, 110], [10, 10]];
    const start = viewportPaperPoint(rotated, parallel, [0, 0, 0])!;
    const moved = viewportPaperPoint(rotated, panViewportCamera(parallel, rotated, [3, 5]), [0, 0, 0])!;
    expect(moved[0] - start[0]).toBeCloseTo(3);
    expect(moved[1] - start[1]).toBeCloseTo(5);
  });

  it('zooms parallel views by scale and perspective views by distance', () => {
    expect(zoomViewportCamera(parallel, frame, 0.5).scale).toBeCloseTo(1 / 25);
    expect(distance(zoomViewportCamera(perspective, frame, 0.5))).toBeCloseTo(distance(perspective) / 2);
  });
});

describe('viewport scenes and standard views', () => {
  const bounds = { min: [-2, -3, 0] as [number, number, number], max: [2, 3, 4] as [number, number, number] };
  it('frames the whole model in a standard view, keeping the projection', () => {
    const top = standardViewportCamera(parallel, 'top', frame, bounds);
    expect(top.projection).toBe('parallel');
    expect(top.eye[2]).toBeGreaterThan(top.target[2]);
    for (const corner of [[-2, -3, 0], [2, 3, 4]] as const) {
      const p = viewportPaperPoint(frame, top, [...corner])!;
      expect(p[0]).toBeGreaterThanOrEqual(10); expect(p[0]).toBeLessThanOrEqual(110);
      expect(p[1]).toBeGreaterThanOrEqual(10); expect(p[1]).toBeLessThanOrEqual(60);
    }
    expect(standardViewportCamera(perspective, 'front', frame, bounds).projection).toBe('perspective');
  });

  it('starts a new view from the first scene with a camera, else an iso view', () => {
    const scenes = [
      { name: 'Tags only', camera: null, hiddenTags: [], usesTags: true },
      { name: 'Plan', camera: { eye: [0, 0, 20] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], perspective: false, fov: 35, height: 10 }, hiddenTags: [], usesTags: false },
    ];
    const { camera, scene } = initialViewportCamera(scenes, frame, bounds);
    expect(scene).toBe('Plan');
    expect(camera.scale).toBeCloseTo(50 / 1000 / 10);
    const iso = initialViewportCamera([], frame, bounds);
    expect(iso.scene).toBeNull();
    expect(iso.camera.projection).toBe('perspective');
  });
});
