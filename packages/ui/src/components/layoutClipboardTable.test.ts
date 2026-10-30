// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { validLayoutTable } from '@pushform/layout';
import { readClipboardTable } from './layoutClipboardTable';

it('reads spreadsheet TSV with empty cells, ragged rows, quoted values and a trailing record separator', () => {
  const table = readClipboardTable('', 'Name\tNotes\tQty\r\n"A\tB"\t"Line 1\nLine ""2"""\t\r\nEnd\r\n')!.table!;
  expect(table.rows).toHaveLength(3); expect(table.columns).toHaveLength(3);
  expect(table.cells.map(cell => cell.text.content)).toEqual(['Name', 'Notes', 'Qty', 'A\tB', 'Line 1\nLine "2"', '', 'End', '', '']);
  expect(validLayoutTable(table)).toBe(true);
});

it('prefers HTML tables, retaining headers, merged cells, blank cells, entities and cell line breaks', () => {
  const html = '<table><tr><th colspan="2">Header &amp; title</th></tr><tr><td rowspan="2">A<br>B</td><td></td></tr><tr><td><div>C</div><div>D</div></td></tr></table>';
  const table = readClipboardTable(html, 'fallback\ttext')!.table!;
  expect(table.rows).toHaveLength(3); expect(table.columns).toHaveLength(2);
  expect(table.cells.map(cell => cell.text.content)).toEqual(['Header & title', '', 'A\nB', '', '', 'C\nD']);
  expect(table.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }, { row: 1, column: 0, rowSpan: 2, columnSpan: 1 }]);
  expect(validLayoutTable(table)).toBe(true);
});

it('supports a single HTML column, rowspan=0, and leaves ordinary text alone', () => {
  const table = readClipboardTable('<table><tr><td rowspan="0">All rows</td><td>1</td></tr><tr><td>2</td></tr></table>', '')!.table!;
  expect(table.merges).toEqual([{ row: 0, column: 0, rowSpan: 2, columnSpan: 1 }]);
  expect(readClipboardTable('<table><tr><td>One</td></tr><tr><td>Two</td></tr></table>', '')!.table!.columns).toHaveLength(1);
  expect(readClipboardTable('', 'ordinary\nmultiline text')).toBeNull();
});

it('retains inline, legacy and spreadsheet class backgrounds with the CSS cascade', () => {
  const table = readClipboardTable(`<style>
    td { background: #eeeeee; }
    .xl65 { background-color: #ffff00; }
    .xl65 { background: #00ff00; }
    .important { background-color: #ff0000 !important; }
  </style><table><tr>
    <td class="xl65">Class</td>
    <td class="xl65" style="background:#123456">Inline</td>
    <td class="important" style="background-color:blue">Important</td>
    <td bgcolor="#abcdef">CSS overrides bgcolor</td>
  </tr></table>`, '')!.table!;
  expect(table.cells.map(cell => cell.fillColor)).toEqual(['#00ff00', '#123456', '#ff0000', '#eeeeee']);
  expect(validLayoutTable(table)).toBe(true);
});

it('retains row/table fills and merged-cell fills, ignoring invalid colors and external background images', () => {
  const table = readClipboardTable(`<table bgcolor="#aabbcc"><tr style="background-color:#112233">
    <td colspan="2" style="background-color:#abcdef">Merged</td></tr>
    <tr><td style="background:transparent">Table</td><td bgcolor="#ff0000">Legacy</td></tr>
    <tr><td style="background:url(https://example.com/image.png);color:red">Image</td><td style="background-color:var(--unknown)">Variable</td></tr>
  </table>`, '')!.table!;
  expect(table.cells.map(cell => cell.fillColor)).toEqual(['#abcdef', undefined, '#aabbcc', '#ff0000', '#aabbcc', '#aabbcc']);
  expect(table.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }]);
  expect(readClipboardTable('', 'Plain\ttext')!.table!.cells.every(cell => cell.fillColor === undefined)).toBe(true);
});

it('accepts the maximum grid and rejects oversized or malformed table content', () => {
  expect(readClipboardTable('', Array.from({ length: 100 }, () => Array(100).fill('x').join('\t')).join('\n') + '\n')!.table!.cells).toHaveLength(10000);
  expect(() => readClipboardTable('', Array(101).fill('a\tb').join('\n'))).toThrow('at most 100');
  expect(() => readClipboardTable('', Array(101).fill('x').join('\t'))).toThrow('at most 100');
  expect(() => readClipboardTable('<table><tr><td colspan="101">Large</td></tr></table>', '')).toThrow('at most 100');
  expect(() => readClipboardTable('', 'a\t"unfinished')).toThrow('unfinished');
});
