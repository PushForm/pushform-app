// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  const a = commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10]] }) as number;
  const b = commands.execute('layout.shape.add', { pageId, points: [[10, 20], [30, 20]] }) as number;
  const points = (id: number) => doc.state.pages.get(pageId)!.entities.get(id)?.points;
  return { doc, commands, pageId, a, b, points };
}

it('moves and copies several objects as one undoable step and reports the resulting ids', () => {
  const { commands, pageId, a, b, points } = setup();
  expect(commands.execute('layout.shape.move', { pageId, entityIds: [a, b], delta: [5, 5] })).toEqual([a, b]);
  expect(points(a)).toEqual([[15, 15], [35, 15]]);
  expect(points(b)).toEqual([[15, 25], [35, 25]]);
  commands.execute('edit.undo');
  expect(points(a)).toEqual([[10, 10], [30, 10]]);
  expect(points(b)).toEqual([[10, 20], [30, 20]]);
  const copies = commands.execute('layout.shape.move', { pageId, entityIds: [a, b], delta: [0, 50], copy: true }) as number[];
  expect(copies).toHaveLength(2);
  expect(points(copies[1]!)).toEqual([[10, 70], [30, 70]]);
  expect(points(a)).toEqual([[10, 10], [30, 10]]);
  commands.execute('edit.undo');
  expect(points(copies[0]!)).toBeUndefined();
  // The single-object form still returns one id.
  expect(commands.execute('layout.shape.move', { pageId, entityId: a, delta: [1, 0] })).toBe(a);
  expect(() => commands.execute('layout.shape.move', { pageId, delta: [1, 0] })).toThrow();
});

it('erases several objects as one undoable step and rejects locked members whole', () => {
  const { doc, commands, pageId, a, b, points } = setup();
  commands.execute('layout.shape.delete', { pageId, entityIds: [a, b] });
  expect(points(a)).toBeUndefined();
  expect(points(b)).toBeUndefined();
  expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([]);
  commands.execute('edit.undo');
  expect(points(a)).toBeDefined();
  expect(points(b)).toBeDefined();
  expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([a, b]);
  commands.execute('layout.layer.add', { name: 'Other' });
  commands.execute('layout.layer.setLocked', { layerId: doc.state.layerOrder[0]!, locked: true });
  expect(() => commands.execute('layout.shape.delete', { pageId, entityIds: [a, b] })).toThrow('unavailable');
  expect(points(a)).toBeDefined();
  expect(() => commands.execute('layout.shape.move', { pageId, entityIds: [a], delta: [1, 1] })).toThrow('unavailable');
});
