// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createLayoutTable, MAX_TABLE_AXIS, type LayoutEntity, type LayoutTable } from '@pushform/layout';
import { readHtmlRichText, type ClipboardRichText } from './layoutClipboardRichText';
import { clipboardColor, clipboardStyleReader } from './clipboardHtml';

function checkSize(rows: number, columns: number) {
  if (rows > MAX_TABLE_AXIS || columns > MAX_TABLE_AXIS)
    throw new Error(`Pasted tables support at most ${MAX_TABLE_AXIS} rows and columns.`);
}

/** Spreadsheet apps often put fills in class rules rather than inline styles. */
function backgroundReader(doc: Document) {
  const styleOf = clipboardStyleReader(doc);
  return (element: HTMLElement): string | undefined => {
    // A row/table background shows through a transparent cell background.
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (!['TD', 'TH', 'TR', 'THEAD', 'TBODY', 'TFOOT', 'TABLE'].includes(node.tagName)) continue;
      const color = clipboardColor(styleOf(node).backgroundColor || node.getAttribute('bgcolor') || '', doc);
      if (color && color !== 'transparent' && color !== '#00000000') return color;
    }
    return undefined;
  };
}

/** Read inert clipboard HTML; never insert external markup or styles into the page. */
function htmlTable(html: string): LayoutTable | null {
  if (!html) return null;
  const element = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!element) return null;
  const rows = Array.from(element.rows).filter(row => row.closest('table') === element);
  if (!rows.length) return null;
  checkSize(rows.length, 1);
  const background = backgroundReader(element.ownerDocument);
  const values = new Map<number, { text: ClipboardRichText; fillColor?: string }>(), occupied = new Set<number>();
  const merges: LayoutTable['merges'] = [];
  let columns = 0;
  rows.forEach((row, r) => {
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      while (occupied.has(r * MAX_TABLE_AXIS + column)) column++;
      const rowSpan = cell.rowSpan === 0 ? rows.length - r : Math.min(cell.rowSpan, rows.length - r);
      const columnSpan = cell.colSpan;
      checkSize(r + rowSpan, column + columnSpan);
      for (let y = r; y < r + rowSpan; y++) for (let x = column; x < column + columnSpan; x++) {
        const key = y * MAX_TABLE_AXIS + x;
        if (occupied.has(key)) throw new Error('The pasted table has overlapping merged cells.');
        occupied.add(key);
      }
      const fillColor = background(cell);
      values.set(r * MAX_TABLE_AXIS + column, { text: readHtmlRichText(cell),
        ...(fillColor ? { fillColor } : {}) });
      if (rowSpan > 1 || columnSpan > 1) merges.push({ row: r, column, rowSpan, columnSpan });
      column += columnSpan;
      columns = Math.max(columns, column);
    }
  });
  if (!columns) return null;
  const table = createLayoutTable(rows.length, columns);
  for (const [key, value] of values) {
    const cell = table.cells[Math.floor(key / MAX_TABLE_AXIS) * columns + key % MAX_TABLE_AXIS]!;
    Object.assign(cell.text, value.text);
    if (value.fillColor) cell.fillColor = value.fillColor;
  }
  table.merges = merges;
  return table;
}

/** Spreadsheet TSV may quote cells containing tabs, newlines or escaped quotes. */
function textTable(text: string): LayoutTable | null {
  if (!text.includes('\t')) return null;
  const rows: string[][] = [], row: string[] = [];
  let value = '', quoted = false, separated = false;
  const source = text.replace(/\r\n?/g, '\n');
  const cell = () => { row.push(value); value = ''; checkSize(rows.length + 1, row.length); };
  const line = () => { cell(); rows.push([...row]); row.length = 0; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && !value) quoted = true;
    else if (char === '\t') { separated = true; cell(); }
    else if (char === '\n') line();
    else value += char;
  }
  if (quoted) throw new Error('The pasted table contains an unfinished quoted cell.');
  if (!separated) return null;
  // A final record separator is customary on spreadsheet clipboards, not an extra row.
  if (!source.endsWith('\n') || row.length || value) line();
  const columns = Math.max(...rows.map(row => row.length));
  const table = createLayoutTable(rows.length, columns);
  rows.forEach((row, r) => row.forEach((content, c) => { table.cells[r * columns + c]!.text.content = content; }));
  return table;
}

export function readClipboardTable(html: string, text: string): LayoutEntity | null {
  const table = htmlTable(html) ?? textTable(text);
  if (!table) return null;
  const width = Math.min(240, table.columns.length * 40), height = Math.min(160, table.rows.length * 10);
  return { id: 0, layerId: 0, kind: 'table', closed: true,
    points: [[0, 0], [width, 0], [width, height], [0, height]], table };
}
