// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { cloneLayoutTable, createLayoutDocument, mergeTableCells, tableFrame } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('creates and edits native tables transactionally, preserves copies and persists merged cells', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const id = commands.execute('layout.table.add', { pageId, first: [70, 40], second: [10, 10], rows: 3, columns: 2 }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  let table = cloneLayoutTable(entity().table!);
  table.cells[0]!.text.content = 'Schedule'; table.cells[0]!.text.bold = true; table.cells[0]!.fillColor = '#eeeeee';
  table = mergeTableCells(table, { row: 0, column: 0 }, { row: 0, column: 1 });
  commands.execute('layout.table.update', { pageId, entityId: id, table });
  const copyId = commands.execute('layout.shape.move', { pageId, entityId: id, delta: [80, 0], copy: true }) as number;
  const duplicatedPage = commands.execute('layout.page.duplicate', { pageId }) as number;
  expect(doc.state.pages.get(duplicatedPage)!.entities.values().next().value!.table).toEqual(table);
  table.cells[0]!.text.content = 'Changed';
  commands.execute('layout.table.update', { pageId, entityId: id, table });
  expect(doc.state.pages.get(pageId)!.entities.get(copyId)!.table!.cells[0]!.text.content).toBe('Schedule');
  commands.execute('edit.undo'); expect(entity().table!.cells[0]!.text.content).toBe('Schedule');
  commands.execute('edit.redo'); expect(entity().table!.cells[0]!.text.content).toBe('Changed');
  commands.execute('layout.shape.rotate', { pageId, entityId: id, angleDeg: 30 });
  commands.execute('layout.table.update', { pageId, entityId: id, table, widthMm: 80, heightMm: 50 });
  expect(tableFrame(entity()).width).toBeCloseTo(80); expect(tableFrame(entity()).height).toBeCloseTo(50);
  const pasted = commands.execute('layout.clipboard.paste', { pageId, entities: [entity()] }) as number[];
  expect(doc.state.pages.get(pageId)!.entities.get(pasted[0]!)!.table).toEqual(table);
});

it('honors layer availability, shared storage and object locks and rejects invalid table updates atomically', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.layer.add', { name: 'Shared', shared: true });
  const id = commands.execute('layout.table.add', { pageId, first: [0, 0], second: [60, 30] }) as number;
  const table = doc.state.sharedEntities.get(id)!.table!;
  expect(table.rows).toHaveLength(3);
  const version = doc.version;
  expect(() => commands.execute('layout.table.update', { pageId, entityId: id, table: { ...table, rows: [0] } })).toThrow();
  expect(doc.version).toBe(version);
  commands.execute('layout.shape.setLocked', { pageId, entityIds: [id], locked: true });
  expect(() => commands.execute('layout.table.update', { pageId, entityId: id, table })).toThrow('locked');
  commands.execute('layout.layer.setVisible', { layerId: doc.state.activeLayerId, visible: false });
  expect(() => commands.execute('layout.table.add', { pageId, first: [0, 0], second: [60, 30] })).toThrow('unavailable');
});

it('applies a table stroke to every grid line and keeps per-line strokes otherwise', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const id = commands.execute('layout.table.add', { pageId, first: [10, 10], second: [70, 40], rows: 2, columns: 2 }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  const table = cloneLayoutTable(entity().table!);
  table.rowEdges = [{ strokeColor: '#ff0000', strokeWeightPt: 2 }]; table.columnEdges = [{ strokeColor: '#00000000', strokeWeightPt: 1 }];
  table.cells[1]!.rotationDeg = 270;
  commands.execute('layout.table.update', { pageId, entityId: id, table });
  commands.execute('layout.shape.setStyle', { pageId, entityId: id, fillColor: '#eeeeee' });
  expect(entity().table!.rowEdges).toEqual(table.rowEdges);
  commands.execute('layout.shape.setStyle', { pageId, entityId: id, strokeColor: '#0000ff' });
  expect(entity().table!.rowEdges).toBeUndefined(); expect(entity().table!.columnEdges).toBeUndefined();
  expect(entity().table!.cells[1]!.rotationDeg).toBe(270);
  commands.execute('edit.undo'); expect(entity().table!.rowEdges).toEqual(table.rowEdges);
  expect(() => commands.execute('layout.table.update', { pageId, entityId: id, table: { ...table, rowEdges: [] } })).toThrow();
});
