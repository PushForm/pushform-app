// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { angularDimensionGeometry, createLayoutDocument, formatAngularDimension } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('tracks angular anchors and caches detached values through undo and page duplication', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [50, 20], [20, 50]] }) as number;
  const id = commands.execute('layout.dimension.addAngular', { pageId,
    points: [[20, 20], [50, 20], [20, 50], [40, 40]],
    anchors: [0, 1, 2].map((pointIndex) => ({ entityId: sourceId, pointIndex, pointCount: 3 })),
  }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  expect(entity().angularDimension!.cachedAngleDeg).toBeCloseTo(90);
  expect(angularDimensionGeometry(entity()).sweep).toBeCloseTo(Math.PI / 2);
  commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, style: { reflex: true } });
  expect(formatAngularDimension(entity().angularDimension!)).toBe('270.0°');
  commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, style: { units: 'radians', precision: 3 } });
  expect(formatAngularDimension(entity().angularDimension!)).toBe('4.712 rad');
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[20, 20], [50, 20], [50, 50]] });
  expect(entity().angularDimension!.cachedAngleDeg).toBeCloseTo(315);
  const copyId = commands.execute('layout.page.duplicate', { pageId }) as number;
  const copy = doc.state.pages.get(copyId)!;
  const copyDim = [...copy.entities.values()].find((e) => e.angularDimension)!;
  expect(copyDim.angularDimension!.anchors[0]!.entityId).not.toBe(sourceId);
  commands.execute('layout.shape.delete', { pageId, entityId: sourceId });
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 315 });
  commands.execute('edit.undo');
  expect(entity().angularDimension!.detached).toBe(false);
  commands.execute('layout.shape.move', { pageId, entityId: id, delta: [0, 5] });
  expect(entity().points).toEqual([[20, 20], [50, 20], [50, 50], [40, 45]]);
  expect(() => commands.execute('layout.dimension.addAngular', { pageId, points: [[0, 0], [0, 0], [10, 10], [5, 5]] })).toThrow('away from the vertex');
});

it('rejects invalid angular geometry atomically and validates the actual associated points', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const invalid = [
    [[20, 20], [20, 20], [20, 60], [30, 30]],
    [[20, 20], [60, 20], [40, 20], [30, 30]],
    [[20, 20], [60, 20], [20, 60], [20.1, 20.1]],
  ];
  for (const points of invalid) {
    const before = doc.state;
    expect(() => commands.execute('layout.dimension.addAngular', { pageId, points })).toThrow();
    expect(doc.state).toBe(before);
  }
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [60, 20], [40, 20]] }) as number;
  const before = doc.state;
  expect(() => commands.execute('layout.dimension.addAngular', { pageId,
    points: [[20, 20], [60, 20], [20, 60], [30, 30]],
    anchors: [0, 1, 2].map(pointIndex => ({ entityId: sourceId, pointIndex, pointCount: 3 })),
  })).toThrow('distinct rays');
  expect(doc.state).toBe(before);
});

it('keeps the last valid angle when source rays collapse and restores it through undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [60, 20], [20, 60]] }) as number;
  const id = commands.execute('layout.dimension.addAngular', { pageId,
    points: [[20, 20], [60, 20], [20, 60], [40, 40]],
    anchors: [0, 1, 2].map(pointIndex => ({ entityId: sourceId, pointIndex, pointCount: 3 })),
  }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  const original = entity();
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[20, 20], [60, 20], [40, 20]] });
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 90 });
  expect(entity().points).toEqual(original.points);
  commands.execute('edit.undo'); expect(entity()).toEqual(original);
  const before = doc.state;
  expect(() => commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, placement: [20, 20] })).toThrow('0.5 mm');
  expect(doc.state).toBe(before);
});

it('keeps a detached annotation’s retained value consistent with its editable minor/reflex arc', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [60, 20], [20, 60]] }) as number;
  const id = commands.execute('layout.dimension.addAngular', { pageId,
    points: [[20, 20], [60, 20], [20, 60], [40, 40]],
    anchors: [0, 1, 2].map(pointIndex => ({ entityId: sourceId, pointIndex, pointCount: 3 })),
  }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  commands.execute('layout.shape.delete', { pageId, entityId: sourceId });
  commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, style: { reflex: true } });
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 270 });
  expect(Math.abs(angularDimensionGeometry(entity()).sweep)).toBeCloseTo(3 * Math.PI / 2);
  commands.execute('edit.undo');
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 90 });
});

it('associates two straight edges through movement, parallel detachment, page duplication, undo, and explicit detach', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const first = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [80, 20]] }) as number;
  const second = commands.execute('layout.shape.add', { pageId, points: [[100, 40], [100, 80]] }) as number;
  const edgeAnchors = [first, second].map((entityId, i) => ({ entityId, segmentIndex: 0, pointCount: 2, direction: i === 0 ? -1 : 1 }));
  const id = commands.execute('layout.dimension.addAngular', { pageId,
    points: [[0, 0], [1, 0], [0, 1], [75, 45]], edgeAnchors }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  expect(entity().points.slice(0, 3)).toEqual([[100, 20], [40, 20], [100, 60]]);
  expect(entity().angularDimension?.cachedAngleDeg).toBeCloseTo(90);
  commands.execute('layout.shape.move', { pageId, entityId: id, delta: [0, 10] });
  expect(entity().points).toEqual([[100, 20], [40, 20], [100, 60], [75, 55]]);
  commands.execute('layout.shape.setPath', { pageId, entityId: second, points: [[100, 40], [140, 80]] });
  expect(entity().angularDimension?.cachedAngleDeg).toBeCloseTo(135);
  const valid = entity();
  commands.execute('layout.shape.setPath', { pageId, entityId: second, points: [[100, 40], [140, 40]] });
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 135 });
  expect(entity().points).toEqual(valid.points);
  commands.execute('edit.undo'); expect(entity()).toEqual(valid);
  const copyId = commands.execute('layout.page.duplicate', { pageId }) as number;
  const copy = doc.state.pages.get(copyId)!;
  const copiedDimension = [...copy.entities.values()].find(e => e.angularDimension)!;
  for (const edge of copiedDimension.angularDimension!.edgeAnchors!) {
    expect([first, second]).not.toContain(edge.entityId); expect(copy.entities.has(edge.entityId)).toBe(true);
  }
  commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, detach: true });
  expect(entity().angularDimension?.edgeAnchors).toBeUndefined();
  commands.execute('layout.shape.delete', { pageId, entityId: first });
  expect(entity().angularDimension).toMatchObject({ detached: false, cachedAngleDeg: 135 });
});

it('tracks four ray-point anchors, intersection and cached angle through edits, duplication, detach and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const rayPoints = [[20, 40], [80, 40], [100, 60], [100, 100]];
  const sourceId = commands.execute('layout.shape.add', { pageId, points: rayPoints }) as number;
  const id = commands.execute('layout.dimension.addAngular', { pageId, points: [[0, 0], [1, 0], [0, 1], [120, 65]],
    rayDefinition: { points: rayPoints, anchors: [0, 1, 2, 3].map(pointIndex => ({ entityId: sourceId, pointIndex, pointCount: 4 })) } }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  expect(entity().points[0]).toEqual([100, 40]);
  expect(entity().angularDimension?.cachedAngleDeg).toBeCloseTo(90);
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[20, 40], [80, 40], [100, 60], [120, 80]] });
  expect(entity().points[0]).toEqual([80, 40]);
  expect(entity().angularDimension?.cachedAngleDeg).toBeCloseTo(135);
  const valid = entity();
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[20, 40], [80, 40], [100, 60], [120, 60]] });
  expect(entity().angularDimension).toMatchObject({ detached: true, cachedAngleDeg: 135 });
  expect(entity().points).toEqual(valid.points);
  commands.execute('edit.undo'); expect(entity().angularDimension?.detached).toBe(false);
  const copiedId = commands.execute('layout.page.duplicate', { pageId }) as number;
  const copied = doc.state.pages.get(copiedId)!;
  const dim = [...copied.entities.values()].find(e => e.angularDimension)!;
  expect(dim.angularDimension!.rayDefinition!.anchors.every(a => a && a.entityId !== sourceId && copied.entities.has(a.entityId))).toBe(true);
  commands.execute('layout.shape.move', { pageId, entityId: id, delta: [10, 5] });
  expect(entity().points.slice(0, 3)).toEqual(valid.points.slice(0, 3));
  expect(entity().points[3]).toEqual([130, 70]);
  commands.execute('layout.dimension.updateAngular', { pageId, entityId: id, detach: true });
  expect(entity().angularDimension?.rayDefinition).toBeUndefined();
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [10, 10] });
  expect(entity().points[0]).toEqual([80, 40]);
  const before = doc.state;
  expect(() => commands.execute('layout.dimension.addAngular', { pageId, points: [[0, 0], [1, 0], [0, 1], [5, 5]],
    rayDefinition: { points: [[0, 0], [10, 0], [0, 10], [10, 10]], anchors: [null, null, null, null] } })).toThrow('nonparallel');
  expect(doc.state).toBe(before);
});
