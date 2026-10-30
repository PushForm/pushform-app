// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { autoDimensionExtent } from './autoDimension';
import type { LayoutEntity } from './LayoutDocument';

const path = (id: number, points: [number, number][], closed = false): LayoutEntity => ({ id, kind: 'path', layerId: 1, closed, points });

it('extends a clicked segment across its own collinear joins and touching or overlapping segments of other paths', () => {
  const chain = path(1, [[10, 10], [40, 10], [70, 10], [70, 40]]);
  const touching = path(2, [[70, 10], [110, 10]]);
  const overlapping = path(3, [[100, 10], [160, 10]]);
  const separate = path(4, [[170, 10], [200, 10]]);
  const parallel = path(5, [[0, 20], [300, 20]]);
  const crossing = path(6, [[50, 0], [50, 30]]);
  const extent = autoDimensionExtent(chain, 0, [chain, touching, overlapping, separate, parallel, crossing]);
  expect(extent?.points).toEqual([[10, 10], [160, 10]]);
  expect(extent?.anchors).toEqual([{ entityId: 1, pointIndex: 0, pointCount: 4 }, { entityId: 3, pointIndex: 1, pointCount: 2 }]);
  // Clicking the vertical leg measures only that leg: nothing else lies on its line.
  expect(autoDimensionExtent(chain, 2, [chain, touching, overlapping])?.points).toEqual([[70, 10], [70, 40]]);
  // Isolated collinear segments with a gap are not coincident.
  expect(autoDimensionExtent(separate, 0, [chain, touching, overlapping, separate])?.points).toEqual([[170, 10], [200, 10]]);
});

it('handles reversed directions, closed paths, and rejects curves and degenerate segments', () => {
  const reversed = path(7, [[90, 50], [30, 50]]);
  const square = path(8, [[30, 50], [0, 50], [0, 80], [30, 80]], true);
  const extent = autoDimensionExtent(square, 0, [square, reversed]);
  expect(extent?.points).toEqual([[90, 50], [0, 50]]);
  expect(extent?.anchors).toEqual([{ entityId: 7, pointIndex: 0, pointCount: 2 }, { entityId: 8, pointIndex: 1, pointCount: 4 }]);
  const curved: LayoutEntity = { ...path(9, [[0, 0], [50, 0]]), handles: [{ out: [10, 20] }, {}] };
  expect(autoDimensionExtent(curved, 0, [curved])).toBeNull();
  expect(autoDimensionExtent(path(10, [[5, 5], [5, 5]]), 0, [])).toBeNull();
  expect(autoDimensionExtent(path(11, [[0, 0], [5, 0]]), 1, [])).toBeNull();
});
