// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('edits native corners with style, fill, and identity intact, undo/redo, and atomic errors', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.style.setDefault', { fillColor: '#cceeff' });
  const id = commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [0, 0], second: [40, 30] }) as number;
  const source = doc.state.pages.get(pageId)!.entities.get(id)!;
  const params = { pageId, kind: 'fillet', amountMm: 5, first: { entityId: id, segmentIndex: 0 }, second: { entityId: id, segmentIndex: 1 } };
  commands.execute('layout.path.corner', params);
  expect(doc.state.pages.get(pageId)!.entities.get(id)).toMatchObject({ closed: true, style: source.style, layerId: source.layerId });
  expect(doc.state.pages.get(pageId)!.entities.size).toBe(1);
  commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.get(id)).toEqual(source);
  commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entities.get(id)!.points).toHaveLength(5);
  const before = doc.state;
  expect(() => commands.execute('layout.path.corner', { ...params, amountMm: 50 })).toThrow(); expect(doc.state).toBe(before);
  commands.execute('layout.layer.add', { name: 'Editable' });
  commands.execute('layout.layer.setLocked', { layerId: source.layerId, locked: true });
  expect(() => commands.execute('layout.path.corner', params)).toThrow('unavailable');
});

it('joins separate shared lines on the same layer and restores both with undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.layer.add', { name: 'Shared', shared: true });
  const first = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [20, 0]], closed: false }) as number;
  const second = commands.execute('layout.shape.add', { pageId, points: [[20, 0], [20, 20]], closed: false }) as number;
  commands.execute('layout.path.corner', { pageId, kind: 'chamfer', amountMm: 3,
    first: { entityId: first, segmentIndex: 0 }, second: { entityId: second, segmentIndex: 0 } });
  expect(doc.state.sharedEntities.has(second)).toBe(false);
  expect(doc.state.sharedEntities.get(first)!.points).toEqual([[0, 0], [17, 0], [20, 3], [20, 20]]);
  commands.execute('edit.undo'); expect(doc.state.sharedEntities.has(second)).toBe(true);
  commands.execute('layout.layer.add', { name: 'Other' });
  commands.execute('layout.shape.assignLayer', { pageId, entityId: second, layerId: doc.state.activeLayerId });
  expect(() => commands.execute('layout.path.corner', { pageId, kind: 'fillet', amountMm: 2,
    first: { entityId: first, segmentIndex: 0 }, second: { entityId: second, segmentIndex: 0 } })).toThrow('same layer');
});
