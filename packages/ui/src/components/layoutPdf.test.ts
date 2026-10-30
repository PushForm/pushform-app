// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { LayoutVectorPage } from '@pushform/io';
import { writeLayoutPdf } from './layoutPdf';
import { pdfPageRange } from './layoutPdfExport';

const source: LayoutVectorPage = { name: 'Sheet', width: 297, height: 210, background: '#ffffff', items: [
  { kind: 'path', layer: '', clips: [], path: { segments: [{ kind: 'move', point: [10, 10] }, { kind: 'line', point: [90, 10] }, { kind: 'cubic', c1: [100, 20], c2: [100, 30], point: [90, 40] }, { kind: 'close' }] }, fill: '#ff000080', stroke: '#000000', weight: 0.5, dash: [2, 1], evenodd: true },
  { kind: 'text', layer: '', clips: [], text: 'Vector text', font: '4px "Roboto"', color: '#000000', align: 'left', baseline: 'alphabetic', point: [12, 30], matrix: [1, 0, 0, 1, 0, 0], bounds: [12, 26, 40, 31] },
] };

it('writes physically sized pages with vector curves, even-odd fills, dashes, transparency and subset selectable fonts', async () => {
  const require = createRequire(import.meta.url);
  const font = new Uint8Array(readFileSync(require.resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff')));
  const result = await writeLayoutPdf([source, { ...source, width: 210, height: 297 }], async () => font);
  expect(result.warnings).toEqual([]);
  const pdf = await PDFDocument.load(result.bytes);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(297 * 72 / 25.4);
  expect(pdf.getPage(1).getHeight()).toBeCloseTo(297 * 72 / 25.4);
  const streams = pdf.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream && !object.dict.has(PDFName.of('Length1')) ? [object] : []);
  const content = streams.map(stream => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n');
  expect(content).toContain('B*'); expect(content).toContain('[2 1] 0 d'); expect(content).toContain('100 20 100 30 90 40 c');
  expect(content).toContain(' Tj'); expect(content).toContain('beginbfchar');
  const fonts = pdf.context.enumerateIndirectObjects().map(([, object]) => String(object)).join('\n');
  expect(fonts).toContain('/FontFile2'); expect(fonts).toContain('/ca 0.5019607843137255');
});

it('reports system font substitution and rejects unavailable webfonts instead of silently omitting text', async () => {
  const result = await writeLayoutPdf([source], async () => null);
  expect(result.warnings[0]).toContain('Roboto');
  await expect(writeLayoutPdf([source], async () => { throw new Error('offline'); })).rejects.toThrow('offline');
});

it('selects user page ranges in document order and rejects invalid ranges', () => {
  expect(pdfPageRange([40, 20, 70, 10], '4, 1-2, 2')).toEqual([40, 20, 10]);
  for (const range of ['', '0', '5', '3-1', '1-', '1.5']) expect(() => pdfPageRange([1, 2, 3, 4], range)).toThrow('page numbers');
});
