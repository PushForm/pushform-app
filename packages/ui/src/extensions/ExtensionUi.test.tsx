// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import { validateUiTree, type UiEvent } from '@pushform/extension-protocol';
import { ExtensionUiView, TABLE_ROW_PX, formatQuantity, parseQuantity } from './ExtensionUi';

afterEach(cleanup);

const metric: UnitSettings = { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'mm', lengthPrecision: 0 };

function show(tree: unknown, units: UnitSettings = metric) {
  const events: UiEvent[] = [];
  const view = render(<ExtensionUiView tree={validateUiTree(tree)} units={units} onEvent={(e) => events.push(e)} />);
  return { events, view };
}

describe('ExtensionUiView', () => {
  it('shows text as text, never as markup', () => {
    const { view } = show({ type: 'text', id: 't', text: '<img src=x onerror=alert(1)><b>bold</b>' });
    expect(screen.getByText('<img src=x onerror=alert(1)><b>bold</b>')).toBeTruthy();
    expect(view.container.querySelector('img, b')).toBeNull();
  });

  it('reports presses and ignores disabled buttons', () => {
    const { events } = show({ type: 'stack', id: 'r', children: [
      { type: 'button', id: 'go', label: 'Generate' }, { type: 'button', id: 'off', label: 'Unavailable', disabled: true },
    ] });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unavailable' }));
    expect(events).toEqual([{ component: 'go', event: 'press' }]);
  });

  it('shows lengths in the document units and reports what the user types in meters', () => {
    const { events } = show({ type: 'numberField', id: 'kerf', label: 'Kerf', value: 0.003, quantity: 'length', min: 0 });
    const input = screen.getByLabelText('Kerf') as HTMLInputElement;
    expect(input.value).toBe(formatQuantity(0.003, 'length', metric));
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '4mm' } });
    fireEvent.blur(input);
    expect(events).toEqual([{ component: 'kerf', event: 'change', value: 0.004 }]);
  });

  it('keeps an invalid number local, explains it, and sends nothing', () => {
    const { events } = show({ type: 'numberField', id: 'qty', label: 'Quantity', value: 2, quantity: 'count', min: 1, integer: true });
    const input = screen.getByLabelText('Quantity');
    for (const [typed, message] of [['many', 'Enter a number.'], ['1.5', 'Enter a whole number.'], ['0', 'The smallest value is 1.']] as const) {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);
      expect(screen.getByText(message)).toBeTruthy();
      expect(input.getAttribute('aria-invalid')).toBe('true');
    }
    expect(events).toEqual([]);
  });

  it('commits text fields on Enter or blur, not per keystroke', () => {
    const { events } = show({ type: 'textField', id: 'name', label: 'Name', value: 'Side' });
    const input = screen.getByLabelText('Name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Si' } });
    fireEvent.change(input, { target: { value: 'Side panel' } });
    expect(events).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(events).toEqual([{ component: 'name', event: 'change', value: 'Side panel' }]);
  });

  it('moves between tabs with the arrow keys and shows only the selected tab', () => {
    const { events } = show({ type: 'tabs', id: 'views', label: 'Views', selected: 'a', tabs: [{ id: 'a', label: 'Parts' }, { id: 'b', label: 'Materials' }],
      children: [{ type: 'text', id: 'ta', text: 'Parts view' }, { type: 'text', id: 'tb', text: 'Materials view' }] });
    expect(screen.getByText('Parts view')).toBeTruthy();
    expect(screen.queryByText('Materials view')).toBeNull();
    const tab = screen.getByRole('tab', { name: 'Parts' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    expect(events).toEqual([{ component: 'views', event: 'select', value: 'b' }]);
  });

  it('reports tree expansion and selection', () => {
    const { events } = show({ type: 'tree', id: 'outline', label: 'Outline', items: [{ id: 'cab', label: 'Cabinet', children: [{ id: 'door', label: 'Door' }] }] });
    expect(screen.queryByText('Door')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Cabinet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cabinet' }));
    expect(events).toEqual([{ component: 'outline', event: 'toggle', item: 'cab', expanded: true }, { component: 'outline', event: 'select', value: 'cab' }]);
  });
});

describe('table', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, cells: { name: `Part ${i}`, length: 0.1 * (i + 1), grain: i % 2 === 0 } }));
  const table = (overrides: Record<string, unknown> = {}) => ({
    type: 'table', id: 'parts', label: 'Parts', selection: 'multiple',
    columns: [
      { id: 'name', label: 'Name', kind: 'text', editable: true, sortable: true },
      { id: 'length', label: 'Length', kind: 'number', quantity: 'length', editable: true, hideable: true },
      { id: 'grain', label: 'Grain', kind: 'boolean', editable: true },
    ],
    rows: rows(5), ...overrides,
  });

  it('renders only the rows in view of a long table, keeping the full row count for assistive technology', () => {
    show(table({ rows: rows(5000) }));
    const grid = screen.getByRole('grid', { name: 'Parts' });
    expect(grid.getAttribute('aria-rowcount')).toBe('5001');
    const rendered = within(grid).getAllByRole('row').filter((r) => r.getAttribute('aria-rowindex'));
    expect(rendered.length).toBeLessThan(60);
    expect(screen.queryByText('Part 4999')).toBeNull();
    fireEvent.scroll(grid.parentElement!, { target: { scrollTop: 4990 * TABLE_ROW_PX } });
    expect(screen.getByText('Part 4999')).toBeTruthy();
  });

  it('reports sorting and shows the current sort to assistive technology', () => {
    const { events } = show(table({ sort: { column: 'name', direction: 'ascending' } }));
    const header = screen.getByRole('columnheader', { name: /Name/ });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(within(header).getByRole('button'));
    expect(events).toEqual([{ component: 'parts', event: 'sort', column: 'name', direction: 'descending' }]);
  });

  it('edits a length cell in document units and refuses input that is not a length', () => {
    const { events } = show(table());
    const cell = screen.getByLabelText(`Length, ${formatQuantity(0.1, 'length', metric)}, editable`);
    fireEvent.keyDown(cell, { key: 'Enter' });
    const input = screen.getByRole('textbox', { name: 'Length' });
    fireEvent.change(input, { target: { value: 'long' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(events).toEqual([{ component: 'parts', event: 'cellEdit', row: 'r0', column: 'length', value: 0.25 }]);
  });

  it('toggles boolean cells, selects rows and offers hideable columns', () => {
    const { events } = show(table());
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Grain' })[1]!);
    fireEvent.click(screen.getByText('Part 2'));
    fireEvent.click(screen.getByText('Part 3'), { metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Length' }));
    expect(events).toEqual([
      { component: 'parts', event: 'cellEdit', row: 'r1', column: 'grain', value: true },
      { component: 'parts', event: 'rowSelect', rows: ['r2'] },
      { component: 'parts', event: 'rowSelect', rows: ['r3'] },
      { component: 'parts', event: 'columns', hidden: ['length'] },
    ]);
  });

  it('marks cells with validation messages', () => {
    show(table({ rows: [{ id: 'r0', cells: { name: 'Side', length: 3 }, errors: { length: 'Longer than any stock.' } }] }));
    const cell = screen.getByLabelText(/Length: Longer than any stock\./);
    expect(cell.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('quantities', () => {
  it('formats and parses each quantity', () => {
    expect(formatQuantity(0.5, 'percent', metric)).toBe('50 %');
    expect(parseQuantity('25 %', 'percent', metric)).toBe(0.25);
    expect(formatQuantity(3.7, 'count', metric)).toBe('4');
    expect(parseQuantity('', 'length', metric)).toBeNull();
    expect(parseQuantity('2 m', 'length', metric)).toBe(2);
    expect(formatQuantity(45, 'angle', metric)).toBe('45.0°');
    vi.restoreAllMocks();
  });
});
