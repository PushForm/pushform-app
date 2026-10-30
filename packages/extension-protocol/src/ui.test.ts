// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { UI_LIMITS, UiTreeError, validateUiTree, type UiNode } from './ui.ts';

const table = (overrides: Record<string, unknown> = {}) => ({
  type: 'table', id: 'parts', label: 'Parts',
  columns: [
    { id: 'name', label: 'Name', kind: 'text', editable: true, sortable: true },
    { id: 'length', label: 'Length', kind: 'number', quantity: 'length', editable: true, hideable: true },
    { id: 'grain', label: 'Grain', kind: 'boolean', editable: true },
    { id: 'material', label: 'Material', kind: 'choice', options: [{ value: 'oak', label: 'Oak' }, { value: 'ply', label: 'Plywood' }] },
  ],
  rows: [
    { id: 'g1', cells: {}, heading: 'Oak, 19 mm' },
    { id: 'a', cells: { name: 'Side', length: 0.72, grain: true, material: 'oak' }, errors: { length: 'Longer than the stock.' } },
  ],
  sort: { column: 'name', direction: 'ascending' }, selection: 'multiple', selected: ['a'], hiddenColumns: ['length'],
  ...overrides,
});

const problem = (input: unknown): { code: string; message: string } => {
  try { validateUiTree(input); } catch (error) { if (error instanceof UiTreeError) return { code: error.code, message: error.message }; throw error; }
  throw new Error('expected the tree to be refused');
};

describe('validateUiTree', () => {
  it('accepts a full tree and returns it typed', () => {
    const tree = validateUiTree({ type: 'stack', id: 'root', children: [
      { type: 'text', id: 'title', text: 'Cut list', variant: 'heading' },
      { type: 'tabs', id: 'views', label: 'Views', selected: 'list', tabs: [{ id: 'list', label: 'Parts' }, { id: 'opts', label: 'Options' }], children: [
        table(),
        { type: 'stack', id: 'options', children: [
          { type: 'numberField', id: 'kerf', label: 'Kerf', value: 0.003, quantity: 'length', min: 0 },
          { type: 'choice', id: 'mode', label: 'Mode', value: 'auto', options: [{ value: 'auto', label: 'Automatic' }] },
          { type: 'checkbox', id: 'mirror', label: 'Detect mirrored parts', checked: true },
          { type: 'colorField', id: 'paint', label: 'Color', value: '#336699' },
          { type: 'textField', id: 'notes', label: 'Notes', value: '', multiline: true },
        ] },
      ] },
      { type: 'tree', id: 'outline', label: 'Outline', items: [{ id: 'cab', label: 'Cabinet', children: [{ id: 'door', label: 'Door' }] }], expanded: ['cab'] },
      { type: 'progress', id: 'packing', label: 'Packing', value: null },
      { type: 'button', id: 'export', label: 'Export', variant: 'primary' },
    ] }) as Extract<UiNode, { type: 'stack' }>;
    expect(tree.children).toHaveLength(5);
  });

  it('refuses unknown components and any property outside the component, such as markup or style', () => {
    expect(problem({ type: 'html', id: 'x', html: '<b>hi</b>' }).code).toBe('validation.failed');
    expect(problem({ type: 'text', id: 'x', text: 'hi', style: 'color:red' }).message).toMatch(/style|Unrecognized/i);
    expect(problem({ type: 'button', id: 'x', label: 'Go', onClick: 'alert(1)' }).code).toBe('validation.failed');
  });

  it('refuses duplicate ids anywhere in the tree', () => {
    expect(problem({ type: 'stack', id: 'a', children: [{ type: 'divider', id: 'b' }, { type: 'stack', id: 'c', children: [{ type: 'divider', id: 'b' }] }] }).message)
      .toMatch(/"b" is used twice/);
  });

  it('bounds node count and depth before checking components', () => {
    const wide = { type: 'stack', id: 'r', children: Array.from({ length: UI_LIMITS.nodes }, (_, i) => ({ type: 'divider', id: `d${i}` })) };
    expect(problem(wide).code).toBe('limit.exceeded');
    let deep: Record<string, unknown> = { type: 'divider', id: 'leaf' };
    for (let i = 0; i <= UI_LIMITS.depth; i++) deep = { type: 'stack', id: `s${i}`, children: [deep] };
    expect(problem(deep).code).toBe('limit.exceeded');
  });

  it('checks table rows against their columns', () => {
    expect(problem(table({ rows: [{ id: 'a', cells: { length: 'long' } }] })).message).toMatch(/does not fit a number column/);
    expect(problem(table({ rows: [{ id: 'a', cells: { material: 'steel' } }] })).message).toMatch(/choice column/);
    expect(problem(table({ rows: [{ id: 'a', cells: { colour: 'red' } }] })).message).toMatch(/no column "colour"/);
    expect(problem(table({ rows: [{ id: 'a', cells: {} }, { id: 'a', cells: {} }] })).message).toMatch(/used twice/);
    expect(problem(table({ hiddenColumns: ['name'] })).message).toMatch(/cannot be hidden/);
    expect(problem(table({ selection: 'single', selected: ['a', 'g1'] })).message).toMatch(/only one row/);
    expect(problem(table({ rows: Array.from({ length: UI_LIMITS.tableRows + 1 }, (_, i) => ({ id: `r${i}`, cells: {} })) })).code).toBe('limit.exceeded');
  });

  it('checks tabs, choices, number ranges and tree items', () => {
    expect(problem({ type: 'tabs', id: 't', label: 'T', selected: 'a', tabs: [{ id: 'a', label: 'A' }], children: [] }).message).toMatch(/one child per tab/);
    expect(problem({ type: 'tabs', id: 't', label: 'T', selected: 'z', tabs: [{ id: 'a', label: 'A' }], children: [{ type: 'divider', id: 'd' }] }).message).toMatch(/selected tab/);
    expect(problem({ type: 'choice', id: 'c', label: 'C', value: 'x', options: [{ value: 'y', label: 'Y' }] }).message).toMatch(/not one of the options/);
    expect(problem({ type: 'numberField', id: 'n', label: 'N', value: 1, min: 5, max: 2 }).message).toMatch(/min is greater/);
    const many = Array.from({ length: UI_LIMITS.treeItems + 1 }, (_, i) => ({ id: `i${i}`, label: 'x' }));
    expect(problem({ type: 'tree', id: 't', label: 'T', items: many }).code).toBe('limit.exceeded');
    expect(problem({ type: 'tree', id: 't', label: 'T', items: [{ id: 'a', label: 'A', children: [{ id: 'a', label: 'again' }] }] }).message).toMatch(/used twice/);
  });

  it('bounds the length of text values', () => {
    expect(problem({ type: 'text', id: 't', text: 'x'.repeat(UI_LIMITS.textChars + 1) }).code).toBe('validation.failed');
  });
});
