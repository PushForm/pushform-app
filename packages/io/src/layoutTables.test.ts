// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, createLayoutTable, layoutDashMm, mergeTableCells, rotateLayoutEntity, tableCellEntities, tableCells, type LayoutEntity } from '@pushform/layout';
import { decodeLayoutDocument, encodeLayoutDocument, layoutJson, decodeLayoutJson } from './layoutFile';
import { exportSketchUpLayout } from './sketchupLayoutExport';
import { importSketchUpLayout } from './sketchupLayout';

it('saves tables losslessly, rejects malformed grids, and exports them to LayOut as tables', async () => {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  const table = mergeTableCells(createLayoutTable(2, 2), { row: 0, column: 0 }, { row: 0, column: 1 });
  table.cells[0]!.text.content = 'Merged heading'; table.cells[0]!.text.bold = true; table.cells[0]!.fillColor = '#ddeeff';
  table.cells[1]!.text.content = 'Hidden'; table.cells[2]!.text.content = 'Visible'; table.cells[3]!.rotationDeg = 90;
  table.rowEdges = [{ strokeColor: '#ff0000', strokeWeightPt: 2, strokeDashMm: layoutDashMm(3, 2) }]; table.columnEdges = [{ strokeColor: '#00000000', strokeWeightPt: 1 }];
  const entity: LayoutEntity = rotateLayoutEntity({ id: 3, layerId: 1, kind: 'table', table, closed: true,
    points: [[10, 10], [70, 10], [70, 40], [10, 40]], style: { strokeColor: '#222222', strokeWeightPt: 1, fillColor: '#ffffff' } }, [10, 10], 30);
  doc.transact('Fixture', draft => { const page = draft.pages.get(pageId)!; page.entities.set(3, entity); page.entityOrder.push(3); draft.meta.nextId = 4; });
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!.entities.get(3)).toEqual(entity);
  expect(() => decodeLayoutJson(layoutJson(doc.state).replace('"rowSpan":1', '"rowSpan":999'))).toThrow('invalid state');
  const exported = await exportSketchUpLayout(doc.state);
  expect(exported.warnings).toEqual([]);
  const imported = importSketchUpLayout(exported.bytes, 'Table.layout');
  const [back] = [...imported.doc.state.pages.values()].flatMap(p => [...p.entities.values()]);
  expect(back!.kind).toBe('table');
  back!.points.forEach((point, i) => { expect(point[0]).toBeCloseTo(entity.points[i]![0], 3); expect(point[1]).toBeCloseTo(entity.points[i]![1], 3); });
  const grid = back!.table!;
  expect(grid.merges).toEqual(table.merges);
  expect(tableCellEntities(back!).map(cell => cell.text!.content)).toEqual(['Merged heading', 'Visible', '']);
  expect(grid.cells[0]!.text.bold).toBe(true);
  expect(tableCells(back!).map(cell => cell.fillColor)).toEqual(['#ddeeff', '#ffffff', '#ffffff']);
  expect(grid.cells[3]!.rotationDeg).toBe(90);
  expect(grid.rowEdges).toEqual([{ strokeColor: '#ff0000', strokeWeightPt: 2, strokeDashMm: layoutDashMm(3, 2) }]);
  expect(grid.columnEdges).toEqual([{ strokeColor: '#00000000', strokeWeightPt: 1 }]);
  expect(back!.style).toMatchObject({ strokeColor: '#222222', strokeWeightPt: 1 });
});
