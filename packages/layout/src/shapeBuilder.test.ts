// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutShapeRegions, layoutShapeRegionsAlong, retainLayoutShapeOpenSource } from './booleans';
import { replayLayoutShapeBuild } from './shapeBuilder';
import { createLayoutEllipse } from './ellipses';
import type { LayoutEntity } from './LayoutDocument';

const box = (x: number, y: number, w = 10, h = 10): LayoutEntity => ({
  id: 1, layerId: 1, kind: 'path', closed: true, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
});
it('partitions the full selection and joins regions equivalently through successive clicks or a drag', () => {
  const regions = createLayoutShapeRegions([box(0, 0), box(5, 0)]);
  expect(regions).toHaveLength(3);
  const left = layoutShapeRegionsAlong(regions, [2, 5], [2, 5]);
  const right = layoutShapeRegionsAlong(regions, [12, 5], [12, 5]);
  const gestures = [{ mode: 'add' as const, regions: left }, { mode: 'add' as const, regions: right }];
  expect(replayLayoutShapeBuild(regions, gestures).groups).toHaveLength(2);
  const swept = layoutShapeRegionsAlong(regions, [-1, 5], [16, 5]);
  expect(swept).toHaveLength(3);
  const result = replayLayoutShapeBuild(regions, [...gestures, { mode: 'add', regions: swept }]);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]!.shape.points).toContainEqual([15, 10]);
  expect(result.sourceIndex).toBe(0);
  const clicked = replayLayoutShapeBuild(regions, swept.map(key => ({ mode: 'add', regions: [key] })));
  expect(clicked.groups).toHaveLength(1);
  const actual = clicked.groups[0]!.shape.points, expected = result.groups[0]!.shape.points;
  const start = actual.findIndex(point => point[0] === expected[0]![0] && point[1] === expected[0]![1]);
  expect([...actual.slice(start), ...actual.slice(0, start)]).toEqual(expected);
  // Clicking the middle region bridges the two separately kept crescents.
  expect(replayLayoutShapeBuild(regions, [...gestures, { mode: 'add', regions: [swept[1]!] }]).groups).toHaveLength(1);
  expect(replayLayoutShapeBuild(regions, swept.slice(0, 2).map(key => ({ mode: 'add', regions: [key] }))).groups).toHaveLength(1);
});
it('uses the first region donor across separate gestures, removal and splitting', () => {
  const regions = createLayoutShapeRegions([box(0, 0), box(4, 0, 2)]);
  const strip = layoutShapeRegionsAlong(regions, [5, 5], [5, 5]);
  const result = replayLayoutShapeBuild(regions, [
    { mode: 'add', regions: strip },
    { mode: 'add', regions: layoutShapeRegionsAlong(regions, [1, 5], [9, 5]) },
    { mode: 'remove', regions: strip },
  ]);
  expect(result.sourceIndex).toBe(1);
  expect(result.groups).toHaveLength(2);
  expect(result.removed).toEqual(strip);
  expect(replayLayoutShapeBuild(regions, []).sourceIndex).toBeNull();
});
it('preserves holes and exact curve handles in a lens and merged circles', () => {
  const circles = [0, 10].map(x => ({ ...box(0, 0), ...createLayoutEllipse([x, 0], 10, 10) }));
  const regions = createLayoutShapeRegions(circles);
  expect(regions).toHaveLength(3);
  const lens = layoutShapeRegionsAlong(regions, [5, 0], [5, 0]);
  const result = replayLayoutShapeBuild(regions, [{ mode: 'add', regions: lens }]);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]!.shape.handles?.some(h => h.in || h.out)).toBe(true);
  expect(result.groups[0]!.shape.points.length).toBeLessThan(12);
  const all = replayLayoutShapeBuild(regions, [{ mode: 'add', regions: layoutShapeRegionsAlong(regions, [-9, 0], [19, 0]) }]);
  expect(all.groups).toHaveLength(1);
  expect(all.groups[0]!.shape.handles?.some(h => h.in || h.out)).toBe(true);
  const nested = createLayoutShapeRegions([box(0, 0, 30, 30), box(10, 10)]);
  const ring = replayLayoutShapeBuild(nested, [{ mode: 'add', regions: layoutShapeRegionsAlong(nested, [5, 5], [5, 5]) }]);
  expect(ring.groups[0]!.shape.contourStarts).toHaveLength(2);
});
it('handles self intersections, coincident outlines, holes and point contacts', () => {
  const bow = { ...box(0, 0), points: [[0, 0], [10, 10], [0, 10], [10, 0]] as [number, number][] };
  expect(createLayoutShapeRegions([bow])).toHaveLength(2);
  expect(createLayoutShapeRegions([box(0, 0), box(0, 0)])).toHaveLength(1);
  const touching = createLayoutShapeRegions([box(0, 0), box(10, 10)]);
  expect(replayLayoutShapeBuild(touching, [{ mode: 'add', regions: touching.map(r => r.key) }]).groups).toHaveLength(2);
  const hole = { ...box(0, 0, 30, 30), points: [...box(0, 0, 30, 30).points, ...box(10, 10).points], contourStarts: [0, 4] };
  const regions = createLayoutShapeRegions([hole]);
  expect(regions).toHaveLength(1);
  expect(layoutShapeRegionsAlong(regions, [15, 15], [15, 15])).toEqual([]);
});
it('sweeps narrow regions in order and ignores a drag precisely along a boundary', () => {
  const regions = createLayoutShapeRegions([box(0, 0), box(5, 0, 0.01)]);
  expect(layoutShapeRegionsAlong(regions, [1, 5], [9, 5])).toHaveLength(3);
  expect(layoutShapeRegionsAlong(regions, [0, 0], [10, 0])).toEqual([]);
  expect(() => replayLayoutShapeBuild(regions, [{ mode: 'add', regions: ['stale'] }])).toThrow(/changed/);
  expect(() => createLayoutShapeRegions([{ ...box(0, 0), closed: false }])).toThrow(/enclose/);
});

it('keeps untouched regions only in deletion-only sessions and switches when an Add is made', () => {
  const regions = createLayoutShapeRegions([box(0, 0), box(5, 0)]);
  const [left, middle, right] = layoutShapeRegionsAlong(regions, [1, 5], [14, 5]);
  const remove = { mode: 'remove' as const, regions: [left!] };
  const deletionOnly = replayLayoutShapeBuild(regions, [remove]);
  expect(new Set(deletionOnly.groups.flatMap(group => group.regions))).toEqual(new Set([middle, right]));
  expect(deletionOnly.selected).toEqual([]);
  expect(deletionOnly.sourceIndex).toBeNull();
  const chosen = replayLayoutShapeBuild(regions, [remove, { mode: 'add', regions: [right!] }]);
  expect(chosen.groups.flatMap(group => group.regions)).toEqual([right]);
  expect(chosen.selected).toEqual([right]);
  expect(chosen.removed).toEqual([left]);
  expect(replayLayoutShapeBuild(regions, [remove])).toEqual(deletionOnly);
});

const line = (points: [number, number][]): LayoutEntity => ({ ...box(0, 0), closed: false, points });
it('uses open lines as cutters without implicitly closing paths or extending endpoints', () => {
  const regions = createLayoutShapeRegions([box(0, 0), line([[-5, 5], [15, 5]])]);
  expect(regions).toHaveLength(2);
  expect(regions.every(region => region.sourceIndex === 0)).toBe(true);
  expect(layoutShapeRegionsAlong(regions, [5, 2], [5, 8])).toHaveLength(2);
  expect(createLayoutShapeRegions([box(0, 0), line([[5, 5], [15, 5]])])).toHaveLength(1);
  expect(() => createLayoutShapeRegions([line([[0, 0], [10, 0], [10, 10]])])).toThrow(/enclose/);
});
it('builds regions enclosed by separate lines and keeps a deterministic boundary style donor', () => {
  const regions = createLayoutShapeRegions([
    line([[0, 0], [10, 0]]), line([[10, 0], [10, 10]]),
    line([[10, 10], [0, 10]]), line([[0, 10], [0, 0]]),
    line([[5, 0], [5, 10]]),
  ]);
  expect(regions).toHaveLength(2);
  expect(regions.every(region => region.sourceIndex === 4)).toBe(true);
  const keys = layoutShapeRegionsAlong(regions, [2, 5], [8, 5]);
  const merged = replayLayoutShapeBuild(regions, [{ mode: 'add', regions: keys }]);
  expect(merged.groups).toHaveLength(1);
  expect(merged.groups[0]!.shape.closed).toBe(true);
  const removed = replayLayoutShapeBuild(regions, [{ mode: 'remove', regions: [keys[0]!] }]);
  expect(removed.groups).toHaveLength(1);
  expect(removed.groups[0]!.regions).toEqual([keys[1]]);
});
it('preserves exact curved cutters and supports mixed open and closed contours', () => {
  const curve = { ...line([[-5, 5], [15, 5]]), handles: [{ out: [0, 0] as [number, number] }, { in: [10, 10] as [number, number] }] };
  const regions = createLayoutShapeRegions([box(0, 0), curve]);
  expect(regions).toHaveLength(2);
  expect(regions.every(region => region.shape.handles?.some(handle => handle.in || handle.out))).toBe(true);
  const compound = { ...box(0, 0), points: [...box(0, 0).points, ...curve.points],
    contourStarts: [0, 4], openContours: [1] };
  expect(createLayoutShapeRegions([compound])).toHaveLength(2);
});

it('retains open boundary originals and clips curves without adding closing spans', () => {
  const regions = createLayoutShapeRegions([box(0, 0)]);
  expect(retainLayoutShapeOpenSource(line([[0, 0], [10, 0]]), regions).unchanged).toBe(true);
  expect(retainLayoutShapeOpenSource(line([[20, 0], [30, 0]]), regions)).toEqual({ unchanged: false, shapes: [] });
  const curve = { ...line([[-5, 5], [15, 5]]), handles: [{ out: [0, 0] as [number, number] }, { in: [10, 10] as [number, number] }] };
  const retained = retainLayoutShapeOpenSource(curve, regions);
  expect(retained.unchanged).toBe(false);
  expect(retained.shapes).toHaveLength(1);
  expect(retained.shapes[0]!.closed).toBe(false);
  expect(retained.shapes[0]!.points).toHaveLength(2);
  expect(retained.shapes[0]!.handles?.some(handle => handle.in || handle.out)).toBe(true);
});
it('uses open boundaries with shape edges outside a fill while leaving unrelated holes unselectable', () => {
  const regions = createLayoutShapeRegions([box(0, 0), line([[10, 0], [20, 0], [20, 10], [10, 10]])]);
  expect(regions).toHaveLength(2);
  const right = layoutShapeRegionsAlong(regions, [15, 5], [15, 5]);
  expect(regions.find(region => region.key === right[0])!.sourceIndex).toBe(1);
  const hole = { ...box(0, 0, 30, 30), points: [...box(0, 0, 30, 30).points, ...box(10, 10).points], contourStarts: [0, 4] };
  expect(layoutShapeRegionsAlong(createLayoutShapeRegions([hole, line([[-5, 5], [35, 5]])]), [15, 15], [15, 15])).toEqual([]);
});
