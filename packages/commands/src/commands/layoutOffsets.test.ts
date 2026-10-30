// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('creates an independent styled offset on the source layer with undo/redo and atomic failures', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.style.setDefault', { fillColor: '#cceeff', strokeWeightPt: 2 });
  const sourceId = commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [10, 10], second: [50, 40] }) as number;
  const source = doc.state.pages.get(pageId)!.entities.get(sourceId)!;
  const id = commands.execute('layout.path.offset', { pageId, entityId: sourceId, distanceMm: 5 }) as number;
  expect(doc.state.pages.get(pageId)!.entities.get(id)).toMatchObject({ kind: 'path', closed: true,
    layerId: source.layerId, points: [[5, 5], [55, 5], [55, 45], [5, 45]], style: source.style });
  expect(doc.state.pages.get(pageId)!.entities.get(sourceId)).toEqual(source);
  commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(false);
  commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(true);
  const before = doc.state;
  expect(() => commands.execute('layout.path.offset', { pageId, entityId: sourceId, distanceMm: -50 })).toThrow();
  expect(doc.state).toBe(before);
  commands.execute('layout.layer.add', { name: 'Editable' });
  commands.execute('layout.layer.setLocked', { layerId: source.layerId, locked: true });
  expect(() => commands.execute('layout.path.offset', { pageId, entityId: sourceId, distanceMm: 2 })).toThrow('unavailable');
});

it('keeps offsets of shared paths in shared storage even when another layer is active', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const shared = commands.execute('layout.layer.add', { name: 'Shared', shared: true }) as number;
  const sourceId = commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [10, 10], second: [50, 40] }) as number;
  commands.execute('layout.layer.add', { name: 'Other' });
  const id = commands.execute('layout.path.offset', { pageId, entityId: sourceId, distanceMm: -2 }) as number;
  expect(doc.state.sharedEntities.get(id)?.layerId).toBe(shared);
  commands.execute('layout.layer.setVisible', { layerId: shared, visible: false });
  expect(() => commands.execute('layout.path.offset', { pageId, entityId: sourceId, distanceMm: 2 })).toThrow('unavailable');
});

it.each([false, true])('places expanded offsets directly behind the source in shared=%s storage, preserving other ordering and undo', shared => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  if (shared) commands.execute('layout.layer.add', { name: 'Every page', shared: true });
  const add = (x: number) => commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [x, 10], second: [x + 20, 30] }) as number;
  const back = add(10), source = add(40), front = add(70);
  const order = () => shared ? doc.state.sharedEntityOrder : doc.state.pages.get(pageId)!.entityOrder;
  const expanded = commands.execute('layout.path.offset', { pageId, entityId: source, distanceMm: 3 }) as number;
  expect(order()).toEqual([back, expanded, source, front]);
  commands.execute('edit.undo'); expect(order()).toEqual([back, source, front]);
  commands.execute('edit.redo'); expect(order()).toEqual([back, expanded, source, front]);
  const inset = commands.execute('layout.path.offset', { pageId, entityId: source, distanceMm: -3 }) as number;
  expect(order()).toEqual([back, expanded, source, front, inset]);
});

it('expands either winding behind its source while open offsets keep their usual order', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const source = commands.execute('layout.shape.add', { pageId, points: [[10, 10], [10, 40], [50, 40], [50, 10]], closed: true }) as number;
  const outer = commands.execute('layout.path.offset', { pageId, entityId: source, distanceMm: 5 }) as number;
  expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([outer, source]);
  const line = commands.execute('layout.shape.add', { pageId, points: [[80, 10], [100, 10]] }) as number;
  const parallel = commands.execute('layout.path.offset', { pageId, entityId: line, distanceMm: 5 }) as number;
  expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([outer, source, line, parallel]);
});
