// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, editLayoutTextContent, importLayoutText, lineSpacingRtf, nextLayoutTabStop, resolveLayoutText, rtfFontTable, rtfLineSpacing,
  spaceLayoutLine, tabStopsRtf } from './index';

describe('Layout text', () => {
  it('decodes RTF bytes in each font\'s charset, including macOS font tables and double-byte text', () => {
    // macOS Cocoa RTF: an unbraced font table with a Thai (charset 222) face; ไทย is cp874 E4 B7 C2.
    const thai = '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fnil\\fcharset222 Thonburi;}\\f0 A \\f1 \\\'e4\\\'b7\\\'c2\\f0  caf\\\'e9}';
    expect(importLayoutText(thai).content).toBe('A ไทย café');
    expect([...rtfFontTable(thai)]).toEqual([['0', { name: 'Helvetica', charset: 0 }], ['1', { name: 'Thonburi', charset: 222 }]]);
    // Windows RichEdit with a Japanese code page: 日本 is Shift_JIS 93 FA 96 7B, two bytes per character.
    const japanese = '{\\rtf1\\ansi\\ansicpg932{\\fonttbl{\\f0\\fnil\\fcharset128 MS Gothic;}}\\f0 \\\'93\\\'fa\\\'96\\\'7b}';
    expect(importLayoutText(japanese).content).toBe('日本');
    // macOS list markers are not part of the text.
    expect(importLayoutText('{\\rtf1\\ansi{\\fonttbl\\f0\\fswiss Helvetica;}\\f0 {\\listtext\t\\uc0\\u8226 \t}Item}').content).toBe('Item');
  });

  it('resolves live page and custom fields while preserving unresolved tokens', () => {
    const doc = createLayoutDocument();
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    expect(resolveLayoutText('<PageName> / <PageNumber> / <PageCount> <project>', page, doc.state))
      .toBe('Page 1 / 1 / 1 <project>');
    doc.renamePage(page.id, 'Details');
    doc.addPage();
    expect(resolveLayoutText('<PageName> / <PageCount>', doc.state.pages.get(page.id)!, doc.state)).toBe('Details / 2');
  });
  it('resolves named custom tags and document fields without interpreting old syntax or recursively expanding values', () => {
    const doc = createLayoutDocument();
    doc.undoStack.transact('Set fields', draft => {
      draft.customFields.set('ProjectName', 'Library');
      draft.customFields.set('Address', '123 Main Street');
      draft.customFields.set('FileName', 'Library plans');
      draft.customFields.set('Example', '<PageNumber>');
    });
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    expect(resolveLayoutText('<ProjectName>: <Address> / <FileName> / <CurrentDate>', page, doc.state))
      .toBe(`Library: 123 Main Street / Library plans / ${new Date().toLocaleDateString()}`);
    expect(resolveLayoutText('<Example> <Unknown> <pagename> {{page.number}} {{custom.ProjectName}}', page, doc.state))
      .toBe('<PageNumber> <Unknown> <pagename> {{page.number}} {{custom.ProjectName}}');
    expect(resolveLayoutText('x < y > z; <Missing\nTag>', page, doc.state)).toBe('x < y > z; <Missing\nTag>');
    const empty = createLayoutDocument();
    expect(resolveLayoutText('<FileName>', empty.state.pages.get(empty.state.pageOrder[0]!)!, empty.state)).toBe('Untitled');
  });
  it('keeps rich text styles aligned as content is edited', () => {
    const text = { content: 'hello bold', spans: [{ start: 6, end: 10, bold: true, italic: false, underline: false }] };
    expect(editLayoutTextContent(text, 'new hello bold').spans[0]).toMatchObject({ start: 10, end: 14 });
    expect(editLayoutTextContent(text, 'hello bolder').spans[0]).toMatchObject({ start: 6, end: 12 });
    expect(editLayoutTextContent(text, 'hello ').spans).toEqual([]);
  });
  it('imports RTF groups, inline styles, unicode, and paragraphs while skipping metadata', () => {
    const result = importLayoutText(String.raw`{\rtf1{\fonttbl{\f0 Arial;}}Plain {\b bold} \i italic\i0\par \u233? \'e9}`);
    expect(result.content).toBe('Plain bold italic\né é');
    expect(result.spans.find((span) => span.bold)).toMatchObject({ start: 6, end: 10 });
    expect(result.spans.some((span) => span.italic)).toBe(true);
    expect(importLayoutText('plain\ntext')).toEqual({ content: 'plain\ntext', spans: [] });
    expect(() => importLayoutText(String.raw`{\rtf1 broken`)).toThrow('Unbalanced');
  });
  it('keeps each run\'s font, size, and color, resolving PostScript faces', () => {
    const result = importLayoutText(String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0\fnil Arial;}{\f1\fnil Verdana-Bold;}}{\colortbl ;\red255\green0\blue0;}` +
      String.raw`\pard\f0\fs36 Title\par\f1\fs16\cf1 small red\par\plain plain}`);
    expect(result.content).toBe('Title\nsmall red\nplain');
    expect(result.spans).toEqual([
      { start: 0, end: 6, bold: false, italic: false, underline: false, fontFamily: 'Arial', fontSizePt: 18, color: '#000000' },
      { start: 6, end: 16, bold: true, italic: false, underline: false, fontFamily: 'Verdana', fontSizePt: 8, color: '#ff0000' },
      // \plain returns to the default font, 12 pt, and the automatic color.
      { start: 16, end: 21, bold: false, italic: false, underline: false, fontFamily: 'Arial', fontSizePt: 12, color: '#000000' },
    ]);
  });
  it('reads macOS paragraph breaks and the first paragraph\'s line spacing', () => {
    const cocoa = '{\\rtf1\\ansi\\cocoartf1265\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n' +
      '\\pard\\tx720\\sl192\\slmult1\\pardirnatural\n\n\\f0\\fs24 \\cf0 I created this \\\ntext in TextEdit\\\n}';
    expect(importLayoutText(cocoa)).toMatchObject({ content: 'I created this \ntext in TextEdit\n', lineSpacing: { mode: 'multiple', value: 0.8 } });
    expect(importLayoutText(String.raw`{\rtf1\pard\sl240\slmult1 single}`).lineSpacing).toBeUndefined();
    expect(importLayoutText(String.raw`{\rtf1\pard\sl-280\slmult0 exact\par\pard\sl480\slmult1 later}`).lineSpacing).toEqual({ mode: 'exactly', value: 14 });
    expect(importLayoutText(String.raw`{\rtf1\pard\sl300 at least}`).lineSpacing).toEqual({ mode: 'atLeast', value: 15 });
  });
  it('reads the first paragraph\'s tab stops and finds the next stop as LayOut does', () => {
    const key = '{\\rtf1\\ansi\\cocoartf2576\n{\\fonttbl\\f0\\fnil\\fcharset0 Verdana;}\n' +
      '\\pard\\tx1120\\tx560\\tx1680\\pardirnatural\n\n\\f0\\fs20 \\cf0 WM\t\tWashing Machine\\\nTD\t\tTumble Dryer}';
    expect(importLayoutText(key)).toMatchObject({ content: 'WM\t\tWashing Machine\nTD\t\tTumble Dryer', tabStopsPt: [28, 56, 84] });
    expect(importLayoutText(String.raw`{\rtf1\pard\tx720 a\tab b}`)).toMatchObject({ content: 'a\tb', tabStopsPt: [36] });
    // \pard clears stops; a paragraph without them has LayOut's default.
    expect(importLayoutText(String.raw`{\rtf1\pard\tx720\par\pard plain}`).tabStopsPt).toBeUndefined();
    const pt = 25.4 / 72;
    expect(nextLayoutTabStop(0, [28, 56]) / pt).toBeCloseTo(28);
    expect(nextLayoutTabStop(28 * pt, [28, 56]) / pt).toBeCloseTo(56);
    // Past the last stop, and with no stops at all, tabs advance every half inch.
    expect(nextLayoutTabStop(60 * pt, [28, 56]) / pt).toBeCloseTo(72);
    expect(nextLayoutTabStop(36 * pt, undefined) / pt).toBeCloseTo(72);
    expect(nextLayoutTabStop(1 * pt, []) / pt).toBeCloseTo(36);
    expect(tabStopsRtf([28, 56, 84])).toBe('\\tx560\\tx1120\\tx1680');
    expect(tabStopsRtf(undefined)).toBe('');
  });
  it('writes line spacing back as the RTF it reads', () => {
    for (const spacing of [{ mode: 'multiple', value: 0.8 }, { mode: 'multiple', value: 1.5 }, { mode: 'exactly', value: 14 }, { mode: 'atLeast', value: 15 }] as const) {
      const [, sl, slmult] = /\\sl(-?\d+)\\slmult(\d)/.exec(lineSpacingRtf(spacing))!;
      expect(rtfLineSpacing(Number(sl), Number(slmult))).toEqual(spacing);
    }
    expect(lineSpacingRtf(undefined)).toBe('\\sl240\\slmult1');
    expect(lineSpacingRtf({ mode: 'multiple', value: 1 })).toBe('\\sl240\\slmult1');
  });
  it('spaces lines as LayOut does: multiples keep the baseline, fixed heights keep the descent', () => {
    const pt = 25.4 / 72;
    expect(spaceLayoutLine(9, 2, undefined)).toEqual({ ascent: 9, height: 11 });
    expect(spaceLayoutLine(9, 2, { mode: 'multiple', value: 0.8 })).toEqual({ ascent: 9, height: 8.8 });
    expect(spaceLayoutLine(9, 2, { mode: 'multiple', value: 2 })).toEqual({ ascent: 9, height: 22 });
    expect(spaceLayoutLine(9, 2, { mode: 'exactly', value: 18 / pt })).toMatchObject({ ascent: expect.closeTo(16), height: expect.closeTo(18) });
    expect(spaceLayoutLine(9, 2, { mode: 'atLeast', value: 5 / pt }).height).toBe(11);
    expect(spaceLayoutLine(9, 2, { mode: 'atLeast', value: 20 / pt }).height).toBeCloseTo(20);
  });
});
