// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LAYOUT_DEFAULT_TEXT, createLayoutTable, editTableAxis, setTableEdge, mergeTableCells, tableCellAt, tableCellEntities, tableCells, tableGridLines, validLayoutTable, validTableFrame, rotateLayoutEntity, type LayoutEntity } from './index';

it('edits merged row and column spans without losing surviving contents', () => {
  let table = createLayoutTable(4, 3);
  table.cells.forEach((cell, i) => { cell.text.content = String(i); });
  table = mergeTableCells(table, { row: 1, column: 0 }, { row: 2, column: 1 });
  const inserted = editTableAxis(table, 'row', 2, false);
  expect(inserted.merges).toEqual([{ row: 1, column: 0, rowSpan: 3, columnSpan: 2 }]);
  expect(inserted.cells[9]!.text.content).toBe('6');
  expect(validLayoutTable(inserted)).toBe(true);
  // Deleting before a merge shifts its owner, preserving the original owner text.
  const before = editTableAxis(table, 'row', 0, true);
  expect(before.cells[0]!.text.content).toBe('3');
  // Deleting the owner's row transfers its content to the surviving merged area.
  const owner = editTableAxis(table, 'row', 1, true);
  expect(owner.cells[3]!.text.content).toBe('3');
  expect(owner.merges[0]).toMatchObject({ rowSpan: 1, columnSpan: 2 });
  const unmerged = editTableAxis(owner, 'column', 0, true);
  expect(unmerged.merges).toEqual([]);
  expect(unmerged.cells[2]!.text.content).toBe('3');
  expect(validLayoutTable(unmerged)).toBe(true);
  expect(table.cells[6]!.text.content).toBe('6');
});

it('defaults uncolored cells to white while retaining table backgrounds, cell colors and explicit transparency', () => {
  const table = createLayoutTable(1, 3);
  table.cells[1]!.fillColor = '#abcdef';
  table.cells[2]!.fillColor = null;
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'table', closed: true,
    points: [[0, 0], [60, 0], [60, 10], [0, 10]], table };
  expect(tableCells(entity).map(cell => cell.fillColor)).toEqual(['#ffffff', '#abcdef', null]);
  expect(tableCellEntities(entity).map(cell => cell.style!.fillColor)).toEqual(['#ffffff', '#abcdef', null]);
  entity.style = { strokeColor: '#000000', strokeWeightPt: 1, fillColor: '#112233' };
  expect(tableCells(entity).map(cell => cell.fillColor)).toEqual(['#112233', '#abcdef', null]);
  entity.style.fillColor = null;
  expect(tableCells(entity).map(cell => cell.fillColor)).toEqual(['#ffffff', '#abcdef', null]);
});

it('maps rotated frames and merged cells to the same local grid', () => {
  const table = mergeTableCells(createLayoutTable(2, 2), { row: 0, column: 0 }, { row: 0, column: 1 });
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'table', closed: true, points: [[10, 10], [70, 10], [70, 30], [10, 30]], table };
  const rotated = rotateLayoutEntity(entity, [10, 10], 90);
  expect(validTableFrame(rotated.points)).toBe(true);
  expect(tableCellAt(rotated, [5, 60])).toEqual({ row: 0, column: 0 });
  expect(tableCellAt(rotated, [-5, 60])).toEqual({ row: 1, column: 1 });
  expect(tableCellAt(rotated, [15, 20])).toBeNull();
  expect(tableCellEntities(rotated)).toHaveLength(3);
  expect(tableCellEntities(rotated)[0]!.points).toEqual([[0, 0], [60, 10]]);
});

it('rejects overlapping or malformed grids, partial merges, and invalid frames', () => {
  const table = mergeTableCells(createLayoutTable(2, 2), { row: 0, column: 0 }, { row: 1, column: 0 });
  expect(() => mergeTableCells(table, { row: 0, column: 0 }, { row: 0, column: 1 })).toThrow('complete merged');
  expect(validLayoutTable({ ...table, merges: [...table.merges, ...table.merges] })).toBe(false);
  expect(validLayoutTable({ ...table, cells: [] })).toBe(false);
  expect(validLayoutTable({ ...table, rows: [0, 1] })).toBe(false);
  expect(validLayoutTable({ ...table, cells: [null, null, null, null] })).toBe(false);
  expect(validTableFrame([[0, 0], [20, 0], [20, 10], [1, 10]])).toBe(false);
  expect(() => editTableAxis(createLayoutTable(1, 1), 'row', 0, true)).toThrow('1–100');
});

it('keeps per-line strokes in step with inserted and deleted rows and columns', () => {
  const table = createLayoutTable(3, 2);
  const red = { strokeColor: '#ff0000', strokeWeightPt: 2 }, blue = { strokeColor: '#0000ff', strokeWeightPt: 1 };
  table.rowEdges = [red, blue]; table.columnEdges = [{ strokeColor: '#00000000', strokeWeightPt: 1 }];
  expect(validLayoutTable(table)).toBe(true);
  expect(editTableAxis(table, 'row', 0, false).rowEdges).toEqual([red, red, blue]);
  expect(editTableAxis(table, 'row', 3, false).rowEdges).toEqual([red, blue, blue]);
  expect(editTableAxis(table, 'row', 0, true).rowEdges).toEqual([blue]);
  expect(editTableAxis(table, 'row', 2, true).rowEdges).toEqual([red]);
  expect(editTableAxis(table, 'column', 1, true).columnEdges).toEqual([]);
  // A one-column table has no line to copy, so its new line uses the table's stroke.
  expect(editTableAxis(editTableAxis(table, 'column', 1, true), 'column', 1, false).columnEdges).toBeUndefined();
  expect(validLayoutTable({ ...table, rowEdges: [red] })).toBe(false);
  expect(validLayoutTable({ ...table, columnEdges: [{ strokeColor: '#000000', strokeWeightPt: 0 }] })).toBe(false);
  expect(validLayoutTable({ ...table, cells: table.cells.map(cell => ({ ...cell, rotationDeg: 45 as 90 })) })).toBe(false);
});

it('draws each grid line with its own stroke, broken where merged cells cover it, then the frame', () => {
  const table = mergeTableCells(createLayoutTable(2, 3), { row: 0, column: 1 }, { row: 1, column: 1 });
  table.rowEdges = [{ strokeColor: '#ff0000', strokeWeightPt: 2 }];
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'table', closed: true, points: [[0, 0], [30, 0], [30, 20], [0, 20]], table,
    style: { strokeColor: '#222222', strokeWeightPt: 0.5, fillColor: null } };
  const lines = tableGridLines(entity);
  expect(lines.map(line => [line.points, line.style.strokeColor])).toEqual([
    [[[10, 0], [10, 10], [10, 20]], '#222222'], [[[20, 0], [20, 10], [20, 20]], '#222222'],
    // The row line skips the merged middle column.
    [[[0, 10], [10, 10]], '#ff0000'], [[[20, 10], [30, 10]], '#ff0000'],
    [[[0, 0], [30, 0], [30, 20], [0, 20]], '#222222'],
  ]);
  expect(lines.at(-1)!.closed).toBe(true);
});

it('turns a cell text box within its cell', () => {
  const table = createLayoutTable(1, 2);
  table.cells[1]!.rotationDeg = 90;
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'table', closed: true, points: [[0, 0], [40, 0], [40, 10], [0, 10]], table };
  const [plain, turned] = tableCellEntities(entity);
  expect(plain!.points).toEqual([[0, 0], [20, 10]]);
  // The 20 × 10 cell holds a 10 × 20 box about the same center, turned a quarter clockwise.
  expect(turned!.points).toEqual([[25, -5], [35, 15]]);
  expect(turned!.text!.rotationDeg).toBe(90);
  expect(tableCells(entity).map(cell => cell.box)).toEqual([[[0, 0], [20, 10]], [[20, 0], [40, 10]]]);
});

it('sets one inner line, giving the others the stroke they drew with', () => {
  const entity: LayoutEntity = { id: 1, layerId: 1, kind: 'table', closed: true, table: createLayoutTable(3, 2),
    points: [[0, 0], [20, 0], [20, 30], [0, 30]], style: { strokeColor: '#222222', strokeWeightPt: 0.5, fillColor: '#ffffff', strokeDashMm: [2, 1] } };
  const dashed = { strokeColor: '#ff0000', strokeWeightPt: 2, strokeDashMm: [4, 2] };
  const table = setTableEdge(entity, 'row', 1, dashed);
  expect(table.rowEdges).toEqual([{ strokeColor: '#222222', strokeWeightPt: 0.5, strokeDashMm: [2, 1] }, dashed]);
  expect(table.columnEdges).toBeUndefined();
  expect(entity.table!.rowEdges).toBeUndefined();
  expect(setTableEdge({ ...entity, table }, 'row', 0, { strokeColor: '#00000000', strokeWeightPt: 1 }).rowEdges).toEqual([{ strokeColor: '#00000000', strokeWeightPt: 1 }, dashed]);
  expect(() => setTableEdge(entity, 'column', 1, dashed)).toThrow('Invalid table line');
  expect(() => setTableEdge(entity, 'row', 0, { strokeColor: '#000000', strokeWeightPt: 0 })).toThrow('Invalid table line');
});

it('fills new cells in LayOut\'s default text style', () => {
  expect(createLayoutTable(1, 1).cells[0]!.text).toMatchObject({ fontFamily: 'Verdana', fontSizePt: 10, color: '#000000', vertical: 'top' });
  expect(LAYOUT_DEFAULT_TEXT).toEqual({ fontFamily: 'Verdana', fontSizePt: 10, color: '#000000' });
});
