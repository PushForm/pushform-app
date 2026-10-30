// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocumentState } from './LayoutDocument';
import { snapPaperPoint } from './inference';

describe('paper inference', () => {
  it('snaps to the actual midpoint of a Bézier segment', () => {
    const state = createLayoutDocumentState();
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: 1,
      points: [[10, 10], [110, 10]], handles: [{ out: [10, 70] }, { in: [110, 70] }], closed: false });
    page.entityOrder.push(3);
    expect(snapPaperPoint([60.4, 55.3], page, state, 2)).toEqual({ point: [60, 55], kind: 'midpoint' });
  });

  it('snaps to endpoints, midpoints, intersections, and paths', () => {
    const state = createLayoutDocumentState();
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: 1, points: [[10, 10], [110, 10]], closed: false });
    page.entities.set(4, { id: 4, kind: 'path', layerId: 1, points: [[80, 0], [80, 60]], closed: false });
    page.entityOrder.push(3, 4);

    expect(snapPaperPoint([10.8, 10.7], page, state, 3)).toEqual({ point: [10, 10], kind: 'endpoint' });
    expect(snapPaperPoint([59.5, 10.7], page, state, 3)).toEqual({ point: [60, 10], kind: 'midpoint' });
    expect(snapPaperPoint([80.5, 10.7], page, state, 3)).toEqual({ point: [80, 10], kind: 'intersection' });
    expect(snapPaperPoint([34, 10.7], page, state, 3)).toEqual({ point: [34, 10], kind: 'on-path' });
  });

  it('uses grid when enabled and ignores hidden geometry', () => {
    const state = createLayoutDocumentState();
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: 1, points: [[11, 11], [21, 11]], closed: false });
    page.entityOrder.push(3);
    state.settings.grid.snap = true;
    state.layers.get(1)!.visible = false;
    expect(snapPaperPoint([20.7, 20.8], page, state, 2)).toEqual({ point: [20, 20], kind: 'grid' });
    expect(snapPaperPoint([5.7, 5.8], page, state, 2)).toEqual({ point: [5.7, 5.8], kind: null });
    expect(snapPaperPoint([10.7, 10.8], page, state, 2)).toEqual({ point: [10.7, 10.8], kind: null });
    expect(snapPaperPoint([20.7, 20.8], page, state, 0.5)).toEqual({ point: [20.7, 20.8], kind: null });
    state.layers.get(1)!.visible = true;
    page.entities.set(3, { id: 3, kind: 'path', layerId: 1, points: [[5, 5], [8, 5]], closed: false });
    expect(snapPaperPoint([5.5, 5.5], page, state, 2)).toEqual({ point: [5, 5], kind: 'endpoint' });
  });

  it('snaps to shared paths on every page and honors layer visibility', () => {
    const state = createLayoutDocumentState();
    state.layers.set(3, { id: 3, name: 'Title block', visible: true, locked: false, shared: true });
    state.layerOrder.push(3);
    state.sharedEntities.set(4, {
      id: 4, kind: 'path', layerId: 3, points: [[10, 20], [110, 20]], closed: false,
    });
    state.sharedEntityOrder.push(4);
    const first = state.pages.get(state.pageOrder[0]!)!;
    const second = { ...first, id: 5, entities: new Map(), entityOrder: [] };
    expect(snapPaperPoint([60.3, 20.4], first, state, 2)).toEqual({
      point: [60, 20], kind: 'midpoint',
    });
    expect(snapPaperPoint([60.3, 20.4], second, state, 2)).toEqual({
      point: [60, 20], kind: 'midpoint',
    });
    state.layers.get(3)!.visible = false;
    // With the shared layer hidden only the default grid snap remains at (60, 20).
    expect(snapPaperPoint([60.3, 20.4], second, state, 2).kind).toBe('grid');
    state.settings.grid.snap = false;
    expect(snapPaperPoint([60.3, 20.4], second, state, 2).kind).toBeNull();
  });
});

it('snaps to the rotated text box corners and edges instead of its stored diagonal', () => {
  const state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  state.settings.grid.snap = false;
  page.entities.set(3, { id: 3, kind: 'text', layerId: 1, closed: false, points: [[10, 10], [50, 30]],
    text: { content: 'Text', fontFamily: 'Arial', fontSizePt: 12, color: '#000000', bold: false, italic: false, underline: false,
      align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none', rotationDeg: 90 } });
  page.entityOrder.push(3);
  const corner = snapPaperPoint([40.2, 0.2], page, state, 1);
  expect(corner.kind).toBe('endpoint'); expect(corner.point[0]).toBeCloseTo(40); expect(corner.point[1]).toBeCloseTo(0);
  expect(snapPaperPoint([40.2, 20.2], page, state, 1)).toEqual({ point: [40, 20], kind: 'midpoint' });
  expect(snapPaperPoint([40.2, 12], page, state, 1)).toEqual({ point: [40, 12], kind: 'on-path' });
  expect(snapPaperPoint([30, 20], page, state, 1)).toEqual({ point: [30, 20], kind: 'midpoint', type: 'center' });
});

it('uses midpoint indication for entity centers, including curved paths and rotated images, and respects snap settings', () => {
  const state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  state.settings.grid.snap = true;
  page.entities.set(3, { id: 3, kind: 'path', layerId: 1, closed: true, points: [[20, 20], [80, 20], [80, 60], [20, 60]] });
  page.entityOrder.push(3);
  expect(snapPaperPoint([50.2, 40.3], page, state, 2)).toEqual({ point: [50, 40], kind: 'midpoint', type: 'center' });
  expect(snapPaperPoint([50.2, 20.3], page, state, 2)).toEqual({ point: [50, 20], kind: 'midpoint' });
  expect(snapPaperPoint([20.2, 20.3], page, state, 2)).toEqual({ point: [20, 20], kind: 'endpoint' });
  expect(snapPaperPoint([50.2, 40.3], page, state, 2, new Set([3]))).toEqual({ point: [50, 40], kind: 'grid' });
  state.settings.objectSnap = false;
  expect(snapPaperPoint([50.2, 40.3], page, state, 2)).toEqual({ point: [50, 40], kind: 'grid' });
  state.settings.grid.snap = false;
  expect(snapPaperPoint([50.2, 40.3], page, state, 2).kind).toBeNull();
  state.settings.objectSnap = true;
  page.layerVisibility = new Map([[1, false]]);
  expect(snapPaperPoint([50.2, 40.3], page, state, 2).kind).toBeNull();
  page.layerVisibility = new Map();
  page.entities.set(3, { id: 3, kind: 'image', layerId: 1, closed: true, points: [[40, 0], [40, 40], [20, 40], [20, 0]], image: { src: 'data:image/png;base64,eA==' } });
  expect(snapPaperPoint([30.2, 20.3], page, state, 2)).toEqual({ point: [30, 20], kind: 'midpoint', type: 'center' });
  page.entities.set(3, { id: 3, kind: 'path', layerId: 1, closed: false, points: [[10, 10], [110, 10]], handles: [{ out: [10, 70] }, { in: [110, 70] }] });
  expect(snapPaperPoint([60.2, 32.3], page, state, 2)).toEqual({ point: [60, 32.5], kind: 'midpoint', type: 'center' });
});

it('offers centers from visible shared entities on every page', () => {
  const state = createLayoutDocumentState(), first = state.pages.get(state.pageOrder[0]!)!;
  state.layers.set(3, { id: 3, name: 'Shared', visible: true, locked: false, shared: true }); state.layerOrder.push(3);
  state.sharedEntities.set(4, { id: 4, kind: 'path', layerId: 3, closed: true, points: [[20, 20], [80, 20], [80, 60], [20, 60]] }); state.sharedEntityOrder.push(4);
  const second = { ...first, id: 5, entities: new Map(), entityOrder: [] };
  for (const page of [first, second]) expect(snapPaperPoint([50.2, 40.3], page, state, 2)).toEqual({ point: [50, 40], kind: 'midpoint', type: 'center' });
});
