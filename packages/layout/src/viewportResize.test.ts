// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { resizedViewportCamera, viewportPaperPoint } from './viewports';
import type { LayoutViewportCamera } from './LayoutDocument';

type Point = [number, number];
const frame: Point[] = [[10, 20], [110, 20], [110, 120], [10, 120]];
const parallel: LayoutViewportCamera = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', scale: 0.02, fov: 35, shift: [0.1, -0.2] };

it.each(['parallel', 'perspective'] as const)('preserves paper positions and sizes through %s frame resizes, including rotated frames', projection => {
  const camera = { ...parallel, projection };
  for (const angle of [0, Math.PI / 3]) for (const sx of [1, 2]) for (const sy of [1, 2]) {
    const rotate = ([x, y]: Point): Point => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
    const before = frame.map(rotate), after = frame.map(([x, y]): Point => [10 + (x - 10) * sx, 20 + (y - 20) * sy]).map(rotate);
    const resized = resizedViewportCamera(camera, before, after);
    for (const p of [[0, 0, 0], [1, 0, 0], [0, 1, 3]] as [number, number, number][]) {
      const a = viewportPaperPoint(before, camera, p)!, b = viewportPaperPoint(after, resized, p)!;
      expect(b[0]).toBeCloseTo(a[0], 9); expect(b[1]).toBeCloseTo(a[1], 9);
    }
    expect(camera.shift).toEqual([0.1, -0.2]);
  }
});

it('matches LayOut height-based scaling when preserve scale is off and measures 1 m as 20 mm at 1:50', () => {
  const paper = ([x, y, z]: [number, number, number]) => viewportPaperPoint(frame, parallel, [x, y, z])!;
  expect(paper([1, 0, 0])[0] - paper([0, 0, 0])[0]).toBeCloseTo(20);
  const wider = frame.map(([x, y]): Point => [x * 2, y]), taller = frame.map(([x, y]): Point => [x, y * 2]);
  expect(resizedViewportCamera(parallel, frame, wider, false).scale).toBe(0.02);
  expect(resizedViewportCamera(parallel, frame, taller, false).scale).toBe(0.04);
  const perspective = { ...parallel, projection: 'perspective' as const };
  expect(resizedViewportCamera(perspective, frame, taller, false)).toBe(perspective);
});
