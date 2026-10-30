// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, type LayoutEntity } from './LayoutDocument';
import { flattenLayoutPath, layoutPathContours, layoutPathSegmentDrawn, layoutPathSegmentIndices, pathSegment, pointInsideLayoutPath,
  removeLayoutPathVertex, splitLayoutPathSegment, validLayoutContourStarts } from './path';
import { snapPaperPoint } from './inference';
import { createLayoutCorner } from './corners';

const path: LayoutEntity = { id: 3, layerId: 1, kind: 'path', closed: true, contourStarts: [0, 4],
  points: [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10], [30, 30], [10, 30]] };

it('closes contours independently and leaves holes empty without phantom snap edges', () => {
  expect(pathSegment(path.points, undefined, 3, true, path.contourStarts).b).toEqual([0, 0]);
  expect(pathSegment(path.points, undefined, 7, true, path.contourStarts).b).toEqual([10, 10]);
  const filled = (point: [number, number]) => layoutPathContours(path.points, undefined, true, path.contourStarts)
    .filter(contour => pointInsideLayoutPath(point, contour.points)).length % 2 === 1;
  expect(filled([5, 5])).toBe(true); expect(filled([20, 20])).toBe(false);
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Fixture', draft => { const page = draft.pages.get(pageId)!; page.entities.set(path.id, path); page.entityOrder.push(path.id); });
  expect(snapPaperPoint([0, 20], doc.state.pages.get(pageId)!, doc.state, 0.1).kind).toBe('midpoint');
  expect(snapPaperPoint([5, 35], doc.state.pages.get(pageId)!, doc.state, 0.1).kind).toBeNull();
});

it('inserts, removes, and rounds vertices within a contour while maintaining all boundaries', () => {
  const split = splitLayoutPathSegment(path.points, undefined, true, 3, 0.5, path.contourStarts);
  expect(split.contourStarts).toEqual([0, 5]); expect(split.points[4]).toEqual([0, 20]);
  const removed = removeLayoutPathVertex({ ...path, ...split }, 4)!;
  expect(removed.points).toEqual(path.points); expect(removed.contourStarts).toEqual([0, 4]);
  const triangle = removeLayoutPathVertex(path, 4)!;
  expect(removeLayoutPathVertex({ ...path, ...triangle }, 4)).toBeNull();
  const rounded = createLayoutCorner(path, 4, 'fillet', 2);
  expect(rounded.points.slice(0, 4)).toEqual(path.points.slice(0, 4));
  expect(rounded.contourStarts).toEqual([0, 4]); expect(rounded.points).toHaveLength(9);
});

// A filled square with an open, L-shaped contour inside it.
const mixed: LayoutEntity = { id: 4, layerId: 1, kind: 'path', closed: true, contourStarts: [0, 4], openContours: [1],
  points: [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10], [30, 20]], style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: '#ff0000' } };

it('validates open contours, which keep two vertices, by contour number', () => {
  expect(validLayoutContourStarts(mixed.points, true, [0, 4], [1])).toBe(true);
  expect(validLayoutContourStarts([...mixed.points.slice(0, 5), [30, 10]], true, [0, 4], [1])).toBe(true);
  expect(validLayoutContourStarts([...mixed.points.slice(0, 5), [30, 10]], true, [0, 4])).toBe(false);
  expect(validLayoutContourStarts(mixed.points, true, [0, 4], [2])).toBe(false);
  expect(validLayoutContourStarts(mixed.points, true, [0, 4], [1, 1])).toBe(false);
  expect(validLayoutContourStarts(mixed.points, true, [0, 4], [])).toBe(false);
});

it('fills open contours as if closed but neither draws nor snaps to their closing segment', () => {
  expect(layoutPathSegmentIndices(mixed)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(layoutPathSegmentDrawn(7, 6, true, mixed.contourStarts, mixed.openContours)).toBe(false);
  expect(layoutPathSegmentDrawn(7, 3, true, mixed.contourStarts, mixed.openContours)).toBe(true);
  const [outer, inner] = layoutPathContours(mixed.points, undefined, true, mixed.contourStarts, mixed.openContours);
  expect(outer!.closed).toBe(true); expect(inner!.closed).toBe(false);
  expect(flattenLayoutPath(mixed.points, undefined, true, 20, mixed.contourStarts, mixed.openContours)).toHaveLength(5 + 3);
  // Even-odd over every contour closed: the open L's triangle is a hole.
  const filled = (point: [number, number]) => layoutPathContours(mixed.points, undefined, true, mixed.contourStarts)
    .filter(contour => pointInsideLayoutPath(point, contour.points)).length % 2 === 1;
  expect(filled([5, 5])).toBe(true); expect(filled([25, 15])).toBe(false);
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Fixture', draft => { const page = draft.pages.get(pageId)!; page.entities.set(mixed.id, mixed); page.entityOrder.push(mixed.id); });
  // The midpoint of the undrawn closing segment from (30, 20) back to (10, 10).
  expect(snapPaperPoint([20, 15], doc.state.pages.get(pageId)!, doc.state, 0.1).kind).toBeNull();
  expect(snapPaperPoint([20, 10], doc.state.pages.get(pageId)!, doc.state, 0.1).kind).toBe('midpoint');
});

it('edits open contours down to two vertices and rounds only their inner corners', () => {
  const line = removeLayoutPathVertex(mixed, 5)!;
  expect(line.points).toHaveLength(6); expect(line.contourStarts).toEqual([0, 4]);
  expect(removeLayoutPathVertex({ ...mixed, ...line }, 4)).toBeNull();
  const rounded = createLayoutCorner(mixed, 5, 'fillet', 2);
  expect(rounded.contourStarts).toEqual([0, 4]); expect(rounded.points.slice(0, 5)).toEqual(mixed.points.slice(0, 5));
  expect(() => createLayoutCorner(mixed, 4, 'fillet', 2)).toThrow();
});
