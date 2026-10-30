// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { LAYOUT_TEXT_INSET_MM, createLayoutDocument, type LayoutEntity } from '@pushform/layout';
import { layoutEditorTabSizeMm, layoutTextBlock, fittedLayoutTextBounds, paintLayoutText } from './layoutText';

it('renders wrapped rich text and a label leader in paper units', () => {
  const doc = createLayoutDocument();
  const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const ctx = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), closePath: vi.fn(), setLineDash: vi.fn(),
    strokeRect: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillText: vi.fn<(text: string, x: number, y: number) => void>(),
    measureText: vi.fn((text: string) => ({ width: text.length * 2 })),
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '',
  };
  const entity: LayoutEntity = { id: 3, kind: 'label', layerId: 1, points: [[10, 10], [22, 30], [0, 0]], closed: false,
    text: { content: 'A <PageNumber>\nBold words wrap', fontFamily: 'Arial', fontSizePt: 12,
      color: '#ff0000', bold: false, italic: false, underline: false, align: 'left', vertical: 'top',
      bounded: true, leader: 'elbow', endpoint: 'arrow',
      spans: [{ start: 15, end: 19, bold: true, italic: false, underline: true }] } };
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, entity, page, doc.state, true);
  expect(ctx.fillText.mock.calls.map((call) => call[0]).join('')).toBe('A 1Bold words wrap');
  expect(ctx.lineTo).toHaveBeenCalledWith(0, 0);
  expect(ctx.clip).toHaveBeenCalledOnce();
  expect(new Set(ctx.fillText.mock.calls.map((call) => call[2])).size).toBeGreaterThan(2);
  expect(ctx.strokeRect).toHaveBeenCalledWith(10, 10, 12, 20);
  expect(ctx.restore).toHaveBeenCalledOnce();
});

it('keeps expanded custom tag formatting tied to its source and treats brace tokens literally', () => {
  const doc = createLayoutDocument();
  doc.undoStack.transact('Custom tag', draft => { draft.customFields.set('ProjectName', 'Library'); });
  const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const content = 'A <ProjectName> Z {{page.number}}';
  const text = { content, fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false, underline: false,
    align: 'left' as const, vertical: 'top' as const, bounded: false, leader: 'none' as const, endpoint: 'none' as const,
    spans: [{ start: 2, end: 15, bold: true, italic: false, underline: false }] };
  const ctx = { measureText: (char: string) => ({ width: char.length }), font: '' };
  const glyphs = layoutTextBlock(ctx as CanvasRenderingContext2D, text, 100, page, doc.state).lines.flat();
  expect(glyphs.map(glyph => glyph.char).join('')).toBe('A Library Z {{page.number}}');
  expect(glyphs.slice(2, 9).every(glyph => glyph.bold)).toBe(true);
  expect(glyphs[10]?.bold).toBe(false);
});

it('paints cached model Auto-Text with its source token style', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const text = { content: '<ComponentInstance> <Missing>', fontFamily: 'Arial', fontSizePt: 12, color: '#222222',
    bold: false, italic: false, underline: false, align: 'left' as const, vertical: 'top' as const, bounded: false,
    leader: 'none' as const, endpoint: 'none' as const,
    spans: [{ start: 0, end: 19, bold: true, italic: false, underline: false }] };
  const ctx = { measureText: (char: string) => ({ width: char.length }), font: '' };
  const glyphs = layoutTextBlock(ctx as CanvasRenderingContext2D, text, 100, page, doc.state, { ComponentInstance: 'Window' }).lines.flat();
  expect(glyphs.map(glyph => glyph.char).join('')).toBe('Window <Missing>');
  expect(glyphs.slice(0, 6).every(glyph => glyph.bold)).toBe(true);
  expect(glyphs[7]!.bold).toBe(false);
});

it('wraps complete words and clips oversized content to the exact drawn rectangle', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const text = { content: 'one two enormousword', fontFamily: 'Arial', fontSizePt: 12, color: '#222222',
    bold: false, italic: false, underline: false, align: 'left' as const, vertical: 'top' as const,
    bounded: true, leader: 'none' as const, endpoint: 'none' as const };
  const ctx = { save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(),
    rect: vi.fn(), clip: vi.fn(), fillText: vi.fn(), measureText: (value: string) => ({ width: value.length * 2 }) };
  const context = ctx as unknown as CanvasRenderingContext2D;
  const lines = layoutTextBlock(context, text, 12, page, doc.state).lines.map(line => line.map(glyph => glyph.char).join(''));
  expect(lines).toEqual(['one ', 'two ', 'enormousword']);
  const entity: LayoutEntity = { id: 3, kind: 'text', layerId: 1, points: [[10, 10], [22, 10.5]], closed: false, text };
  paintLayoutText(context, entity, page, doc.state, false);
  expect(ctx.rect).toHaveBeenCalledWith(10, 10, 12, 0.5);
  expect(ctx.clip).toHaveBeenCalledOnce();
  const bounds = fittedLayoutTextBounds(context, { ...entity, text: { ...text, content: 'short\nlonger' } }, page, doc.state);
  // Arial's ascent plus descent (the stand-in where the canvas reports none) and the side insets.
  expect(bounds[1][0]).toBeCloseTo(22 + 2 * LAYOUT_TEXT_INSET_MM);
  expect(bounds[1][1]).toBeCloseTo(10 + 2 * 12 * 25.4 / 72 * 1.117);
});

it('measures and paints each selected font, size, color, and emphasis while fitting mixed-height lines', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const painted: { char: string; font: string; color: string }[] = [];
  const ctx = { font: '', fillStyle: '', save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), strokeRect: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    measureText() { return { width: parseFloat(this.font.replace(/^(italic |bold )*/g, '')) }; },
    fillText(char: string) { painted.push({ char, font: this.font, color: this.fillStyle }); } };
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'text', closed: false, points: [[10, 10], [70, 50]],
    text: { content: 'Ab\nc', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false, underline: false,
      align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none',
      spans: [{ start: 1, end: 2, fontFamily: 'Georgia', fontSizePt: 24, color: '#ff0000', bold: true, italic: true, underline: true }] } };
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, entity, page, doc.state, false);
  expect(painted).toEqual([
    { char: 'A', font: `${12 * 25.4 / 72}px "Arial", sans-serif`, color: '#222222' },
    { char: 'b', font: `italic bold ${24 * 25.4 / 72}px "Georgia", sans-serif`, color: '#ff0000' },
    { char: 'c', font: `${12 * 25.4 / 72}px "Arial", sans-serif`, color: '#222222' },
  ]);
  const bounds = fittedLayoutTextBounds(ctx as unknown as CanvasRenderingContext2D, entity, page, doc.state);
  expect(bounds[1][0] - 10).toBeCloseTo((12 + 24) * 25.4 / 72 + 2 * LAYOUT_TEXT_INSET_MM);
  expect(bounds[1][1] - 10).toBeCloseTo((24 + 12) * 25.4 / 72 * 1.117);
});

it('sets lines as LayOut does: inset from the sides, baselines one ascent down, spaced by ascent plus descent', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const calls: [string, number, number][] = [];
  const ctx = { font: '', fillStyle: '', textBaseline: '', save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), strokeRect: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    measureText: () => ({ width: 1, fontBoundingBoxAscent: 3, fontBoundingBoxDescent: 1 }),
    fillText(char: string, x: number, y: number) { calls.push([char, x, y]); } };
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'text', closed: false, points: [[10, 20], [60, 50]],
    text: { content: 'a\nb', fontFamily: 'Verdana', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false,
      align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } };
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, entity, page, doc.state, false);
  expect(ctx.textBaseline).toBe('alphabetic');
  expect(calls).toEqual([['a', 10 + LAYOUT_TEXT_INSET_MM, 23], ['b', 10 + LAYOUT_TEXT_INSET_MM, 27]]);
  calls.length = 0;
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, { ...entity, text: { ...entity.text!, align: 'right' } }, page, doc.state, false);
  expect(calls[0]![1]).toBeCloseTo(60 - LAYOUT_TEXT_INSET_MM - 1);
});

it('sizes each line by its own fonts and an empty line by its paragraph mark, then applies line spacing', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  // Metrics proportional to the font size in the canvas font string: ascent 0.9 em, descent 0.2 em.
  const ctx = { font: '', measureText() {
    const size = parseFloat(this.font.replace(/^(italic |bold )*/g, ''));
    return { width: size, fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.2 };
  } };
  const mm = (pt: number) => pt * 25.4 / 72;
  // A large first run sets the box style; the small lines below it keep their own height.
  const text = { content: 'Title\nsmall\n\nsmall', fontFamily: 'Arial', fontSizePt: 20, color: '#000000', bold: false, italic: false, underline: false,
    align: 'left' as const, vertical: 'top' as const, bounded: false, leader: 'none' as const, endpoint: 'none' as const,
    spans: [{ start: 6, end: 18, bold: false, italic: false, underline: false, fontSizePt: 10 }] };
  const block = layoutTextBlock(ctx as unknown as CanvasRenderingContext2D, text, Infinity, page, doc.state);
  expect(block.lineHeights.map(height => height / mm(1))).toEqual([20, 10, 10, 10].map(size => expect.closeTo(size * 1.1)));
  expect(block.lineAscents[1]! / mm(1)).toBeCloseTo(9);
  const spaced = layoutTextBlock(ctx as unknown as CanvasRenderingContext2D, { ...text, lineSpacing: { mode: 'multiple', value: 0.8 } }, Infinity, page, doc.state);
  expect(spaced.lineHeights.map(height => height / mm(1))).toEqual([20, 10, 10, 10].map(size => expect.closeTo(size * 1.1 * 0.8)));
  expect(spaced.lineAscents[0]! / mm(1)).toBeCloseTo(18);
  const exact = layoutTextBlock(ctx as unknown as CanvasRenderingContext2D, { ...text, lineSpacing: { mode: 'exactly', value: 14 } }, Infinity, page, doc.state);
  expect(exact.lineHeights.every(height => Math.abs(height - mm(14)) < 1e-9)).toBe(true);
  expect(exact.lineAscents[1]! / mm(1)).toBeCloseTo(14 - 2);
});

it('advances a tab to the next tab stop, so a two-column key lines up in painting and fitting', () => {
  const doc = createLayoutDocument(), page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
  const calls: [string, number][] = [];
  const ctx = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '', save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(),
    strokeRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    measureText: () => ({ width: 1, fontBoundingBoxAscent: 3, fontBoundingBoxDescent: 1 }),
    fillText(char: string, x: number) { calls.push([char, x]); } };
  const pt = 25.4 / 72, left = 10 + LAYOUT_TEXT_INSET_MM;
  const entity: LayoutEntity = { id: 3, layerId: 1, kind: 'text', closed: false, points: [[10, 20], [110, 50]],
    text: { content: 'WM\t\tWashing Machine\nTD\t\tTumble Dryer', tabStopsPt: [28, 56, 84], fontFamily: 'Verdana', fontSizePt: 10,
      color: '#000000', bold: false, italic: false, underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } };
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, entity, page, doc.state, false);
  const columns = calls.filter(([char]) => char === 'W' || char === 'T').map(([, x]) => x);
  // Both keys start at the left; both descriptions start at the second stop, two tabs along, measured from the box's side.
  expect(columns).toEqual([left, expect.closeTo(10 + 56 * pt), left, expect.closeTo(10 + 56 * pt)]);
  const fitted = fittedLayoutTextBounds(ctx as unknown as CanvasRenderingContext2D, { ...entity, text: { ...entity.text!, bounded: false } }, page, doc.state);
  expect(fitted[1][0] - fitted[0][0]).toBeCloseTo(56 * pt + 'Washing Machine'.length + LAYOUT_TEXT_INSET_MM);
  // Without stops, tabs fall every half inch.
  calls.length = 0;
  const { tabStopsPt: _stops, ...plain } = entity.text!;
  paintLayoutText(ctx as unknown as CanvasRenderingContext2D, { ...entity, text: { ...plain, content: 'a\tb' } }, page, doc.state, false);
  expect(calls.find(([char]) => char === 'b')![1]).toBeCloseTo(10 + 36 * pt);
});

it('spaces tabs in the on-page editors at evenly spaced stops, or the default otherwise', () => {
  const pt = 25.4 / 72;
  expect(layoutEditorTabSizeMm({})).toBeCloseTo(36 * pt);
  expect(layoutEditorTabSizeMm({ tabStopsPt: [28, 56, 84] })).toBeCloseTo(28 * pt);
  expect(layoutEditorTabSizeMm({ tabStopsPt: [20, 90] })).toBeCloseTo(36 * pt);
});
