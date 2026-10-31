// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { CameraState } from '@pushform/commands';
import { v3normalize, v3sub } from '@pushform/core';
import { cameraBasis, cameraDistance, cameraStandardView, DEFAULT_CAMERA } from '@pushform/render';
import { NAV_CUBE_REGIONS, navCubeFill, navCubePicture, navCubeRegion, navCubeTurn, navCubeView } from './navCube';

const dirOf = (s: CameraState) => v3normalize(v3sub(s.target, s.eye));
const close = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-9);

describe('navigation cube regions', () => {
  it('offers 6 faces, 12 edges and 8 corners named sides first, then Top or Bottom', () => {
    const kinds = { face: 0, edge: 0, corner: 0 };
    for (const r of NAV_CUBE_REGIONS) kinds[r.kind]++;
    expect(kinds).toEqual({ face: 6, edge: 12, corner: 8 });
    expect(navCubeRegion('front+right+top')?.label).toBe('Front Right Top');
    expect(navCubeRegion('front+top')?.label).toBe('Front Top');
    expect(navCubeRegion('top+front')).toBeUndefined();
  });

  it('draws the faces, edge bevels and hexagonal corners that face the viewer, each once, and labels the visible faces', () => {
    const iso = navCubePicture(DEFAULT_CAMERA);
    const ids = iso.cells.map((c) => c.region.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['front', 'right', 'top', 'front+right', 'front+top', 'right+top', 'front+right+top']) expect(ids).toContain(id);
    for (const id of ['back', 'left', 'bottom', 'back+left+bottom']) expect(ids).not.toContain(id);
    expect(iso.labels.map((l) => l.text).sort()).toEqual(['FRONT', 'RIGHT', 'TOP']);
    // Far polygons come first so nearer ones paint over them.
    expect(iso.cells.map((c) => c.depth)).toEqual([...iso.cells.map((c) => c.depth)].sort((a, b) => a - b));
    // Straight on: the face, its four edge bevels and four corner bevels, all of them Front's.
    const front = navCubePicture(cameraStandardView(DEFAULT_CAMERA, 'front'));
    expect(front.cells).toHaveLength(9);
    expect(front.cells.every((c) => c.region.faces.some((f) => f.id === 'front'))).toBe(true);
    // Corner cuts trim the face to an octagon; corners are hexagons and edge bevels rectangles.
    const face = front.cells.find((c) => c.region.id === 'front')!;
    expect(face.points).toHaveLength(8);
    expect(face.light).toBeGreaterThan(0.6);
    expect(front.cells.find((c) => c.region.id === 'front+right+top')!.points).toHaveLength(6);
    expect(front.cells.find((c) => c.region.id === 'front+top')!.points).toHaveLength(4);
    // The corner hexagon is a real target: wider than a fifth of the face.
    const width = (pts: readonly (readonly [number, number])[]) => Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    expect(width(front.cells.find((c) => c.region.id === 'front+right+top')!.points)).toBeGreaterThan(width(face.points) / 5);
    // Seen straight on, the Front label reads left to right and upright (y down in label space).
    const m = front.labels[0]!.matrix;
    expect(m[0]).toBeCloseTo(1, 9);
    expect(m[1]).toBeCloseTo(0, 9);
    expect(m[3]).toBeCloseTo(1, 9);
    // The triad: from the front, red points right, blue up and green away (no screen extent).
    const ax = Object.fromEntries(front.axes.map((a) => [a.axis, [a.dx, a.dy]]));
    expect(ax['x']![0]).toBeCloseTo(1, 9);
    expect(ax['z']![1]).toBeCloseTo(-1, 9);
    expect(Math.hypot(...(ax['y'] as [number, number]))).toBeCloseTo(0, 9);
  });

  it('shades regions by their lighting and highlights the hovered one', () => {
    expect(navCubeFill(1, false)).toBe('rgb(228, 233, 240)');
    expect(navCubeFill(0, false)).toBe('rgb(155, 158, 163)');
    expect(navCubeFill(1, true)).toBe('rgb(160, 214, 255)');
  });
});

describe('navigation cube views', () => {
  it('looks at a face along its inward normal, keeping the target and distance, with Z up', () => {
    const v = navCubeView(DEFAULT_CAMERA, navCubeRegion('front')!);
    expect(close(dirOf(v), [0, 1, 0])).toBe(true);
    expect(v.target).toEqual(DEFAULT_CAMERA.target);
    expect(cameraDistance(v)).toBeCloseTo(cameraDistance(DEFAULT_CAMERA), 9);
    expect(v.up).toEqual([0, 0, 1]);
    expect(v.projection).toBe(DEFAULT_CAMERA.projection);
    expect(close(dirOf(navCubeView(DEFAULT_CAMERA, navCubeRegion('right')!)), [-1, 0, 0])).toBe(true);
    expect(close(dirOf(navCubeView(DEFAULT_CAMERA, navCubeRegion('bottom')!)), [0, 0, 1])).toBe(true);
  });

  it('looks at an edge or corner along the sum of its faces normals', () => {
    const s = Math.SQRT1_2;
    expect(close(dirOf(navCubeView(DEFAULT_CAMERA, navCubeRegion('front+right')!)), [-s, s, 0])).toBe(true);
    const c = 1 / Math.sqrt(3);
    expect(close(dirOf(navCubeView(DEFAULT_CAMERA, navCubeRegion('front+right+top')!)), [-c, c, -c])).toBe(true);
  });

  it('keeps the closest horizontal screen-up when looking straight up or down', () => {
    // From a front-ish view screen-up on the ground is +Y, so Top reads with Front at the bottom.
    const fromFront = navCubeView(DEFAULT_CAMERA, navCubeRegion('top')!);
    expect(fromFront.up).toEqual([0, 1, 0]);
    expect(close(dirOf(fromFront), [0, 0, -1])).toBe(true);
    // From a level side view screen-up has no ground component, so the far side goes to the top: the Left view looks along +X.
    const fromLeft = navCubeView(cameraStandardView(DEFAULT_CAMERA, 'left'), navCubeRegion('top')!);
    expect(fromLeft.up).toEqual([1, 0, 0]);
    const belowFromBack = navCubeView(cameraStandardView(DEFAULT_CAMERA, 'back'), navCubeRegion('bottom')!);
    expect(belowFromBack.up).toEqual([0, -1, 0]);
  });

  it('turns 45° about Z for left and right and tilts 45° for up and down, as a drag that way would, without roll', () => {
    const start = cameraStandardView(DEFAULT_CAMERA, 'front');
    const left = navCubeTurn(start, 'left');
    const d = dirOf(left);
    expect(d[2]).toBeCloseTo(0, 9);
    expect(Math.abs(Math.atan2(d[0], d[1]))).toBeCloseTo(Math.PI / 4, 9);
    const right = navCubeTurn(start, 'right');
    expect(Math.atan2(dirOf(right)[0], dirOf(right)[1])).toBeCloseTo(-Math.atan2(d[0], d[1]), 9);
    // Dragging up lowers the camera, so the view then looks upward.
    const up = navCubeTurn(start, 'up');
    expect(Math.asin(dirOf(up)[2])).toBeCloseTo(Math.PI / 4, 9);
    expect(Math.asin(dirOf(navCubeTurn(start, 'down'))[2])).toBeCloseTo(-Math.PI / 4, 9);
    expect(up.up).toEqual([0, 0, 1]);
    expect(cameraDistance(up)).toBeCloseTo(cameraDistance(start), 9);
    expect(up.target).toEqual(start.target);
    expect(cameraBasis(up).right).toEqual(cameraBasis(start).right);
  });
});
