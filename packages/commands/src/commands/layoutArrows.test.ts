// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

const arrow = { type: 'open-triangle', sizePt: 6 } as const;

it('sets and removes a line\'s arrows, keeping them through edits, copies and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const entityId = commands.execute('layout.shape.add', { pageId, points: [[10, 20], [90, 20]] }) as number;
  const source = () => doc.state.pages.get(pageId)!.entities.get(entityId)!;
  commands.execute('layout.shape.setStyle', { pageId, entityId, startArrow: arrow, endArrow: { type: 'filled-circle', sizePt: 3 } });
  commands.execute('layout.shape.move', { pageId, entityId, delta: [5, 5] });
  commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90 });
  commands.execute('layout.shape.setStyle', { pageId, entityId, strokeColor: '#ff0000' });
  expect(source().style).toMatchObject({ startArrow: arrow, endArrow: { type: 'filled-circle', sizePt: 3 } });
  const [copy] = commands.execute('layout.clipboard.paste', { pageId, entities: [source()] }) as number[];
  expect(doc.state.pages.get(pageId)!.entities.get(copy!)!.style?.startArrow).toEqual(arrow);
  commands.execute('layout.shape.setStyle', { pageId, entityId, startArrow: null });
  expect(source().style?.startArrow).toBeUndefined();
  expect(source().style?.endArrow).toEqual({ type: 'filled-circle', sizePt: 3 });
  commands.execute('edit.undo'); expect(source().style?.startArrow).toEqual(arrow);
  expect(() => commands.execute('layout.shape.setStyle', { pageId, entityId, startArrow: { type: 'banner', sizePt: 4 } })).toThrow();
  expect(() => commands.execute('layout.shape.setStyle', { pageId, entityId, endArrow: { type: 'star', sizePt: 0 } })).toThrow();
});

it('gives the default arrows to new open shapes only', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.style.setDefault', { endArrow: arrow });
  const entity = (id: number) => doc.state.pages.get(pageId)!.entities.get(id)!;
  const line = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [50, 0]] }) as number;
  expect(entity(line).style?.endArrow).toEqual(arrow);
  const rectangle = commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [0, 10], second: [40, 30] }) as number;
  const closed = commands.execute('layout.shape.add', { pageId, points: [[0, 40], [20, 40], [10, 50]], closed: true }) as number;
  const table = commands.execute('layout.table.add', { pageId, first: [60, 60], second: [100, 80], rows: 2, columns: 2 }) as number;
  for (const id of [rectangle, closed, table]) expect(entity(id).style?.endArrow).toBeUndefined();
  commands.execute('layout.style.setDefault', { endArrow: null });
  expect(doc.state.defaultStyle.endArrow).toBeUndefined();
});

it('keeps each free end\'s arrow when lines join, and carries an extended end\'s arrow to the new tip', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const entities = () => [...doc.state.pages.get(pageId)!.entities.values()];
  const id = commands.execute('layout.path.addLine', { pageId, start: [0, 0], end: [10, 0] }) as number;
  commands.execute('layout.shape.setStyle', { pageId, entityId: id, startArrow: arrow, endArrow: { type: 'filled-triangle', sizePt: 4 } });
  // Drawing on from the end (10, 0) extends the same line; its end arrow moves to the new tip.
  commands.execute('layout.path.addLine', { pageId, start: [10, 0], end: [20, 5] });
  expect(entities()).toHaveLength(1);
  const [line] = entities();
  expect(line!.points).toEqual([[0, 0], [10, 0], [20, 5]]);
  expect(line!.style).toMatchObject({ startArrow: arrow, endArrow: { type: 'filled-triangle', sizePt: 4 } });
  // Extending from the start reverses nothing the user sees: the start arrow stays at the start.
  commands.execute('layout.path.addLine', { pageId, start: [-10, 0], end: [0, 0] });
  expect(entities()[0]!.points[0]).toEqual([-10, 0]);
  expect(entities()[0]!.style?.startArrow).toEqual(arrow);
  // Joined into a loop, the path has no ends and no arrows.
  commands.execute('layout.path.addLine', { pageId, start: [20, 5], end: [-10, 0] });
  expect(entities()[0]!.closed).toBe(true);
  expect(entities()[0]!.style?.startArrow).toBeUndefined();
  expect(entities()[0]!.style?.endArrow).toBeUndefined();
});
