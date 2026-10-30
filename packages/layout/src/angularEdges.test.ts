// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { angularEdgesFromPicks, resolveAngularEdgePoints } from './angularEdges';
import { angularMeasurement } from './dimensions';
import type { LayoutEntity } from './LayoutDocument';
const line = (id: number, points: [number, number][]): LayoutEntity => ({ id, kind: 'path', layerId: 1, closed: false, points });
it('intersects extended lines and uses the clicked side to choose the rays', () => {
  const first = line(1, [[20, 20], [60, 20]]), second = line(2, [[0, 40], [0, 80]]);
  const result = angularEdgesFromPicks({ entity: first, segmentIndex: 0, point: [40, 20] }, { entity: second, segmentIndex: 0, point: [0, 60] });
  expect(result.points).toEqual([[0, 20], [40, 20], [0, 60]]);
  expect(angularMeasurement(...result.points)).toBeCloseTo(90);
  second.points = [[0, 40], [40, 80]];
  const points = resolveAngularEdgePoints(result.edges, id => id === 1 ? first : second);
  expect(points[0]).toEqual([-20, 20]);
  expect(angularMeasurement(...points)).toBeCloseTo(45);
});
it('supports adjacent edges of one closed object and preserves side choice across source movement', () => {
  const rectangle = { ...line(1, [[20, 20], [80, 20], [80, 60], [20, 60]]), closed: true };
  const result = angularEdgesFromPicks({ entity: rectangle, segmentIndex: 0, point: [50, 20] }, { entity: rectangle, segmentIndex: 1, point: [80, 40] });
  expect(result.points[0]).toEqual([80, 20]);
  expect(result.edges[0].direction).toBe(-1); expect(result.edges[1].direction).toBe(1);
  expect(angularMeasurement(...result.points)).toBeCloseTo(90);
});
it('rejects same, parallel, curved, zero-length, and unavailable edges', () => {
  const first = line(1, [[0, 0], [20, 0]]), pick = { entity: first, segmentIndex: 0, point: [10, 0] as [number, number] };
  expect(() => angularEdgesFromPicks(pick, pick)).toThrow('different second');
  for (const points of [[[0, 10], [20, 10]], [[30, 0], [40, 0]]] as [number, number][][])
    expect(() => angularEdgesFromPicks(pick, { ...pick, entity: line(2, points) })).toThrow('nonparallel');
  expect(() => angularEdgesFromPicks(pick, { ...pick, entity: line(2, [[0, 0], [0, 0]]) })).toThrow('nonzero');
  expect(() => angularEdgesFromPicks(pick, { ...pick, entity: { ...line(2, [[0, 0], [0, 20]]), handles: [{ out: [10, 10] }, {}] } })).toThrow('curve');
  const valid = angularEdgesFromPicks(pick, { ...pick, entity: line(2, [[0, 0], [0, 20]]) });
  expect(() => resolveAngularEdgePoints(valid.edges, () => undefined)).toThrow('unavailable');
});
