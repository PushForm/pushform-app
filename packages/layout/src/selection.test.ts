// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, type LayoutEntity } from './LayoutDocument';
import { createLinearDimension } from './dimensions';
import { entitiesInLasso, entitiesInSelectionBox, lassoIsCrossing, layoutEntityBounds } from './selection';

function populate() {
  const doc = createLayoutDocument();
  const pageId = doc.state.pageOrder[0]!, page = doc.state.pages.get(pageId)!;
  const add = (entity: Omit<LayoutEntity, 'id' | 'layerId'>): number => {
    const id = page.entityOrder.length + 1;
    page.entities.set(id, { ...entity, id, layerId: doc.state.layerOrder[0]! } as LayoutEntity);
    page.entityOrder.push(id);
    return id;
  };
  const square = add({ kind: 'path', closed: true, points: [[10, 10], [30, 10], [30, 30], [10, 30]] });
  const line = add({ kind: 'path', closed: false, points: [[25, 20], [60, 20]] });
  const far = add({ kind: 'path', closed: false, points: [[100, 100], [120, 100]] });
  const dimension = add({ kind: 'dimension', closed: false, points: [[10, 40], [30, 40], [20, 50]], dimension: createLinearDimension() });
  return { doc, page, square, line, far, dimension };
}

it('measures large straight paths without spreading anchors into function arguments', () => {
  const points: [number, number][] = Array.from({ length: 200000 }, (_, i) => [i, -i]);
  const entity: LayoutEntity = { id: 1, layerId: 1, kind: 'path', closed: false, points };
  expect(layoutEntityBounds(entity)).toEqual({ minX: 0, minY: -199999, maxX: 199999, maxY: -0 });
  expect(layoutEntityBounds({ ...entity, points: [] })).toBeNull();
});

it('selects fully enclosed objects left to right and touched objects right to left', () => {
  const { doc, page, square, line, dimension } = populate();
  const ids = (from: [number, number], to: [number, number]) => entitiesInSelectionBox(from, to, page, doc.state).map((entity) => entity.id);
  expect(ids([5, 5], [35, 35])).toEqual([square]);
  expect(ids([35, 35], [5, 5])).toEqual([square, line]);
  expect(ids([5, 5], [70, 55])).toEqual([square, line, dimension]);
  expect(ids([40, 5], [70, 35])).toEqual([]);
  expect(ids([70, 35], [40, 5])).toEqual([line]);
});

it('skips hidden layers and measures drawn extents for curves, text, and dimensions', () => {
  const { doc, page, square } = populate();
  doc.state.layers.get(doc.state.layerOrder[0]!)!.visible = false;
  expect(entitiesInSelectionBox([0, 0], [200, 200], page, doc.state)).toEqual([]);
  doc.state.layers.get(doc.state.layerOrder[0]!)!.visible = true;
  expect(layoutEntityBounds(page.entities.get(square)!)).toEqual({ minX: 10, minY: 10, maxX: 30, maxY: 30 });
  const bulged: LayoutEntity = { id: 9, kind: 'path', layerId: 1, closed: false, points: [[0, 0], [40, 0]], handles: [{ out: [10, 30] }, { in: [30, 30] }] };
  expect(layoutEntityBounds(bulged)!.maxY).toBeGreaterThan(15);
  const rotated: LayoutEntity = { id: 10, kind: 'text', layerId: 1, closed: false, points: [[0, 0], [40, 10]],
    text: { content: 'x', fontFamily: 'Arial', fontSizePt: 12, color: '#000', bold: false, italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, rotationDeg: 90, leader: 'elbow', endpoint: 'arrow' } };
  const bounds = layoutEntityBounds(rotated)!;
  expect(bounds.maxX - bounds.minX).toBeCloseTo(10);
  expect(bounds.maxY - bounds.minY).toBeCloseTo(40);
  const dimension: LayoutEntity = { id: 11, kind: 'dimension', layerId: 1, closed: false, points: [[10, 40], [30, 40], [20, 50]], dimension: createLinearDimension() };
  expect(layoutEntityBounds(dimension)).toEqual({ minX: 10, minY: 40, maxX: 30, maxY: 50 });
});

it('lasso: counterclockwise selects what it encloses, clockwise what it touches', () => {
  const { doc, page, square, line, far } = populate();
  type P = [number, number];
  const ids = (outline: P[]) => entitiesInLasso(outline, page, doc.state).map((entity) => entity.id);
  // Paper y points down, so right-then-down is clockwise as seen on the page.
  const around: P[] = [[5, 5], [5, 35], [35, 35], [35, 5]];
  expect(lassoIsCrossing(around)).toBe(false);
  expect(lassoIsCrossing([...around].reverse())).toBe(true);
  expect(ids(around)).toEqual([square]);
  expect(ids([...around].reverse())).toEqual([square, line]);
  // A notch reaching into the square between its corners: every corner is inside, but its top edge leaves the
  // outline, so a counterclockwise lasso does not enclose it; a clockwise one still touches it.
  const notched: P[] = [[5, 5], [5, 35], [35, 35], [35, 5], [22, 5], [22, 15], [18, 15], [18, 5]];
  expect(ids(notched)).toEqual([]);
  expect(ids([...notched].reverse())).toEqual([square, line]);
  // A clockwise loop inside the closed square selects it; inside nothing, it selects nothing.
  expect(ids([[12, 12], [20, 12], [20, 18], [12, 18]])).toEqual([square]);
  expect(ids([[150, 150], [160, 150], [160, 160], [150, 160]])).toEqual([]);
  expect(ids([[95, 95], [125, 95], [125, 105]])).toEqual([far]);
  expect(ids([[0, 0], [200, 200]])).toEqual([]);
});
