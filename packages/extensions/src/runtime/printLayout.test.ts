// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DEFAULT_UNITS, formatLength, type UnitSettings } from '@pushform/core';
import { ExtensionError, UI_PRINT_MAX_PAGES, validateUiTree, type ExtensionManifest, type UiTable } from '@pushform/extension-protocol';
import type { LayoutVectorItem, LayoutVectorPage } from '@pushform/io/vector';
import { fitColumns, metricQuantityFormatter, printPages, printableText, textWidth, wrapText, type QuantityFormatter } from './printLayout';
import { ExtensionUiHost } from './ui';
import { vectorPrintServices, type PrintRequest, type ViewPrinter } from './vector';

const A4 = { width: 210, height: 297 };
type Text = Extract<LayoutVectorItem, { kind: 'text' }>;
const texts = (page: LayoutVectorPage): Text[] => page.items.filter((i): i is Text => i.kind === 'text');
const words = (page: LayoutVectorPage): string[] => texts(page).map((t) => t.text);

const parts = (rows: number, extra: Partial<UiTable> = {}): UiTable => validateUiTree({
  type: 'table', id: 'parts', label: 'Parts',
  columns: [
    { id: 'name', label: 'Name', kind: 'text' },
    { id: 'length', label: 'Length', kind: 'number', quantity: 'length' },
    { id: 'count', label: 'Qty', kind: 'number', quantity: 'count' },
    { id: 'notes', label: 'Notes', kind: 'text', hideable: true },
    { id: 'grain', label: 'Grain', kind: 'boolean' },
  ],
  rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, cells: { name: `Part ${i}`, length: 0.5 + i / 1000, count: 2, notes: 'n', grain: i % 2 === 0 } })),
  ...extra,
}) as UiTable;

const units = (overrides: Partial<UnitSettings>): QuantityFormatter => {
  const settings = { ...DEFAULT_UNITS, ...overrides };
  return (value, quantity) => (quantity === 'length' ? formatLength(value, settings) : metricQuantityFormatter(value, quantity));
};

describe('text measurement', () => {
  it('uses Helvetica widths, so the same text measures the same for SVG and PDF', () => {
    expect(textWidth('0000', 10)).toBeCloseTo(22.24);
    expect(textWidth('W', 10, true)).toBeCloseTo(9.44);
    expect(textWidth('il', 10)).toBeLessThan(textWidth('mm', 10));
  });

  it('keeps to the characters the standard PDF fonts write', () => {
    expect(printableText('Σ Length')).toBe('Sum Length');
    expect(printableText('Ø 18 mm × 2 – ½" “oak” café')).toBe('Ø 18 mm × 2 – ½" “oak” café');
    expect(printableText('Łódź ściana')).toBe('Lódz sciana');
    expect(printableText('棚板 a\u0007b')).toBe('?? a b');
    const table = parts(1);
    const page = printPages([{ kind: 'table', table: { ...table, label: 'Σ parts', columns: table.columns.map((c) => ({ ...c, label: `Σ ${c.label}` })) } }],
      A4, 'Σ', metricQuantityFormatter)[0]!;
    expect(words(page).every((w) => !w.includes('Σ'))).toBe(true);
    expect(words(page)).toContain('Sum Name');
  });

  it('wraps at spaces, splits words longer than a line, and ends cut text with an ellipsis', () => {
    const lines = wrapText('a quick brown fox jumps over the lazy dog', 20, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 3)).toBeLessThanOrEqual(20);
    expect(lines.join(' ')).toBe('a quick brown fox jumps over the lazy dog');
    expect(wrapText('x'.repeat(100), 10, 3).every((line) => textWidth(line, 3) <= 10)).toBe(true);
    const cut = wrapText('word '.repeat(200), 20, 3, false, 3);
    expect(cut).toHaveLength(3);
    expect(cut[2]!.endsWith('…')).toBe(true);
  });

  it('fits columns to the width: numbers keep theirs, text gives way and then the type gets smaller', () => {
    const roomy = fitColumns(['A', 'B'], [['x', '1']], [false, true], 100);
    expect(roomy.size).toBe(3);
    expect(roomy.widths.reduce((a, b) => a + b)).toBeCloseTo(100);
    const tight = fitColumns(['Name', 'Length'], [['a very long part name that needs to wrap', '1234.5 mm']], [false, true], 40);
    expect(tight.widths.reduce((a, b) => a + b)).toBeCloseTo(40);
    expect(tight.widths[1]).toBeGreaterThanOrEqual(textWidth('1234.5 mm', tight.size));
    const crowded = fitColumns(Array.from({ length: 30 }, (_, i) => `Column ${i}`), [Array.from({ length: 30 }, () => '12345.678')], Array(30).fill(true), 180);
    expect(crowded.size).toBeCloseTo(2.2);
    expect(crowded.widths.reduce((a, b) => a + b)).toBeCloseTo(180);
  });
});

describe('table pages', () => {
  it('repeats the header row on every page, keeps every row once and in order, and numbers the pages', () => {
    const pages = printPages([{ kind: 'table', table: parts(300) }], A4, 'Cut list', metricQuantityFormatter);
    expect(pages.length).toBeGreaterThan(3);
    const seen: string[] = [];
    for (const [i, page] of pages.entries()) {
      expect(page).toMatchObject({ width: 210, height: 297, paperUnits: 'mm' });
      const all = words(page);
      expect(all[0]).toBe('Cut list');
      expect(all).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(all).toContain(i ? 'Parts (continued)' : 'Parts');
      for (const label of ['Name', 'Length', 'Qty', 'Notes', 'Grain']) expect(all).toContain(label);
      const header = texts(page).find((t) => t.text === 'Name')!;
      const rows = texts(page).filter((t) => /^Part \d+$/.test(t.text));
      for (const row of rows) {
        expect(row.point[1]).toBeGreaterThan(header.point[1]);
        expect(row.point[1]).toBeLessThan(297 - 12);
      }
      seen.push(...rows.map((t) => t.text));
    }
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => `Part ${i}`));
  });

  it('right-aligns numbers in the document units, prints booleans as words, and leaves hidden columns out', () => {
    const table = parts(2, { hiddenColumns: ['notes'] });
    const mm = { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1 } as const;
    const metric = printPages([{ kind: 'table', table }], A4, 'T', units(mm));
    const all = words(metric[0]!);
    expect(formatLength(0.5, mm)).toMatch(/^500(\.0)? ?mm$/);
    expect(all).toContain(formatLength(0.5, mm));
    expect(all).toContain(formatLength(0.501, mm));
    expect(all).toContain('Yes');
    expect(all).toContain('No');
    expect(all).not.toContain('Notes');
    expect(all).not.toContain('n');
    const length = texts(metric[0]!).find((t) => t.text === formatLength(0.5, mm))!;
    expect(length.align).toBe('end');
    expect(length.bounds[2] - length.bounds[0]).toBeCloseTo(textWidth(length.text, Number(/([\d.]+)px/.exec(length.font)![1])));
    const imperial = printPages([{ kind: 'table', table }], A4, 'T', units({}));
    expect(words(imperial[0]!)).toContain(formatLength(0.5, DEFAULT_UNITS));
    expect(formatLength(0.5, DEFAULT_UNITS)).toMatch(/1'/);
  });

  it('spans heading rows across the table and never ends a page with one', () => {
    const rows = [];
    for (let g = 0; g < 12; g++) {
      rows.push({ id: `g${g}`, cells: {}, heading: `Group ${g}` });
      for (let i = 0; i < 9; i++) rows.push({ id: `g${g}r${i}`, cells: { name: `Part ${g}.${i}`, length: 1, count: 1, grain: false } });
    }
    const pages = printPages([{ kind: 'table', table: parts(0, { rows }) }], A4, 'Groups', metricQuantityFormatter);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const list = texts(page).filter((t) => /^(Group|Part) /.test(t.text)).sort((a, b) => a.point[1] - b.point[1]);
      expect(list.at(-1)!.text.startsWith('Group')).toBe(false);
      const heading = texts(page).find((t) => t.text.startsWith('Group'));
      if (heading) expect(heading.font.startsWith('bold')).toBe(true);
    }
    expect(pages.flatMap(words).filter((w) => /^Group \d+$/.test(w))).toHaveLength(12);
  });

  it('wraps long text within its cell, so the row grows rather than overflowing', () => {
    const long = 'A long description of a part that will not fit on one line of its column at all, however wide the page is';
    const table = parts(1);
    const wide = { ...table, rows: [{ id: 'x', cells: { name: long, length: 1, count: 1, notes: long, grain: true } }] } as UiTable;
    const page = printPages([{ kind: 'table', table: wide }], { width: 100, height: 150 }, 'Wrap', metricQuantityFormatter)[0]!;
    const pieces = texts(page).filter((t) => long.includes(t.text) && t.text.length > 3);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(piece.bounds[2]).toBeLessThanOrEqual(100 - 8 + 0.01);
  });

  it('refuses a printout of more than the page limit', () => {
    let error: unknown;
    try { printPages([{ kind: 'table', table: parts(10_000) }], { width: 30, height: 30 }, 'Tiny', metricQuantityFormatter); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe('limit.exceeded');
    expect((error as Error).message).toContain(String(UI_PRINT_MAX_PAGES));
  });
});

describe('ui.print with tables and text', () => {
  const manifest = { name: 'Cut list', contributions: [{ target: 'model.panel', id: 'p', name: 'P' }] } as unknown as ExtensionManifest;
  const vector = { type: 'vector', id: 'sheet', label: 'Sheet', units: 'length', bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, styles: [{}],
    shapes: [{ kind: 'rect', x: 0, y: 0, width: 0.1, height: 0.1, style: 0 }] };
  const tree = {
    type: 'stack', id: 'root', children: [
      { type: 'stack', id: 'bar', direction: 'horizontal', children: [{ type: 'button', id: 'print', label: 'Print' }] },
      { type: 'stack', id: 'report', children: [
        { type: 'text', id: 'intro', text: 'Summary', variant: 'heading' },
        { type: 'divider', id: 'line' },
        { ...parts(40), id: 'summary', label: 'Summary' },
      ] },
      vector,
      { ...parts(60), id: 'list', label: 'List' },
    ],
  };
  const setup = (printer: ViewPrinter) => {
    const ui = new ExtensionUiHost(manifest, () => {});
    ui.services()['ui.mount']!({ target: 'p', seq: 1, tree }, {} as never);
    const call = { currentDocument: () => 'doc-1' } as never;
    return (input: Record<string, unknown>) => vectorPrintServices(manifest, () => ui, printer)['ui.print']!(
      { target: 'p', page: { width: 0.297, height: 0.21 }, purpose: 'Print the cut list', ...input }, call) as Promise<unknown>;
  };

  it('mixes vector pages and flowing tables in order, formatting for the document the extension acts on', async () => {
    const requests: PrintRequest[] = [];
    const documents: (string | null)[] = [];
    const print = setup({
      print: async (request) => { requests.push(request); return 'saved'; },
      formatter: (documentId) => { documents.push(documentId); return (value, quantity) => `${metricQuantityFormatter(value, quantity)}!`; },
    });
    expect(await print({ components: ['report', 'sheet', 'list'], title: 'Kitchen cut list' })).toEqual({ outcome: 'saved' });
    expect(documents).toEqual(['doc-1']);
    const { pages, title, page } = requests[0]!;
    expect(title).toBe('Kitchen cut list');
    expect(page).toEqual({ width: 297, height: 210 });
    const vectorAt = pages.findIndex((p) => p.name === 'Sheet');
    expect(vectorAt).toBeGreaterThan(0);
    expect(words(pages[vectorAt]!)).not.toContain(`Page ${vectorAt + 1} of ${pages.length}`);
    expect(words(pages[0]!)[0]).toBe('Kitchen cut list');
    expect(words(pages[0]!).filter((w) => w === 'Summary')).toHaveLength(2);
    expect(words(pages[0]!)).toContain('500 mm!');
    expect(words(pages[vectorAt + 1]!)).toContain('List');
    expect(words(pages.at(-1)!)).toContain(`Page ${pages.length} of ${pages.length}`);
    // Without a title, the first component's label names the printout.
    await print({ components: ['list'] });
    expect(requests[1]!.title).toBe('List');
  });

  it('refuses components that cannot be printed, also inside a stack', async () => {
    const print = setup({ print: async () => 'printed' });
    await expect(print({ components: ['print'] })).rejects.toThrow(/button, which cannot be printed/);
    await expect(print({ components: ['root'] })).rejects.toThrow(/cannot be printed/);
    await expect(print({ components: ['missing'] })).rejects.toThrow(/not shown/);
    await expect(print({ components: ['list'], page: { width: 0.01, height: 0.2 } })).rejects.toMatchObject({ code: 'validation.failed' });
  });
});
