// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, entitiesForLayer, isLayoutLayerVisible, snapPaperPoint, entitiesInSelectionBox } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('applies page visibility to shared selection/snaps and preserves independent overrides through duplication and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), first = doc.state.pageOrder[0]!;
  const layerId = doc.state.activeLayerId;
  commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: true });
  const entityId = commands.execute('layout.shape.add', { pageId: first, points: [[10, 10], [50, 10]] }) as number;
  const second = commands.execute('layout.page.add', {}) as number;
  commands.execute('layout.layer.setVisible', { pageId: first, layerId, visible: false });
  const hidden = () => doc.state.pages.get(first)!;
  expect(entitiesForLayer(hidden(), doc.state, layerId)).toEqual([]);
  expect(entitiesForLayer(doc.state.pages.get(second)!, doc.state, layerId)).toHaveLength(1);
  expect(snapPaperPoint([10, 10], hidden(), doc.state, 0.1).kind).toBeNull();
  expect(entitiesInSelectionBox([0, 0], [60, 60], hidden(), doc.state)).toEqual([]);
  expect(() => commands.execute('layout.shape.move', { pageId: first, entityId, delta: [1, 1] })).toThrow('unavailable');
  const copy = commands.execute('layout.page.duplicate', { pageId: first }) as number;
  expect(isLayoutLayerVisible(doc.state.pages.get(copy)!, doc.state, layerId)).toBe(false);
  commands.execute('layout.layer.setVisible', { pageId: copy, layerId, visible: true });
  expect(isLayoutLayerVisible(hidden(), doc.state, layerId)).toBe(false);
  commands.execute('edit.undo');
  expect(isLayoutLayerVisible(doc.state.pages.get(copy)!, doc.state, layerId)).toBe(false);
  expect(doc.state.sharedEntities.size).toBe(1);
});

it('retains compound boundaries through transforms, copying, page duplication, vertex edits, and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const [entityId] = commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true, contourStarts: [0, 4],
    points: [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10], [30, 30], [10, 30]] }] }) as number[];
  const entity = () => doc.state.pages.get(pageId)!.entities.get(entityId!)!;
  const initial = entity().points;
  commands.execute('layout.shape.move', { pageId, entityId, delta: [10, 10] });
  commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90 });
  commands.execute('layout.shape.scale', { pageId, entityId, scaleX: 2, scaleY: 2 });
  expect(entity().contourStarts).toEqual([0, 4]); expect(entity().points).toHaveLength(8);
  const duplicate = commands.execute('layout.page.duplicate', { pageId }) as number;
  expect([...doc.state.pages.get(duplicate)!.entities.values()][0]!.contourStarts).toEqual([0, 4]);
  commands.execute('edit.undo'); commands.execute('edit.undo'); commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(entity().points).toEqual(initial);
  expect(() => commands.execute('layout.shape.setPath', { pageId, entityId, points: initial.slice(1) })).toThrow('boundaries');
  expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [{ ...entity(), contourStarts: [0, 3, 2] }] })).toThrow();
});

it('retains open contours through transforms, copying, page duplication, and vertex edits', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const points: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10], [30, 20]];
  const [entityId] = commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true, contourStarts: [0, 4],
    openContours: [1], points }] }) as number[];
  const entity = () => doc.state.pages.get(pageId)!.entities.get(entityId!)!;
  commands.execute('layout.shape.move', { pageId, entityId, delta: [10, 10] });
  commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90 });
  expect(entity().openContours).toEqual([1]);
  const duplicate = commands.execute('layout.page.duplicate', { pageId }) as number;
  expect([...doc.state.pages.get(duplicate)!.entities.values()][0]!.openContours).toEqual([1]);
  // The open contour may shrink to two vertices, but no further.
  commands.execute('layout.shape.setPath', { pageId, entityId, points: entity().points.slice(0, 6), contourStarts: [0, 4] });
  expect(entity().openContours).toEqual([1]);
  expect(() => commands.execute('layout.shape.setPath', { pageId, entityId, points: entity().points.slice(0, 5), contourStarts: [0, 4] })).toThrow('boundaries');
  expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true, contourStarts: [0, 4], openContours: [2], points }] })).toThrow();
  expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true, openContours: [0], points }] })).toThrow();
});
