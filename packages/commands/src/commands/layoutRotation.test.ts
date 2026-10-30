// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, rotateLayoutPath } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('commits the same pivot rotation used by previews, including curve controls and shared storage', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.layer.add', { name: 'Shared', shared: true });
  commands.execute('layout.style.setDefault', { fillColor: '#cceeff' });
  const id = commands.execute('layout.rectangle.add', { pageId, kind: 'rounded-rectangle', first: [10, 10], second: [50, 40], amountMm: 5 }) as number;
  const source = doc.state.sharedEntities.get(id)!;
  const pivot: [number, number] = [15, 15], preview = rotateLayoutPath(source, pivot, -45);
  commands.execute('layout.shape.rotate', { pageId, entityId: id, pivot, angleDeg: -45 });
  expect(doc.state.sharedEntities.get(id)).toEqual({ ...source, ...preview });
  commands.execute('edit.undo'); expect(doc.state.sharedEntities.get(id)).toEqual(source);
  commands.execute('edit.redo'); expect(doc.state.sharedEntities.get(id)).toEqual({ ...source, ...preview });
  const before = doc.state;
  expect(() => commands.execute('layout.shape.rotate', { pageId, entityId: id, pivot: [Infinity, 0], angleDeg: 20 })).toThrow();
  expect(doc.state).toBe(before);
});

it('rotates text rigidly about its center or an external pivot, accumulating angles with undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const id = commands.execute('layout.text.add', { pageId, kind: 'text', points: [[10, 20], [70, 40]],
    text: { content: 'Rotating words', fontFamily: 'Arial', fontSizePt: 12, color: '#000000',
      bold: true, italic: false, underline: true, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  const original = entity();
  commands.execute('layout.shape.rotate', { pageId, entityId: id, angleDeg: 90 });
  expect(entity().points).toEqual(original.points);
  expect(entity().text).toEqual({ ...original.text, rotationDeg: 90 });
  commands.execute('layout.shape.rotate', { pageId, entityId: id, pivot: [0, 0], angleDeg: -90 });
  expect(entity().points[0]![0]).toBeCloseTo(0);
  expect(entity().points[0]![1]).toBeCloseTo(-50);
  expect(entity().points[1]![0]).toBeCloseTo(60);
  expect(entity().points[1]![1]).toBeCloseTo(-30);
  expect(entity().text).toEqual({ ...original.text, rotationDeg: 0 });
  commands.execute('edit.undo'); expect(entity().text?.rotationDeg).toBe(90);
  commands.execute('edit.undo'); expect(entity()).toEqual(original);
  commands.execute('edit.redo'); expect(entity().text?.rotationDeg).toBe(90);
});
