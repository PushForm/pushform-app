// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocumentState, type LayoutDocumentState, type LayoutEntity } from './LayoutDocument';
import { layoutAnchorOnPath, layoutPathAnchorAt, layoutSegmentAnchorFrame } from './anchors';
import { createLinearDimension, dimensionAnchorAt, refreshLayoutDimensions, resolveLayoutDimension } from './dimensions';
import { labelAnchorAt, resolveLayoutLabelAnchor } from './labels';
import { addLayoutLine } from './line';

type Point = [number, number];
const path = (id: number, points: Point[], extra: Partial<LayoutEntity> = {}): LayoutEntity => ({ id, kind: 'path', layerId: 1, points, closed: false, ...extra });
// One cubic from (100, 10) to (160, 10), bulging down the page; its point at t = 0.5 is (130, 32.5).
const cubic = path(2, [[100, 10], [160, 10]], { handles: [{ out: [110, 40] }, { in: [150, 40] }] });

describe('anchors along a path segment', () => {
  it('finds a vertex first, then the segment and curve parameter a point lies on', () => {
    const line = path(1, [[10, 10], [60, 10], [60, 40]]);
    expect(layoutPathAnchorAt(line, [60, 10])).toEqual({ entityId: 1, pointIndex: 1, pointCount: 3 });
    expect(layoutPathAnchorAt(line, [20, 10])).toEqual({ entityId: 1, pointIndex: 0, pointCount: 3, t: 0.2 });
    expect(layoutPathAnchorAt(line, [60, 25])).toEqual({ entityId: 1, pointIndex: 1, pointCount: 3, t: 0.5 });
    expect(layoutPathAnchorAt(line, [20, 11])).toBeNull();
    const onCurve = layoutPathAnchorAt(cubic, [130, 32.5])!;
    expect(onCurve).toMatchObject({ entityId: 2, pointIndex: 0, pointCount: 2 });
    expect(onCurve.t).toBeCloseTo(0.5, 6);
    // A closed path's closing segment counts; an open path has none.
    const square = path(3, [[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    expect(layoutPathAnchorAt(square, [0, 5])).toEqual({ entityId: 3, pointIndex: 3, pointCount: 4, t: 0.5 });
    expect(layoutPathAnchorAt({ ...square, closed: false }, [0, 5])).toBeNull();
  });

  it('resolves the point on the segment as the path changes, and nothing once its vertex count changes', () => {
    const anchor = { entityId: 2, pointIndex: 0, pointCount: 2, t: 0.5 };
    expect(layoutAnchorOnPath(cubic, anchor)).toEqual([130, 32.5]);
    const moved = { ...cubic, points: cubic.points.map(([x, y]): Point => [x * 2, y * 2]), handles: [{ out: [220, 80] as Point }, { in: [300, 80] as Point }] };
    expect(layoutAnchorOnPath(moved, anchor)).toEqual([260, 65]);
    expect(layoutAnchorOnPath({ ...cubic, points: [...cubic.points, [200, 10]] }, anchor)).toBeUndefined();
    const frame = layoutSegmentAnchorFrame(cubic, anchor)!;
    expect(frame).toMatchObject({ point: [130, 32.5], tangent: [1, 0], curved: true });
    expect(layoutSegmentAnchorFrame(path(1, [[10, 10], [60, 10], [60, 40]]), { entityId: 1, pointIndex: 1, pointCount: 3, t: 0.5 })).toMatchObject({ tangent: [0, 1], curved: false });
  });
});

function documentWith(...entities: LayoutEntity[]): LayoutDocumentState {
  const state = createLayoutDocumentState();
  const page = state.pages.get(state.pageOrder[0]!)!;
  for (const entity of entities) {
    const e = { ...entity, layerId: state.activeLayerId };
    page.entities.set(e.id, e);
    page.entityOrder.push(e.id);
  }
  state.meta.nextId = 100;
  return state;
}

describe('dimensions and labels attached along a segment follow it', () => {
  it('lets the Dimension and Label tools attach to a point on a segment and keeps it there as the path is edited', () => {
    const state = documentWith(path(1, [[10, 10], [60, 10], [60, 40]]));
    const page = state.pages.get(state.pageOrder[0]!)!;
    // A vertex anywhere wins over a segment.
    expect(dimensionAnchorAt([60, 10], page, state)).toEqual({ entityId: 1, pointIndex: 1, pointCount: 3 });
    const start = dimensionAnchorAt([20, 10], page, state)!, end = dimensionAnchorAt([60, 25], page, state)!;
    expect(start).toEqual({ entityId: 1, pointIndex: 0, pointCount: 3, t: 0.2 });
    expect(labelAnchorAt([60, 25], page, state)).toEqual(end);
    page.entities.set(10, { id: 10, kind: 'dimension', layerId: state.activeLayerId, points: [[20, 10], [60, 25], [40, 0]], closed: false,
      dimension: { ...createLinearDimension(), anchors: [start, end] } });
    page.entityOrder.push(10);
    // Stretch the path: the ends stay at the same fractions of their segments.
    page.entities.get(1)!.points = [[10, 10], [110, 10], [110, 70]];
    refreshLayoutDimensions(state);
    const dim = page.entities.get(10)!;
    expect(dim.points.slice(0, 2)).toEqual([[30, 10], [110, 40]]);
    expect(resolveLayoutDimension(dim, (id) => page.entities.get(id))!.value).toBeCloseTo(Math.hypot(80, 30), 9);
    expect(dim.dimension!.detached).toBe(false);
  });

  it('points a label at a point along a curve', () => {
    const label: LayoutEntity = { id: 5, kind: 'label', layerId: 1, points: [[180, 60], [200, 66], [130, 32.5]], closed: false,
      labelAnchor: { entityId: 2, pointIndex: 0, pointCount: 2, t: 0.5 },
      text: { content: 'Arc', fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false,
        align: 'left', vertical: 'middle', bounded: false, leader: 'straight', endpoint: 'arrow' } };
    const lifted = { ...cubic, points: cubic.points.map(([x, y]): Point => [x, y - 10]), handles: [{ out: [110, 30] as Point }, { in: [150, 30] as Point }] };
    expect(resolveLayoutLabelAnchor(label, () => lifted)).toEqual([130, 22.5]);
  });

  it('keeps a point along a segment where it was when lines are joined, also when the path turns around', () => {
    const state = documentWith(path(1, [[10, 10], [60, 10]]));
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(10, { id: 10, kind: 'dimension', layerId: state.activeLayerId, points: [[20, 10], [60, 10], [40, 0]], closed: false,
      dimension: { ...createLinearDimension(), anchors: [{ entityId: 1, pointIndex: 0, pointCount: 2, t: 0.2 }, null] } });
    page.entityOrder.push(10);
    // A new line from the path's first point: the joined path runs from the new point, so the old segment turns around.
    const joined = addLayoutLine(state, page.id, [10, 10], [10, 50]);
    const anchor = page.entities.get(10)!.dimension!.anchors[0]!;
    const entity = page.entities.get(joined)!;
    expect(layoutAnchorOnPath(entity, anchor)).toEqual([20, 10]);
    expect(anchor.t).toBeCloseTo(0.8, 12);
  });
});
