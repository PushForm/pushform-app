// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LAYOUT_DEFAULT_TEXT, layoutTextStyleAt, type LayoutText } from '@pushform/layout';
import { insertClipboardRichText, readClipboardRichText, readHtmlRichText } from './layoutClipboardRichText';

const data = (values: Record<string, string>) => ({ getData: (type: string) => values[type] ?? '' }) as DataTransfer;
const html = (source: string) => readHtmlRichText(new DOMParser().parseFromString(source, 'text/html').body);
const text = (rich = html('')): LayoutText => ({ ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false, underline: false,
  bounded: false, align: 'left', vertical: 'top', leader: 'none', endpoint: 'none', ...rich });

it('imports HTML emphasis, font/color/size runs, class styles, line breaks and paragraph settings', () => {
  const rich = html('<style>.note {font: italic 16px Arial; color:#123456}</style><p style="text-align:center;line-height:1.5">Plain <b>bold</b> <span class="note"><u>styled</u></span><br>end</p>');
  expect(rich.content).toBe('Plain bold styled\nend');
  expect(rich.align).toBe('center'); expect(rich.lineSpacing).toEqual({ mode: 'multiple', value: 1.5 });
  expect(layoutTextStyleAt(text(rich), 6).bold).toBe(true);
  expect(layoutTextStyleAt(text(rich), 11)).toMatchObject({ italic: true, underline: true, fontFamily: 'Arial', fontSizePt: 12, color: '#123456' });
});

it('retains paragraph/list order and preformatted text, excluding hidden content and executable markup', () => {
  const rich = html('<p>First</p><ol start="3"><li>One</li><li>Two</li></ol><pre>A\tB\nC</pre><span style="display:none">hidden</span><script>bad()</script>');
  expect(rich.content).toBe('First\n3. One\n4. Two\nA\tB\nC');
});

it('prefers HTML rich text, reads RTF and supports plain-text paste without a plain representation', () => {
  const rtf = '{\\rtf1\\ansi Plain \\b bold\\b0}';
  const rich = readClipboardRichText(data({ 'text/rtf': rtf }))!;
  expect(rich.content).toBe('Plain bold');
  expect(layoutTextStyleAt(text(rich), 7).bold).toBe(true);
  expect(readClipboardRichText(data({ 'text/html': '<b>HTML</b>', 'text/rtf': rtf }))!.content).toBe('HTML');
  expect(readClipboardRichText(data({ 'text/html': '<b>HTML</b>' }), true)).toEqual({ content: 'HTML' });
});

it('replaces selected text and shifts existing styles without leaking formatting into surrounding text', () => {
  const original = text(html('<i>before</i> replace <u>after</u>'));
  const rich = insertClipboardRichText(original, 7, 14, html('<b>new</b>'));
  expect(rich.content).toBe('before new after');
  expect(layoutTextStyleAt(text(rich), 2).italic).toBe(true);
  expect(layoutTextStyleAt(text(rich), 8).bold).toBe(true);
  expect(layoutTextStyleAt(text(rich), 11)).toMatchObject({ underline: true, bold: false });
});
