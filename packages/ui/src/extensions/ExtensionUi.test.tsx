// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import { validateUiTree, type UiEvent } from '@pushform/extension-protocol';
import { ExtensionUiView, OVERLAY_SCROLLBAR_PX, TABLE_ROW_PX, formatQuantity, parseQuantity } from './ExtensionUi';

afterEach(cleanup);

const metric: UnitSettings = { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'mm', lengthPrecision: 0 };

function show(tree: unknown, units: UnitSettings = metric) {
  const events: UiEvent[] = [];
  const view = render(<ExtensionUiView tree={validateUiTree(tree)} units={units} onEvent={(e) => events.push(e)} />);
  return { events, view };
}

describe('ExtensionUiView', () => {
  it('updates a focused untouched dependent number without authoring it, and preserves actual typing', () => {
    const node = (value: number) => ({ type: 'numberField', id: 'height', label: 'Texture height', value, quantity: 'length' });
    const { events, view } = show(node(1));
    const height = screen.getByLabelText('Texture height') as HTMLInputElement;
    fireEvent.focus(height);
    view.rerender(<ExtensionUiView tree={validateUiTree(node(.5))} units={metric} onEvent={event => events.push(event)} />);
    expect(height.value).toBe('500mm'); fireEvent.blur(height); expect(events).toEqual([]);
    fireEvent.focus(height); fireEvent.change(height, { target: { value: '750 mm' } });
    view.rerender(<ExtensionUiView tree={validateUiTree(node(.25))} units={metric} onEvent={event => events.push(event)} />);
    expect(height.value).toBe('750 mm'); fireEvent.blur(height);
    expect(events).toEqual([{ component: 'height', event: 'change', value: .75 }]);
  });
  it('follows focused untouched text updates and retains authored text through later updates', () => {
    const node = (value: string) => ({ type: 'textField', id: 'label', label: 'Label', value });
    const { events, view } = show(node('Original'));
    const label = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.focus(label);
    view.rerender(<ExtensionUiView tree={validateUiTree(node('Updated'))} units={metric} onEvent={event => events.push(event)} />);
    expect(label.value).toBe('Updated'); fireEvent.blur(label); expect(events).toEqual([]);
    fireEvent.focus(label); fireEvent.change(label, { target: { value: 'Authored' } });
    view.rerender(<ExtensionUiView tree={validateUiTree(node('Another update'))} units={metric} onEvent={event => events.push(event)} />);
    expect(label.value).toBe('Authored'); fireEvent.blur(label);
    expect(events).toEqual([{ component: 'label', event: 'change', value: 'Authored' }]);
  });
  it('marks mixed fields and inheritance sources without committing untouched values', () => {
    const { events } = show({ type: 'stack', id: 'mixed', children: [
      { type: 'textField', id: 'label', label: 'Label', value: 'Representative', mixed: true, source: 'Different sources' },
      { type: 'numberField', id: 'length', label: 'Allowance', value: 0.01, mixed: true, quantity: 'length', source: 'From material' },
      { type: 'checkbox', id: 'include', label: 'Include', checked: false, mixed: true },
      { type: 'choice', id: 'grain', label: 'Grain', value: null, mixed: true, options: [{ value: 'length', label: 'Along length' }] },
    ] });
    const label = screen.getByLabelText('Label') as HTMLInputElement, length = screen.getByLabelText('Allowance') as HTMLInputElement;
    expect(label.value).toBe(''); expect(label.placeholder).toBe('Mixed'); expect(length.value).toBe('');
    fireEvent.focus(label); fireEvent.blur(label); fireEvent.focus(length); fireEvent.blur(length);
    expect(events).toEqual([]);
    expect((screen.getByRole('checkbox', { name: 'Include' }) as HTMLInputElement).indeterminate).toBe(true);
    expect(screen.getByText('From material')).toBeTruthy();
    fireEvent.change(label, { target: { value: 'Door' } }); fireEvent.blur(label);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include' }));
    fireEvent.change(screen.getByLabelText('Grain'), { target: { value: 'length' } });
    expect(events).toEqual([{ component: 'label', event: 'change', value: 'Door' }, { component: 'include', event: 'change', value: true }, { component: 'grain', event: 'change', value: 'length' }]);
  });
  it('scopes display units to a subtree and commits unitless input in those units', () => {
    const inch = { ...metric, lengthUnit: 'in' as const, lengthPrecision: 2 };
    const { events } = show({ type: 'stack', id: 'root', children: [
      { type: 'numberField', id: 'outside', label: 'Model length', value: 0.0254, quantity: 'length' },
      { type: 'stack', id: 'override', displayUnits: { lengthUnit: 'in', format: 'decimal', lengthPrecision: 2 }, children: [
        { type: 'numberField', id: 'inside', label: 'Job length', value: 0.0254, quantity: 'length' },
      ] },
    ] });
    expect((screen.getByLabelText('Model length') as HTMLInputElement).value).toBe(formatQuantity(0.0254, 'length', metric));
    const input = screen.getByLabelText('Job length') as HTMLInputElement;
    expect(input.value).toBe(formatQuantity(0.0254, 'length', inch));
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    expect(events).toEqual([{ component: 'inside', event: 'change', value: 0.0508 }]);
    expect(metric.lengthUnit).toBe('mm');
  });

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

  it('shows icon buttons as icons named by their label, and never the icon name as markup', () => {
    const { events, view } = show({ type: 'stack', id: 'r', direction: 'horizontal', children: [
      { type: 'button', id: 'add', label: 'Add part', icon: 'add', variant: 'icon' },
      { type: 'button', id: 'save', label: 'Save', icon: 'save', variant: 'primary' },
    ] });
    const add = screen.getByRole('button', { name: 'Add part' });
    expect(add.textContent).toBe('');
    expect(add.getAttribute('title')).toBe('Add part');
    expect(add.querySelector('svg')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.textContent).toBe('Save');
    expect(save.querySelector('svg')).toBeTruthy();
    expect(view.container.textContent).not.toContain('add');
    fireEvent.click(add);
    expect(events).toEqual([{ component: 'add', event: 'press' }]);
  });

  it('renders a section as a disclosure whose header reports collapse requests and whose actions report presses', () => {
    const { events, view } = show({ type: 'section', id: 'oak', title: 'Oak, 19 mm', subtitle: 'Solid wood', badge: '3',
      actions: [{ id: 'hide', label: 'Hide group', icon: 'hide' }, { id: 'print', label: 'Print' }],
      children: [{ type: 'text', id: 'body', text: 'Three parts' }] });
    const toggle = screen.getByRole('button', { name: 'Oak, 19 mm' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(toggle.textContent).toContain('3');
    expect(toggle.textContent).toContain('Solid wood');
    expect(screen.getByText('Three parts')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Oak, 19 mm' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    fireEvent.click(toggle);
    expect(events).toEqual([
      { component: 'oak', event: 'press', action: 'hide' }, { component: 'oak', event: 'press', action: 'print' }, { component: 'oak', event: 'collapse', collapsed: true },
    ]);
    // Collapsed by the extension: the children are gone and the header says so.
    view.rerender(<ExtensionUiView tree={validateUiTree({ type: 'section', id: 'oak', title: 'Oak, 19 mm', collapsed: true, children: [{ type: 'text', id: 'body', text: 'Three parts' }] })}
      units={metric} onEvent={(e) => events.push(e)} />);
    expect(screen.queryByText('Three parts')).toBeNull();
    expect(screen.getByRole('button', { name: /Oak, 19 mm/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(screen.getByRole('button', { name: /Oak, 19 mm/ }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Oak, 19 mm/ }));
    expect(events.at(-1)).toEqual({ component: 'oak', event: 'collapse', collapsed: false });
  });

  it('opens a menu with focus on its first item, moves with the arrow keys past disabled items, and reports the choice', () => {
    vi.useFakeTimers();
    try {
      const { events } = show({ type: 'menu', id: 'more', label: 'More', items: [
        { id: 'expand', label: 'Expand all' }, { id: 'collapse', label: 'Collapse all' }, { id: 'reset', label: 'Reset numbers', separator: true, disabled: true },
      ] });
      const button = screen.getByRole('button', { name: 'More' });
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(button);
      vi.runAllTimers();
      const menu = screen.getByRole('menu', { name: 'More' });
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const items = within(menu).getAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['Expand all', 'Collapse all', 'Reset numbers']);
      expect(document.activeElement).toBe(items[0]);
      expect(menu.querySelector('.has-separator')?.textContent).toBe('Reset numbers');
      // Arrows wrap over the disabled item; Home and End jump.
      fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1]!, { key: 'Home' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0]!, { key: 'End' });
      expect(document.activeElement).toBe(items[1]);
      // Escape closes and returns focus to the button, sending nothing.
      fireEvent.keyDown(items[1]!, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(events).toEqual([]);
      // ArrowDown on the button opens it; choosing an item reports it and closes the menu.
      fireEvent.keyDown(button, { key: 'ArrowDown' });
      vi.runAllTimers();
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Collapse all' }));
      expect(events).toEqual([{ component: 'more', event: 'select', value: 'collapse' }]);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button);
      // A disabled item cannot be chosen; a click elsewhere closes the menu.
      fireEvent.click(button);
      vi.runAllTimers();
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Reset numbers' }));
      expect(events).toHaveLength(1);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('shows an icon menu by its label alone', () => {
    show({ type: 'menu', id: 'more', label: 'More actions', icon: 'more', variant: 'icon', disabled: true, items: [{ id: 'a', label: 'A' }] });
    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button.textContent).toBe('');
    expect((button as HTMLButtonElement).disabled).toBe(true);
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

  it('lets tabs wrap onto more rows and reach every tab from the keyboard, Home and End included', () => {
    const labels = ['Parts', 'Materials', 'Sheets', 'Bars', 'Edges', 'Estimate', 'Export'];
    const { events, view } = show({ type: 'tabs', id: 'views', label: 'Views', selected: 't6',
      tabs: labels.map((label, i) => ({ id: `t${i}`, label })), children: labels.map((label, i) => ({ type: 'text', id: `c${i}`, text: `${label} view` })) });
    const list = screen.getByRole('tablist', { name: 'Views' });
    expect(list.classList.contains('pf-xui-tablist')).toBe(true);
    expect(within(list).getAllByRole('tab').map((t) => t.textContent)).toEqual(labels);
    const last = screen.getByRole('tab', { name: 'Export' });
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    fireEvent.keyDown(last, { key: 'Home' });
    fireEvent.keyDown(last, { key: 'End' });
    expect(events.map((e) => (e as { value: string }).value)).toEqual(['t0', 't0', 't6']);
    expect(view.container.querySelector('.pf-xui-tablist')).toBe(list);
  });

  it('keeps Escape in a number field when it undoes typing, and lets it through otherwise', () => {
    show({ type: 'numberField', id: 'kerf', label: 'Kerf', value: 0.003, quantity: 'length' });
    const input = screen.getByLabelText('Kerf') as HTMLInputElement;
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
    fireEvent.change(input, { target: { value: '9' } });
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(input.value).toBe(formatQuantity(0.003, 'length', metric));
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

  it('keeps room below the last row for a scrollbar drawn over the rows, so the last row stays clickable', () => {
    // A wide table in a narrow panel, in a browser whose scrollbars overlay the content (they take no height).
    const geometry = {
      scrollWidth: { get(this: HTMLElement) { return this.classList.contains('pf-xui-table-scroll') ? 900 : 0; } },
      clientWidth: { get(this: HTMLElement) { return this.classList.contains('pf-xui-table-scroll') ? 300 : 0; } },
      clientHeight: { get(this: HTMLElement) { return this.classList.contains('pf-xui-table-scroll') ? 160 : 0; } },
      offsetHeight: { get(this: HTMLElement) { return this.classList.contains('pf-xui-table-scroll') ? 160 : 0; } },
    };
    const saved = Object.fromEntries(Object.keys(geometry).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]));
    Object.defineProperties(HTMLElement.prototype, geometry);
    try {
      const { events } = show(table());
      const scroller = screen.getByRole('grid', { name: 'Parts' }).parentElement!;
      expect(scroller.classList.contains('has-overlay-scrollbar')).toBe(true);
      expect(scroller.style.paddingBottom).toBe(`${OVERLAY_SCROLLBAR_PX}px`);
      fireEvent.click(screen.getByText('Part 4'));
      expect(events).toEqual([{ component: 'parts', event: 'rowSelect', rows: ['r4'] }]);
    } finally {
      for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    }
  });

  it('adds no room when the scrollbar sits beside the rows or nothing overflows', () => {
    show(table());
    const scroller = screen.getByRole('grid', { name: 'Parts' }).parentElement!;
    expect(scroller.classList.contains('has-overlay-scrollbar')).toBe(false);
    expect(scroller.style.paddingBottom).toBe('');
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
