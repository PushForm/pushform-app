// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { LayoutText } from './LayoutDocument';
import { editLayoutTextContent, formatLayoutTextRange, layoutTextStyleAt } from './text';

function fixture(): LayoutText {
  const a = new Map([['', [new Uint8Array([0xa0, 6, 7])]], ['fontFamily', [new Uint8Array([0xa0, 6, 8])]]]);
  const b = new Map([['', [new Uint8Array([0xa0, 6, 9])]]]);
  return { content: 'abcdef', fontFamily: 'Arial', fontSizePt: 12, color: '#000000', bold: false, italic: false, underline: false,
    align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none', spans: [
      { start: 0, end: 4, bold: true, italic: false, underline: false, fontFamily: 'Arial', nativeUnknownFields: a },
      { start: 2, end: 6, bold: false, italic: true, underline: false, nativeUnknownFields: b },
    ] };
}

it('splits rich text owners without losing overlapping metadata or changing unrelated visible formatting', () => {
  const original = fixture(), before = structuredClone(original), patch = { bold: false, color: '#123456', fontFamily: 'Arial' };
  const result = { ...original, ...formatLayoutTextRange(original, { start: 1, end: 5 }, patch) };
  for (let i = 0; i < original.content.length; i++) {
    expect(layoutTextStyleAt(result, i)).toEqual({ ...layoutTextStyleAt(original, i), ...(i >= 1 && i < 5 ? patch : {}) });
    const owners = (text: LayoutText) => text.spans!.filter(s => i >= s.start && i < s.end).map(s => s.nativeUnknownFields).filter(Boolean);
    expect(owners(result)).toEqual(owners(original));
  }
  expect(result.spans!.filter(s => s.nativeUnknownFields?.has('fontFamily')).every(s => s.fontFamily === 'Arial')).toBe(true);
  expect(original).toEqual(before);
  const repeated = { ...result, ...formatLayoutTextRange(result, { start: 1, end: 5 }, patch) };
  expect(repeated).toEqual(result);
});

it('retains fields when formatting the entire text and when content shifts surviving ranges', () => {
  const text = fixture(), formatted = { ...text, ...formatLayoutTextRange(text, { start: 0, end: 6 }, { underline: true }) };
  expect(formatted.spans!.map(s => s.nativeUnknownFields)).toEqual(text.spans!.map(s => s.nativeUnknownFields));
  const edited = editLayoutTextContent(formatted, 'Xabcdef');
  expect(edited.spans.map(s => [s.start, s.end])).toEqual([[0, 5], [3, 7]]);
  expect(edited.spans.map(s => s.nativeUnknownFields)).toEqual(text.spans!.map(s => s.nativeUnknownFields));
  expect(editLayoutTextContent(formatted, '').spans).toEqual([]);
});
