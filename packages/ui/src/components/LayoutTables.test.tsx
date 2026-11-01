// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { layoutDashMm, layoutTextStyleAt, tableFrame } from '@pushform/layout';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null), tab = session.newLayout();
  const view = render(<LayoutWorkspace tab={tab} session={session} />), canvas = screen.getByLabelText('Page 1 canvas');
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  const down = (x: number, y: number) => fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const up = (x: number, y: number) => fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  return { app, session, tab, view, canvas, page, down, up, dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}

it('draws tables through the toolbar, previews without mutation, and edits cells on the page', async () => {
  const { tab, session, canvas, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  fireEvent.change(screen.getByLabelText('Table rows'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Table columns'), { target: { value: '2' } });
  // A click without dragging keeps the toolbar counts; the next click sets the size.
  down(10, 10); up(10, 10);
  fireEvent.pointerMove(canvas, { clientX: 210, clientY: 150 });
  expect(page().entities.size).toBe(0);
  down(70, 50); up(70, 50);
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  expect(entity().kind).toBe('table'); expect(entity().table!.cells).toHaveLength(4);
  expect(canvas.getAttribute('data-tool')).toBe('select');
  fireEvent.doubleClick(canvas, { clientX: 60, clientY: 60 });
  const editor = screen.getByLabelText('Edit table cell on page');
  fireEvent.change(editor, { target: { value: 'Heading' } });
  expect(entity().table!.cells[0]!.text.content).toBe('');
  fireEvent.keyDown(editor, { key: 'Tab' });
  expect(entity().table!.cells[0]!.text.content).toBe('Heading');
  fireEvent.change(screen.getByLabelText('Edit table cell on page'), { target: { value: 'Discard' } });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  expect(entity().table!.cells[1]!.text.content).toBe('');
  act(() => { tab.commands.execute('edit.undo'); }); expect(entity().table!.cells[0]!.text.content).toBe('');
  act(() => { tab.commands.execute('edit.redo'); });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(id)).toEqual(entity());
  dispose();
});

it('merges and unmerges cells, adjusts row and column sizes, and preserves data through structural edits', () => {
  const { tab, canvas, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' })); down(10, 10); up(10, 10); down(70, 40); up(70, 40);
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  const text = screen.getByLabelText('Table cell text'); fireEvent.change(text, { target: { value: 'Schedule' } }); fireEvent.blur(text);
  down(20, 15); up(20, 15);
  fireEvent.doubleClick(canvas, { clientX: 60, clientY: 45 });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'Row 1, column 2' }), { button: 0, pointerId: 2, shiftKey: true });
  fireEvent.pointerUp(screen.getByRole('grid', { name: 'Table cells on page' }), { pointerId: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Merge cells' }));
  expect(entity().table!.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }]);
  expect(entity().table!.cells[0]!.text.content).toBe('Schedule');
  fireEvent.click(screen.getByRole('button', { name: 'Unmerge cells' })); expect(entity().table!.merges).toEqual([]);
  fireEvent.change(screen.getByLabelText('Cell text rotation'), { target: { value: '90' } }); expect(entity().table!.cells[1]!.rotationDeg).toBe(90);
  fireEvent.change(screen.getByLabelText('Cell text rotation'), { target: { value: '0' } }); expect(entity().table!.cells[1]!.rotationDeg).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Insert row below' })); expect(entity().table!.rows).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'Delete row' })); expect(entity().table!.rows).toHaveLength(3);
  const height = screen.getByLabelText('Row height (mm)'); fireEvent.change(height, { target: { value: '20' } }); fireEvent.blur(height);
  expect(tableFrame(entity()).height).toBeCloseTo(40);
  const width = screen.getByLabelText('Column width (mm)'); fireEvent.change(width, { target: { value: '30' } }); fireEvent.blur(width);
  expect(tableFrame(entity()).width).toBeCloseTo(70);
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId: page().id, entityIds: [id], locked: true }); });
  expect((screen.getByLabelText('Table cell text') as HTMLTextAreaElement).disabled || screen.getByLabelText('Table cell text').closest('fieldset')!.disabled).toBe(true);
  fireEvent.doubleClick(canvas, { clientX: 60, clientY: 60 }); expect(screen.queryByLabelText('Edit table cell on page')).toBeNull();
  dispose();
});

it('supports precise table placement and cancellation', () => {
  const { canvas, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' })); down(10, 10); up(10, 10);
  fireEvent.keyDown(window, { key: 'Escape' }); expect(page().entities.size).toBe(0);
  down(10, 10); up(10, 10);
  enterLayoutValue('60mm,30mm');
  expect([...page().entities.values()][0]!.points).toEqual([[10, 10], [70, 10], [70, 40], [10, 40]]);
  expect(canvas.getAttribute('data-tool')).toBe('select'); dispose();
});

it('paints merged-cell content consistently in workspace, presentation, and print', () => {
  const texts: { canvas: HTMLCanvasElement; content: string }[] = [];
  const { tab, dispose } = mount();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const methods = new Map<string | symbol, unknown>([
      ['measureText', () => ({ width: 1 })],
      ['fillText', (content: string) => texts.push({ canvas: this, content })],
    ]);
    return new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); }, set: (_, key, value) => { methods.set(key, value); return true; } }) as CanvasRenderingContext2D;
  });
  act(() => {
    const id = tab.commands.execute('layout.table.add', { pageId: tab.activePageId, first: [10, 10], second: [70, 40], rows: 1, columns: 2 }) as number;
    const table = structuredClone(tab.doc.state.pages.get(tab.activePageId)!.entities.get(id)!.table!);
    table.merges.push({ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }); table.cells[0]!.text.content = 'Shown'; table.cells[1]!.text.content = 'Hidden';
    tab.commands.execute('layout.table.update', { pageId: tab.activePageId, entityId: id, table });
  });
  const check = (canvas: HTMLCanvasElement) => {
    const content = texts.filter(t => t.canvas === canvas).map(t => t.content).join('');
    expect(content).toContain('Shown'); expect(content).not.toContain('Hidden');
  };
  check(screen.getByLabelText('Page 1 canvas') as HTMLCanvasElement);
  fireEvent.click(screen.getByRole('button', { name: 'Presentation mode' })); check(screen.getByLabelText('Page 1 presentation') as HTMLCanvasElement);
  fireEvent.keyDown(window, { key: 'Escape' });
  act(() => { tab.commands.execute('layout.print'); }); check(screen.getByLabelText('Print preview: Page 1') as HTMLCanvasElement);
  dispose();
});

it('resizes a rotated table along its frame with Shift while keeping previews out of the document', () => {
  const { tab, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' })); down(10, 10); up(10, 10); down(70, 40); up(70, 40);
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  act(() => { tab.commands.execute('layout.shape.rotate', { pageId: page().id, entityId: id, angleDeg: 90 }); });
  const before = entity(), handle = screen.getByRole('button', { name: 'Scale bottom right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 75, clientY: 165 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 240, shiftKey: true });
  expect(entity()).toBe(before);
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 240, shiftKey: true });
  expect(tableFrame(entity()).width).toBeCloseTo(85);
  expect(tableFrame(entity()).height).toBeCloseTo(42.5);
  expect(entity().table!.cells[0]!.text.fontSizePt).toBe(10);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entity()).toEqual(before);
  dispose();
});

it('drags to choose rows and columns, locks them on release, then sizes and places the table on the next click', () => {
  const { canvas, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  const rows = screen.getByLabelText('Table rows') as HTMLInputElement, columns = screen.getByLabelText('Table columns') as HTMLInputElement;
  down(100, 100);
  expect(screen.queryByLabelText('Table size preview')).toBeNull();
  // 36 px per column, 18 px per row of screen drag.
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 300 + 100, clientY: 300 + 50 });
  expect([rows.value, columns.value]).toEqual(['3', '3']);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 300 + 140, clientY: 300 - 20 });
  expect([rows.value, columns.value]).toEqual(['2', '4']);
  expect(screen.getByText(/2 rows × 4 columns\. Release to keep them\./)).toBeTruthy();
  // The counts also follow the pointer.
  expect(screen.getByLabelText('Table size preview').textContent).toBe('4 x 2');
  up(300 / 3 + 140 / 3, 100 - 20 / 3);
  expect(page().entities.size).toBe(0);
  expect(screen.queryByLabelText('Table size preview')).toBeNull();
  // Moving after release resizes only; the counts stay locked.
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 600, clientY: 600 });
  expect([rows.value, columns.value]).toEqual(['2', '4']);
  expect(screen.getByText(/Move to size the table \(2 × 4\), then click to place it\./)).toBeTruthy();
  expect(page().entities.size).toBe(0);
  down(200, 200); up(200, 200);
  const table = [...page().entities.values()][0]!;
  expect(table.kind).toBe('table');
  expect(table.table!.rows).toHaveLength(2); expect(table.table!.columns).toHaveLength(4);
  expect(table.points).toEqual([[100, 100], [200, 100], [200, 200], [100, 200]]);
  expect(canvas.getAttribute('data-tool')).toBe('select');
  dispose();
});

it('cancels table placement with Escape after the counts are locked', () => {
  const { canvas, page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  down(100, 100); fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 400, clientY: 350 }); up(130, 115);
  fireEvent.keyDown(window, { key: 'Escape' });
  down(200, 200); up(200, 200);
  expect(page().entities.size).toBe(0);
  dispose();
});
it('styles one grid line at a time and dashes the table with LayOut patterns', () => {
  const { page, down, up, dispose } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Table' })); down(10, 10); up(10, 10); down(70, 40); up(70, 40);
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  const frame = { strokeColor: entity().style!.strokeColor, strokeWeightPt: entity().style!.strokeWeightPt };
  down(40, 25); up(40, 25);
  fireEvent.doubleClick(screen.getByLabelText('Page 1 canvas'), { clientX: 120, clientY: 75 });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  expect([...(screen.getByLabelText('Grid line') as HTMLSelectElement).options].map(option => option.value)).toEqual(['Above', 'Below', 'Left', 'Right']);
  fireEvent.change(screen.getByLabelText('Grid line'), { target: { value: 'Below' } });
  fireEvent.change(screen.getByLabelText('Line color'), { target: { value: '#ff0000' } });
  fireEvent.change(screen.getByLabelText('Line weight (pt)'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Line dash'), { target: { value: '3' } });
  expect(entity().table!.rowEdges).toEqual([frame, { strokeColor: '#ff0000', strokeWeightPt: 2, strokeDashMm: layoutDashMm(3, 2) }]);
  // The pattern keeps its proportions to the weight.
  fireEvent.change(screen.getByLabelText('Line weight (pt)'), { target: { value: '1' } });
  expect(entity().table!.rowEdges![1]!.strokeDashMm).toEqual(layoutDashMm(3, 1));
  fireEvent.change(screen.getByLabelText('Line dash scale'), { target: { value: '2' } });
  expect(entity().table!.rowEdges![1]!.strokeDashMm).toEqual(layoutDashMm(3, 1, 2));
  fireEvent.change(screen.getByLabelText('Grid line'), { target: { value: 'Left' } });
  fireEvent.click(screen.getByLabelText('Show line'));
  expect(entity().table!.columnEdges![0]!.strokeColor).toBe('#00000000');
  expect(screen.queryByLabelText('Line color')).toBeNull();
  // The table's own dash applies to the frame and every line.
  fireEvent.change(screen.getByLabelText('Dash'), { target: { value: '12' } });
  expect(entity().style!.strokeDashMm).toEqual(layoutDashMm(12, frame.strokeWeightPt));
  expect(entity().table!.rowEdges).toBeUndefined();
  fireEvent.change(screen.getByLabelText('Weight (pt)'), { target: { value: '3' } });
  expect(entity().style!.strokeDashMm).toEqual(layoutDashMm(12, 3));
  fireEvent.change(screen.getByLabelText('Dash'), { target: { value: 'solid' } });
  expect(entity().style!.strokeDashMm).toBeUndefined();
  dispose();
});

function editableTable() {
  const context = mount();
  let id = 0;
  act(() => { id = context.tab.commands.execute('layout.table.add', { pageId: context.page().id, first: [10, 10], second: [70, 50], rows: 2, columns: 3 }) as number; });
  const entity = () => context.page().entities.get(id)!;
  context.down(20, 20); context.up(20, 20);
  fireEvent.doubleClick(context.canvas, { clientX: 60, clientY: 60 });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  const grid = () => screen.getByRole('grid', { name: 'Table cells on page' });
  const cell = (row: number, column: number) => within(grid()).getByRole('gridcell', { name: new RegExp(`^Row ${row}, column ${column}(:|$)`) });
  const pick = (row: number, column: number, shiftKey = false) => {
    fireEvent.pointerDown(cell(row, column), { button: 0, pointerId: 2, shiftKey });
    fireEvent.pointerUp(grid(), { pointerId: 2 });
  };
  return { ...context, id, entity, grid, cell, pick };
}

it('types directly into a cell and commits before clicking the next cell or leaving the table, with undo and persistence', async () => {
  const { tab, session, entity, grid, cell, pick, down, up, page, dispose } = editableTable();
  const original = entity();
  fireEvent.keyDown(grid(), { key: 'H', code: 'KeyH' });
  const editor = screen.getByLabelText('Edit table cell on page');
  expect((editor as HTMLTextAreaElement).value).toBe('H');
  fireEvent.change(editor, { target: { value: 'Heading' } });
  expect(entity()).toBe(original);
  // No blur or Enter is simulated: pointerdown must save before unmounting the editor.
  pick(1, 2);
  expect(entity().table!.cells[0]!.text.content).toBe('Heading');
  expect(cell(1, 2).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(grid(), { key: 'N', code: 'KeyN' });
  fireEvent.change(screen.getByLabelText('Edit table cell on page'), { target: { value: 'Next cell' } });
  down(150, 100); up(150, 100);
  expect(entity().table!.cells[1]!.text.content).toBe('Next cell');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().table!.cells.map(c => c.text.content)).toEqual(['Heading', '', '', '', '', '']);
  act(() => { tab.commands.execute('edit.redo'); });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)?.entities.get(entity().id)).toEqual(entity());
  dispose();
});

it('selects a range by dragging on the page without moving the table, shares it with the inspector and formats it in one edit', () => {
  const { tab, entity, grid, cell, pick, dispose } = editableTable();
  const before = entity();
  fireEvent.pointerDown(cell(1, 1), { button: 0, pointerId: 2 });
  fireEvent.pointerMove(grid(), { pointerId: 2, clientX: 120, clientY: 120 });
  fireEvent.pointerUp(grid(), { pointerId: 2 });
  expect(entity()).toBe(before);
  expect(within(grid()).getAllByRole('gridcell', { selected: true })).toHaveLength(4);
  expect(within(screen.getByRole('region', { name: 'Table properties' })).queryByRole('grid')).toBeNull();
  fireEvent.change(screen.getByLabelText('Cell fill'), { target: { value: '#ff0000' } });
  expect(entity().table!.cells.map(c => c.fillColor)).toEqual(['#ff0000', '#ff0000', undefined, '#ff0000', '#ff0000', undefined]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity()).toEqual(before);
  pick(1, 1); pick(1, 3, true);
  fireEvent.click(screen.getByRole('button', { name: 'Merge cells' }));
  expect(entity().table!.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 3 }]);
  dispose();
});

it('extends a range during a canvas drag in table edit mode and cancels a later drag without a document edit', () => {
  const { tab, page, canvas, down, up, dispose } = mount();
  act(() => { tab.commands.execute('layout.table.add', { pageId: page().id, first: [10, 10], second: [70, 50], rows: 2, columns: 3 }); });
  fireEvent.doubleClick(canvas, { clientX: 60, clientY: 60 });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  const before = tab.doc.state;
  down(20, 20);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 180, clientY: 120 });
  up(60, 40);
  const grid = screen.getByRole('grid', { name: 'Table cells on page' });
  expect(within(grid).getAllByRole('gridcell', { selected: true })).toHaveLength(6);
  expect(tab.doc.state).toBe(before);
  fireEvent.pointerDown(within(grid).getByRole('gridcell', { name: 'Row 1, column 1' }), { button: 0, pointerId: 2 });
  fireEvent.pointerMove(grid, { pointerId: 2, clientX: 120, clientY: 120 });
  fireEvent.pointerCancel(grid, { pointerId: 2 });
  expect(within(grid).getAllByRole('gridcell', { selected: true })).toHaveLength(1);
  expect(tab.doc.state).toBe(before);
  dispose();
});

it('selects and moves a whole table on a single click, and enters cell editing only on double-click', () => {
  const { tab, page, canvas, down, up, dispose } = mount();
  let id = 0;
  act(() => { id = tab.commands.execute('layout.table.add', { pageId: page().id, first: [10, 10], second: [70, 50], rows: 2, columns: 3 }) as number; });
  const entity = () => page().entities.get(id)!;
  const before = entity();
  down(20, 20); up(20, 20);
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Scale bottom right' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Center of rotation' })).toBeTruthy();
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  expect(screen.queryByLabelText('Edit table cell on page')).toBeNull();
  expect(entity()).toBe(before);
  down(20, 20);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
  expect(entity()).toBe(before);
  up(30, 30);
  expect(entity().points[0]).toEqual([20, 20]);
  expect(entity().table).toEqual(before.table);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity()).toEqual(before);
  // The double-click's two pointer clicks still select the whole table until dblclick arrives.
  down(20, 20); up(20, 20); down(20, 20); up(20, 20);
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  fireEvent.doubleClick(canvas, { clientX: 60, clientY: 60 });
  expect(screen.getByRole('grid', { name: 'Table cells on page' })).toBeTruthy();
  expect(screen.getByLabelText('Edit table cell on page')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Center of rotation' })).toBeNull();
  expect(entity()).toEqual(before);
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  fireEvent.keyDown(screen.getByRole('grid', { name: 'Table cells on page' }), { key: 'Escape' });
  down(20, 20); up(20, 20);
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Scale bottom right' })).toBeTruthy();
  dispose();
});

it('navigates cells and ranges with the keyboard, skips merged cells, and clears text without deleting the table', () => {
  const { tab, entity, grid, cell, pick, dispose } = editableTable();
  pick(1, 1); pick(1, 2, true);
  fireEvent.click(screen.getByRole('button', { name: 'Merge cells' }));
  pick(1, 1);
  fireEvent.keyDown(grid(), { key: 'ArrowRight' });
  expect(cell(1, 3).classList.contains('is-active')).toBe(true);
  fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
  expect(within(grid()).getAllByRole('gridcell', { selected: true })).toHaveLength(2);
  fireEvent.keyDown(grid(), { key: 't', code: 'KeyT' });
  expect((screen.getByLabelText('Edit table cell on page') as HTMLTextAreaElement).value).toBe('t');
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  expect(entity().table!.cells[5]!.text.content).toBe('');
  fireEvent.keyDown(grid(), { key: 'x', code: 'KeyX' });
  pick(1, 3);
  expect(entity().table!.cells[5]!.text.content).toBe('x');
  pick(2, 3, true);
  const before = entity();
  fireEvent.keyDown(grid(), { key: 'Delete' });
  expect(entity().table!.cells.every(c => c.text.content === '')).toBe(true);
  fireEvent.keyDown(grid(), { key: 'z', ctrlKey: true });
  expect(entity()).toEqual(before);
  expect(tab.workspace.tool).toBe('select');
  dispose();
});

it('pastes rich text into a cell as a cancellable draft and commits formatting even when the text stays the same', () => {
  const { tab, entity, grid, dispose } = editableTable();
  const data = { getData: (type: string) => type === 'text/html' ? '<b style="color:#123456">Rich</b>' : type === 'text/plain' ? 'Rich' : '' };
  fireEvent.keyDown(grid(), { key: 'Enter' });
  let editor = screen.getByLabelText('Edit table cell on page') as HTMLTextAreaElement;
  const before = entity();
  fireEvent.paste(editor, { clipboardData: data });
  expect(editor.value).toBe('Rich'); expect(entity()).toBe(before);
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(entity()).toBe(before);
  fireEvent.keyDown(grid(), { key: 'Enter' });
  editor = screen.getByLabelText('Edit table cell on page') as HTMLTextAreaElement;
  fireEvent.paste(editor, { clipboardData: data }); fireEvent.blur(editor);
  expect(entity().table!.cells[0]!.text.content).toBe('Rich');
  expect(layoutTextStyleAt(entity().table!.cells[0]!.text, 1)).toMatchObject({ bold: true, color: '#123456' });
  act(() => { tab.commands.execute('edit.undo'); }); expect(entity()).toEqual(before);
  act(() => { tab.commands.execute('edit.redo'); });
  fireEvent.keyDown(grid(), { key: 'Enter' });
  editor = screen.getByLabelText('Edit table cell on page') as HTMLTextAreaElement;
  editor.setSelectionRange(0, 4);
  fireEvent.paste(editor, { clipboardData: { getData: (type: string) => type === 'text/html' ? '<i>Rich</i>' : '' } });
  fireEvent.blur(editor);
  expect(entity().table!.cells[0]!.text.content).toBe('Rich');
  expect(layoutTextStyleAt(entity().table!.cells[0]!.text, 1).italic).toBe(true);
  dispose();
});

it('saves before a toolbar tool change and keeps locked tables out of cell editing', () => {
  const { tab, entity, grid, page, down, up, dispose } = editableTable();
  fireEvent.keyDown(grid(), { key: 'S' });
  fireEvent.change(screen.getByLabelText('Edit table cell on page'), { target: { value: 'Saved on tool change' } });
  const move = screen.getByRole('button', { name: 'Move' });
  fireEvent.pointerDown(move, { button: 0 }); fireEvent.click(move);
  expect(entity().table!.cells[0]!.text.content).toBe('Saved on tool change');
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  act(() => { tab.commands.execute('tool.select'); tab.commands.execute('layout.shape.setLocked', { pageId: page().id, entityIds: [entity().id], locked: true }); });
  down(20, 20); up(20, 20);
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  dispose();
});

it('keeps boundary edits visible, supports line breaks, and returns to object selection with Escape', () => {
  const { entity, grid, pick, dispose } = editableTable();
  pick(2, 3);
  fireEvent.keyDown(grid(), { key: 'Z' });
  fireEvent.change(screen.getByLabelText('Edit table cell on page'), { target: { value: 'Last' } });
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Tab' });
  expect(entity().table!.cells[5]!.text.content).toBe('Last');
  const editor = screen.getByLabelText('Edit table cell on page') as HTMLTextAreaElement;
  expect(editor.value).toBe('Last');
  editor.setSelectionRange(4, 4);
  fireEvent.keyDown(editor, { key: 'Enter', altKey: true });
  expect(editor.value).toBe('Last\n');
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(entity().table!.cells[5]!.text.content).toBe('Last');
  expect(screen.queryByRole('button', { name: 'Center of rotation' })).toBeNull();
  fireEvent.keyDown(grid(), { key: 'Escape' });
  expect(screen.queryByRole('grid', { name: 'Table cells on page' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Center of rotation' })).toBeTruthy();
  dispose();
});

it('opens existing cell text when pointer capture delivers the double-click to the grid', () => {
  const { grid, entity, dispose } = editableTable();
  fireEvent.doubleClick(grid(), { clientX: 60, clientY: 60 });
  fireEvent.change(screen.getByLabelText('Edit table cell on page'), { target: { value: 'Double-clicked' } });
  fireEvent.blur(screen.getByLabelText('Edit table cell on page'));
  expect(entity().table!.cells[0]!.text.content).toBe('Double-clicked');
  dispose();
});

it('selects cells in a rotated table using its local axes', () => {
  const { tab, entity, page, grid, cell, down, up, dispose } = editableTable();
  act(() => { tab.commands.execute('layout.shape.rotate', { pageId: page().id, entityId: entity().id, angleDeg: 90 }); });
  const { a, b, d } = tableFrame(entity());
  const at = (u: number, v: number) => [a[0] + u * (b[0] - a[0]) + v * (d[0] - a[0]), a[1] + u * (b[1] - a[1]) + v * (d[1] - a[1])] as const;
  const first = at(1 / 6, 1 / 4), last = at(1 / 2, 3 / 4);
  down(...first); up(...first);
  fireEvent.pointerDown(cell(1, 1), { button: 0, pointerId: 2 });
  fireEvent.pointerMove(grid(), { pointerId: 2, clientX: last[0] * 3, clientY: last[1] * 3 });
  fireEvent.pointerUp(grid(), { pointerId: 2 });
  expect(within(grid()).getAllByRole('gridcell', { selected: true })).toHaveLength(4);
  expect(grid().style.transform).toContain('matrix(');
  dispose();
});

it.each(['column', 'row'] as const)('drags an individual %s boundary with a live preview and one undoable commit', async axis => {
  const { tab, session, entity, grid, page, dispose } = editableTable();
  const original = entity(), version = tab.doc.version;
  const handle = screen.getByRole('button', { name: `Resize ${axis} 1` });
  const from = axis === 'column' ? { clientX: 90, clientY: 60 } : { clientX: 60, clientY: 90 };
  const to = axis === 'column' ? { clientX: 120, clientY: 60 } : { clientX: 60, clientY: 120 };
  fireEvent.pointerDown(handle, { button: 0, pointerId: 3, ...from });
  fireEvent.pointerMove(handle, { pointerId: 3, ...to });
  expect(entity()).toBe(original); expect(tab.doc.version).toBe(version);
  const first = within(grid()).getByRole('gridcell', { name: 'Row 1, column 1' });
  expect(first.style[axis === 'column' ? 'width' : 'height']).toBe('90px');
  fireEvent.pointerUp(handle, { pointerId: 3, ...to });
  expect(entity().table![axis === 'column' ? 'columns' : 'rows']).toEqual(axis === 'column' ? [30, 20, 20] : [30, 20]);
  expect(tableFrame(entity())[axis === 'column' ? 'width' : 'height']).toBe(axis === 'column' ? 70 : 50);
  expect(entity().points[0]).toEqual(original.points[0]);
  expect(entity().table!.cells).toEqual(original.table!.cells);
  const after = entity();
  act(() => { tab.commands.execute('edit.undo'); }); expect(entity()).toEqual(original);
  act(() => { tab.commands.execute('edit.redo'); }); expect(entity()).toEqual(after);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)?.entities.get(after.id)).toEqual(after);
  dispose();
});

it.each(['Escape', 'pointer cancel', 'tool change'] as const)('cancels a boundary resize on %s without editing the table', reason => {
  const { tab, entity, grid, dispose } = editableTable();
  const before = tab.doc.state;
  const handle = screen.getByRole('button', { name: 'Resize column 3' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 210, clientY: 60 });
  fireEvent.pointerMove(handle, { pointerId: 3, clientX: 240, clientY: 60 });
  expect(grid().style.width).toBe('210px');
  if (reason === 'Escape') fireEvent.keyDown(handle, { key: 'Escape' });
  else if (reason === 'pointer cancel') fireEvent.pointerCancel(handle, { pointerId: 3 });
  else fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  expect(tab.doc.state).toBe(before);
  expect(tableFrame(entity()).width).toBe(60);
  if (reason !== 'tool change') expect(grid().style.width).toBe('180px');
  dispose();
});

it('resizes a rotated table along local axes and preserves merged cells and committed typing', () => {
  const { tab, entity, grid, pick, page, dispose } = editableTable();
  fireEvent.keyDown(grid(), { key: 'H' });
  const handle = screen.getByRole('button', { name: 'Resize column 1' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 90, clientY: 60 });
  fireEvent.pointerMove(handle, { pointerId: 3, clientX: 120, clientY: 60 });
  fireEvent.pointerUp(handle, { pointerId: 3, clientX: 120, clientY: 60 });
  expect(entity().table!.cells[0]!.text.content).toBe('H');
  pick(1, 1); pick(1, 2, true); fireEvent.click(screen.getByRole('button', { name: 'Merge cells' }));
  act(() => { tab.commands.execute('layout.shape.rotate', { pageId: page().id, entityId: entity().id, angleDeg: 90 }); });
  const before = entity(), frame = tableFrame(before);
  const resize = screen.getByRole('button', { name: 'Resize column 1' });
  // The first column boundary runs vertically in local space, but its drag is down the screen.
  const x = frame.a[0] - 10, y = frame.a[1] + 30;
  fireEvent.pointerDown(resize, { button: 0, pointerId: 3, clientX: x * 3, clientY: y * 3 });
  fireEvent.pointerMove(resize, { pointerId: 3, clientX: x * 3, clientY: (y + 5) * 3 });
  fireEvent.pointerUp(resize, { pointerId: 3, clientX: x * 3, clientY: (y + 5) * 3 });
  expect(tableFrame(entity()).width).toBeCloseTo(75);
  expect(entity().table!.columns).toEqual([35, 20, 20]);
  expect(entity().table!.merges).toEqual(before.table!.merges);
  expect(entity().table!.cells).toEqual(before.table!.cells);
  expect(entity().points[0]).toEqual(before.points[0]);
  dispose();
});

it('resizes the final row and column, prevents inverted sizes, and supports undo from a focused grip', () => {
  const { entity, dispose } = editableTable();
  const row = screen.getByRole('button', { name: 'Resize row 2' });
  fireEvent.pointerDown(row, { button: 0, pointerId: 3, clientX: 60, clientY: 150 });
  fireEvent.pointerMove(row, { pointerId: 3, clientX: 60, clientY: 180 });
  fireEvent.pointerUp(row, { pointerId: 3, clientX: 60, clientY: 180 });
  expect(entity().table!.rows).toEqual([20, 30]);
  expect(tableFrame(entity()).height).toBe(50);
  const column = screen.getByRole('button', { name: 'Resize column 3' });
  fireEvent.pointerDown(column, { button: 0, pointerId: 3, clientX: 210, clientY: 60 });
  fireEvent.pointerMove(column, { pointerId: 3, clientX: 240, clientY: 60 });
  fireEvent.pointerUp(column, { pointerId: 3, clientX: 240, clientY: 60 });
  expect(entity().table!.columns).toEqual([20, 20, 30]);
  const before = entity();
  fireEvent.pointerDown(column, { button: 0, pointerId: 3, clientX: 240, clientY: 60 });
  fireEvent.pointerMove(column, { pointerId: 3, clientX: 0, clientY: 60 });
  fireEvent.pointerUp(column, { pointerId: 3, clientX: 0, clientY: 60 });
  expect(entity().table!.columns[2]).toBeGreaterThan(0);
  expect(entity().table!.columns.slice(0, 2)).toEqual([20, 20]);
  fireEvent.keyDown(column, { key: 'z', ctrlKey: true });
  expect(entity()).toEqual(before);
  dispose();
});
