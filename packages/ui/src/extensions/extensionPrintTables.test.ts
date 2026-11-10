// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import { validateUiTree, type UiTable } from '@pushform/extension-protocol';
import { printPages, textWidth } from '@pushform/extensions';
import { writeLayoutSvg } from '@pushform/io/vector';
import { writeLayoutPdf } from '../components/layoutPdf';
import { PrintPrompts, browserViewPrinter } from './extensionPrint';

const metric: UnitSettings = { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', volumeUnit: 'm³' };
const table = validateUiTree({
  type: 'table', id: 't', label: 'Parts',
  columns: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'length', label: 'Length', kind: 'number', quantity: 'length' },
    { id: 'area', label: 'Σ Area', kind: 'number', quantity: 'area' }],
  rows: [{ id: 'g', cells: {}, heading: 'Plywood 18 mm' },
    ...Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, cells: { name: i ? `Shelf ${i} – ½ lap, ×2` : 'Étagère Łódź 棚板', length: 0.6096, area: 0.37 } }))],
}) as UiTable;

const printer = (units: Record<string, UnitSettings>) =>
  browserViewPrinter(new PrintPrompts(), { print: async () => {}, savePdf: async () => true }, (id) => units[id] ?? null);

describe('printed tables in the document units', () => {
  it('formats quantities as the panel does, for the document the extension acts on', () => {
    const host = printer({ metric, imperial: DEFAULT_UNITS });
    expect(host.formatter!('metric')(0.6096, 'length')).toBe('609.6mm');
    expect(host.formatter!('imperial')(0.6096, 'length')).toBe(`2'`);
    expect(host.formatter!('imperial')(0.37, 'area')).toMatch(/ft²$/);
    // Without a known document, the editor's default units.
    expect(host.formatter!(null)(0.6096, 'length')).toBe(`2'`);
    expect(host.formatter!('closed')(0.0254, 'length')).toBe(`1"`);
  });

  it('measures text as the PDF writer draws it, so right-aligned numbers line up', async () => {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    // The PDF writer draws without kerning, so a line advances by the sum of its glyphs' widths.
    const drawn = (font: typeof regular, text: string): number => [...text].reduce((sum, char) => sum + font.widthOfTextAtSize(char, 10), 0);
    for (const sample of ['Shelf 12 – ½ lap, ×2', `2' 3 1/2"`, '609.6 mm', 'Quantity (pcs) µ°²³±…—', 'WWW iii {|}~']) {
      expect(textWidth(sample, 10)).toBeCloseTo(drawn(regular, sample), 6);
      expect(textWidth(sample, 10, true)).toBeCloseTo(drawn(bold, sample), 6);
    }
  });

  it('writes the same pages as SVG for printing and as PDF', async () => {
    const host = printer({ metric });
    const pages = printPages([{ kind: 'table', table }], { width: 210, height: 297 }, 'Bookcase cut list', host.formatter!('metric'));
    expect(pages.length).toBe(2);
    const svg = writeLayoutSvg(pages[0]!, 'page');
    expect(svg).toContain('609.6mm');
    expect(svg).toContain('Page 1 of 2');
    // Text the standard PDF font cannot write is spelled with characters it can, so the PDF is written.
    expect(svg).toContain('Sum Area');
    expect(svg).toContain('Étagère Lódz ??');
    const { bytes } = await writeLayoutPdf(pages, async () => null);
    const read = await PDFDocument.load(bytes);
    expect(read.getPageCount()).toBe(2);
    const [width, height] = [read.getPage(0).getWidth(), read.getPage(0).getHeight()];
    expect(width).toBeCloseTo((210 / 25.4) * 72, 0);
    expect(height).toBeCloseTo((297 / 25.4) * 72, 0);
  });
});

 it('uses the subtree override when formatting a printed table', () => {
  const host = printer({ metric });
  const format = host.formatter!('metric', { lengthUnit: 'in', format: 'decimal', lengthPrecision: 2 });
  const pages = printPages([{ kind: 'table', table, formatter: format }], { width: 210, height: 297 }, 'Job', host.formatter!('metric'));
  expect(writeLayoutSvg(pages[0]!, 'page')).toContain('24.00&quot;');
  expect(host.formatter!('metric')(0.6096, 'length')).toBe('609.6mm');
 });
