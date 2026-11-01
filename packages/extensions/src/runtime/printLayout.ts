// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, UI_PRINT_MAX_PAGES, type UiNodeOf, type UiQuantity, type UiTable } from '@pushform/extension-protocol';
import type { LayoutVectorItem, LayoutVectorPage, VectorPoint } from '@pushform/io/vector';

/**
 * Print layout of an extension's tables and text. The host draws them itself, from the validated components on
 * screen, as pages in millimeters for the same SVG and PDF writers as vector views, so printing and saving as PDF
 * give the same pages.
 *
 * A flowing page has the request title at the top and "Page n of m" at the bottom. Text wraps to the page width.
 * A table prints its label, then a header row that repeats at the top of every page it continues on, then its rows,
 * striped, with a rule under the header and between rows. Heading rows span every column, in bold, and never end a
 * page. Hidden columns are left out. Number cells are right-aligned and shown in the document's units, as on screen;
 * booleans print as "Yes" or "No" and choices as their labels.
 *
 * Column widths start from each column's widest content. When the table is wider than the page, number, boolean and
 * choice columns keep their width and text columns give way down to their longest word, then the type gets smaller
 * (down to about 6 pt); text wraps within its cell, up to a few lines and then ends with an ellipsis. Rows are never
 * split across pages. Text is measured with Helvetica's metrics: the pages name Arial, which SVG viewers draw with
 * Arial or Helvetica (the two share their widths), and the PDF writer, which embeds no Arial, writes the standard
 * Helvetica font, so measured widths match both. That font writes only Latin text, so printed text keeps to its
 * characters (`printableText`), and Print and Save as PDF show the same.
 */

/** Formats a table number the way the panel shows it. */
export type QuantityFormatter = (value: number, quantity: UiQuantity | undefined) => string;

/** What flows onto pages: printable components with vectors already drawn as pages of their own. */
export type PrintBlock =
  | { readonly kind: 'page'; readonly page: LayoutVectorPage }
  | { readonly kind: 'table'; readonly table: UiTable }
  | { readonly kind: 'text'; readonly text: UiNodeOf<'text'> }
  | { readonly kind: 'divider' };

const FONT = '"Arial"';
const BODY = 3; // about 8.5 pt
const MIN_BODY = 2.2; // about 6 pt
const TITLE = 4.6;
const FOOTER = 2.6;
const LINE = 1.25;
const PAD_X = 1.2;
const PAD_Y = 0.8;
const MAX_CELL_LINES = 6;
const TEXT_SIZES = { heading: 4.2, subheading: 3.5, body: BODY, caption: 2.6, code: BODY } as const;
const INK = '#000000', MUTED = '#555555', RULE = '#c8c8c8', DARK_RULE = '#404040', STRIPE = '#f2f2f2', HEADING_FILL = '#e2e2e2';

// Helvetica advance widths in 1/1000 em, regular then bold, from the standard font metrics: ASCII 32-126, Latin-1
// 160-255, and the other characters of the Windows code page the standard PDF fonts encode.
const REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
  944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
  944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const LATIN_REGULAR = [278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333,
  333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778,
  778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
const LATIN_BOLD = [278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333,
  333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778,
  778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611,
  611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556];
const CODE_PAGE = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const CODE_PAGE_REGULAR = [556, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 611, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 500, 500];
const CODE_PAGE_BOLD = [556, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 611, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 500, 556];

const codePageIndex = (char: string): number => CODE_PAGE.indexOf(char);

/** The width of `text` in millimeters at `size` millimeters, in Helvetica. Characters it does not know count as a digit. */
export function textWidth(text: string, size: number, bold = false): number {
  const ascii = bold ? BOLD : REGULAR, latin = bold ? LATIN_BOLD : LATIN_REGULAR, other = bold ? CODE_PAGE_BOLD : CODE_PAGE_REGULAR;
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? ascii[code - 32]! : code >= 160 && code <= 255 ? latin[code - 160]! : other[codePageIndex(char)] ?? 556;
  }
  return (units / 1000) * size;
}

const SUBSTITUTES: Record<string, string> = {
  'Σ': 'Sum', '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=', '→': '->', '←': '<-', '′': "'", '″': '"', '−': '-', '‐': '-', '‑': '-', '⁄': '/',
  '✓': 'v', '✔': 'v', '⌀': 'Ø', '∅': 'Ø', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', '\t': ' ',
};

/**
 * `text` in the characters the standard PDF fonts can write (ASCII, Latin-1 and the Windows code page's extras), so
 * Save as PDF never fails on a character and prints and PDFs show the same text: common symbols become their ASCII
 * spelling (Σ becomes "Sum"), accented letters outside the set lose their accent, and anything else becomes "?".
 */
export function printableText(text: string): string {
  const writable = (char: string): boolean => {
    const code = char.codePointAt(0)!;
    return (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || codePageIndex(char) >= 0;
  };
  let out = '';
  for (const char of text) {
    if (writable(char) || char === '\n') { out += char; continue; }
    const substitute = SUBSTITUTES[char];
    if (substitute !== undefined) { out += substitute; continue; }
    const plain = char.normalize('NFD').replace(/\p{M}/gu, '');
    out += plain && [...plain].every(writable) ? plain : char.codePointAt(0)! < 32 ? ' ' : '?';
  }
  return out;
}

// Widths compared with room to spare for rounding, so a column sized to its text keeps it whole.
const FITS = 1e-6;

const ellipsize = (text: string, width: number, size: number, bold: boolean): string => {
  width += FITS;
  if (textWidth(text, size, bold) <= width) return text;
  const chars = [...text];
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(chars.slice(0, mid).join('') + '…', size, bold) <= width) low = mid; else high = mid - 1;
  }
  return chars.slice(0, low).join('').trimEnd() + '…';
};

/** `text` broken into lines no wider than `width`: at spaces, and inside words longer than a line. Explicit newlines are kept. */
export function wrapText(text: string, width: number, size: number, bold = false, maxLines = Infinity): string[] {
  const lines: string[] = [];
  width += FITS;
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      if (lines.length > maxLines) break;
      const joined = line ? `${line} ${word}` : word;
      if (textWidth(joined, size, bold) <= width) { line = joined; continue; }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (rest && textWidth(rest, size, bold) > width && lines.length <= maxLines) {
        const chars = [...rest];
        let n = 1, used = textWidth(chars[0]!, size, bold);
        while (n < chars.length && used + textWidth(chars[n]!, size, bold) <= width) used += textWidth(chars[n++]!, size, bold);
        lines.push(chars.slice(0, n).join(''));
        rest = chars.slice(n).join('');
      }
      line = rest;
    }
    lines.push(line);
    if (lines.length > maxLines) break;
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]}…`, width, size, bold);
  return kept;
}

type Column = UiTable['columns'][number];
type Cell = string | number | boolean | null;

const isRigid = (column: Column): boolean => column.kind !== 'text';
const isEnd = (column: Column): boolean => column.align === 'end' || column.kind === 'number';

function cellText(column: Column, value: Cell | undefined, format: QuantityFormatter): string {
  return printableText(rawCellText(column, value, format));
}

function rawCellText(column: Column, value: Cell | undefined, format: QuantityFormatter): string {
  if (value === null || value === undefined) return '';
  if (column.kind === 'number') return typeof value === 'number' ? format(value, column.quantity) : String(value);
  if (column.kind === 'boolean') return value === true ? 'Yes' : 'No';
  if (column.kind === 'choice') return column.options?.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

interface TableFit {
  readonly size: number;
  readonly widths: number[];
}

/** Column widths that fill `available` millimeters, and the type size they need. */
export function fitColumns(headers: readonly string[], cells: readonly (readonly string[])[], rigid: readonly boolean[], available: number): TableFit {
  const longestWord = (text: string, size: number, bold: boolean): number =>
    Math.max(0, ...text.split(/\s+/).map((word) => textWidth(word, size, bold)));
  const measure = (size: number) => headers.map((header, c) => {
    let natural = textWidth(header, size, true), word = longestWord(header, size, true);
    for (const row of cells) {
      const text = row[c]!;
      if (!text) continue;
      natural = Math.max(natural, Math.max(...text.split('\n').map((line) => textWidth(line, size))));
      if (!rigid[c]) word = Math.max(word, longestWord(text, size, false));
    }
    natural += 2 * PAD_X;
    // A text column gives way to its longest word, but no further than a quarter of the page or narrower than 10 mm.
    const least = rigid[c] ? natural : Math.min(natural, Math.max(Math.min(word + 2 * PAD_X, available / 4), 10));
    return { natural, least };
  });
  for (let size = BODY; ; size = Math.max(MIN_BODY, size - 0.2)) {
    const columns = measure(size);
    const natural = columns.reduce((sum, c) => sum + c.natural, 0);
    const least = columns.reduce((sum, c) => sum + c.least, 0);
    if (natural <= available) {
      // Room to spare goes to every column in proportion to its content.
      return { size, widths: columns.map((c) => (c.natural * available) / natural) };
    }
    if (least <= available) {
      const give = natural - least, short = natural - available;
      return { size, widths: columns.map((c) => c.natural - ((c.natural - c.least) * short) / give) };
    }
    if (size === MIN_BODY) return { size, widths: columns.map((c) => (c.least * available) / least) };
  }
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function frameOf(width: number, height: number): Frame {
  const margin = Math.min(12, Math.min(width, height) * 0.08);
  const top = margin + TITLE * 1.6, bottom = height - margin - FOOTER * 2;
  return { width, height, left: margin, right: width - margin, top, bottom: Math.max(bottom, top + 1) };
}

class Pages {
  readonly pages: { page: LayoutVectorPage; flow: boolean }[] = [];
  private current: LayoutVectorItem[] | null = null;
  y = 0;

  constructor(readonly frame: Frame, private readonly name: string) {}

  get fresh(): boolean { return this.current !== null && this.y === this.frame.top; }

  /** Starts a flowing page unless the current one is still empty. */
  ensure(): void { if (!this.current) this.newPage(); }

  newPage(): void {
    if (this.pages.length >= UI_PRINT_MAX_PAGES)
      throw new ExtensionError('limit.exceeded', `The printout would have more than ${UI_PRINT_MAX_PAGES} pages.`);
    this.current = [];
    this.pages.push({ page: { paperUnits: 'mm', name: this.name, width: this.frame.width, height: this.frame.height, background: '#ffffff', items: this.current }, flow: true });
    this.y = this.frame.top;
  }

  /** Makes room for `height` millimeters, starting a page when they do not fit; true when a page was started. */
  room(height: number): boolean {
    this.ensure();
    if (this.y + height <= this.frame.bottom || this.fresh) return false;
    this.newPage();
    return true;
  }

  vector(page: LayoutVectorPage): void {
    if (this.pages.length >= UI_PRINT_MAX_PAGES)
      throw new ExtensionError('limit.exceeded', `The printout would have more than ${UI_PRINT_MAX_PAGES} pages.`);
    this.pages.push({ page, flow: false });
    this.current = null;
  }

  rect(x: number, y: number, width: number, height: number, fill: string): void {
    this.current!.push({ kind: 'path', layer: 'Table', clips: [], evenodd: false, fill, stroke: null, weight: 0, dash: [],
      path: { segments: [{ kind: 'move', point: [x, y] }, { kind: 'line', point: [x + width, y] }, { kind: 'line', point: [x + width, y + height] },
        { kind: 'line', point: [x, y + height] }, { kind: 'close' }] } });
  }

  rule(y: number, weight: number, color: string): void {
    this.current!.push(lineItem([this.frame.left, y], [this.frame.right, y], weight, color, 'Table'));
  }

  text(items: LayoutVectorItem[] | null, text: string, x: number, baseline: number, size: number, options: { bold?: boolean; end?: boolean; color?: string; layer?: string } = {}): void {
    if (!text) return;
    (items ?? this.current!).push(textItem(text, x, baseline, size, options));
  }
}

const lineItem = (from: VectorPoint, to: VectorPoint, weight: number, color: string, layer: string): LayoutVectorItem =>
  ({ kind: 'path', layer, clips: [], evenodd: false, fill: null, stroke: color, weight, dash: [],
    path: { segments: [{ kind: 'move', point: from }, { kind: 'line', point: to }] } });

function textItem(text: string, x: number, baseline: number, size: number, options: { bold?: boolean; end?: boolean; color?: string; layer?: string }): LayoutVectorItem {
  const width = textWidth(text, size, options.bold);
  const left = options.end ? x - width : x;
  return { kind: 'text', layer: options.layer ?? 'Text', clips: [], text, point: [x, baseline], matrix: [1, 0, 0, 1, 0, 0],
    font: `${options.bold ? 'bold ' : ''}${round(size)}px ${FONT}`, color: options.color ?? INK, align: options.end ? 'end' : 'start',
    baseline: 'alphabetic', bounds: [left, baseline - size * 0.72, left + width, baseline + size * 0.22] };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function layoutText(pages: Pages, node: UiNodeOf<'text'>): void {
  const variant = node.variant ?? 'body';
  const size = TEXT_SIZES[variant];
  const bold = variant === 'heading' || variant === 'subheading';
  const color = variant === 'caption' || node.tone === 'muted' ? MUTED : INK;
  const lines = wrapText(printableText(node.text), pages.frame.right - pages.frame.left, size, bold);
  const before = bold ? size * 0.8 : size * 0.3;
  pages.ensure();
  if (!pages.fresh) pages.y += before;
  for (const [i, line] of lines.entries()) {
    // A heading keeps at least two body lines below it on its page.
    pages.room(size * LINE + (bold && i === lines.length - 1 ? BODY * LINE * 2 : 0));
    pages.text(null, line, pages.frame.left, pages.y + size, size, { bold, color });
    pages.y += size * LINE;
  }
  pages.y += size * 0.3;
}

function layoutTable(pages: Pages, table: UiTable, format: QuantityFormatter): void {
  const hidden = new Set(table.hiddenColumns ?? []);
  const columns = table.columns.filter((c) => !hidden.has(c.id));
  const cells = table.rows.map((row) => (row.heading !== undefined ? columns.map(() => '') : columns.map((c) => cellText(c, row.cells[c.id], format))));
  const { left, right } = pages.frame;
  const { size, widths } = fitColumns(columns.map((c) => printableText(c.label)), cells, columns.map(isRigid), right - left);
  const lineHeight = size * LINE;
  const xs = widths.reduce<number[]>((at, w) => [...at, at.at(-1)! + w], [left]);

  const lines = (texts: readonly string[], bold: boolean, wrap: boolean): string[][] => texts.map((text, c) => {
    const inner = widths[c]! - 2 * PAD_X;
    if (!wrap || isRigid(columns[c]!)) return [ellipsize(text.replace(/\s*\n\s*/g, ' '), inner, size, bold)];
    return wrapText(text, inner, size, bold, MAX_CELL_LINES);
  });
  const header = lines(columns.map((c) => printableText(c.label)), true, true);
  const headerHeight = Math.max(...header.map((l) => l.length)) * lineHeight + 2 * PAD_Y;

  const drawRow = (texts: string[][], height: number, bold: boolean): void => {
    for (const [c, column] of columns.entries()) {
      for (const [i, line] of texts[c]!.entries()) {
        const baseline = pages.y + PAD_Y + i * lineHeight + size * 0.95;
        if (baseline > pages.y + height) break;
        pages.text(null, line, isEnd(column) ? xs[c + 1]! - PAD_X : xs[c]! + PAD_X, baseline, size, { bold, end: isEnd(column), layer: 'Table' });
      }
    }
  };
  const drawHeader = (continued: boolean): void => {
    const caption = `${printableText(table.label)}${continued ? ' (continued)' : ''}`;
    pages.text(null, ellipsize(caption, right - left, BODY + 0.4, true), left, pages.y + BODY + 0.4, BODY + 0.4, { bold: true });
    pages.y += (BODY + 0.4) * LINE + 0.6;
    drawRow(header, headerHeight, true);
    pages.y += headerHeight;
    pages.rule(pages.y, 0.3, DARK_RULE);
  };
  const captionHeight = (BODY + 0.4) * LINE + 0.6;
  const fullHeight = Math.max(rowHeight(1), pages.frame.bottom - pages.frame.top - captionHeight - headerHeight);

  pages.ensure();
  if (!pages.fresh) pages.y += BODY;
  const firstRow = table.rows[0];
  const firstHeight = firstRow ? rowHeight(firstRow.heading !== undefined ? 1 : Math.max(...lines(cells[0]!, false, true).map((l) => l.length))) : 0;
  pages.room(captionHeight + headerHeight + Math.min(firstHeight, fullHeight));
  drawHeader(false);

  function rowHeight(count: number): number { return count * lineHeight + 2 * PAD_Y; }

  let stripe = false;
  for (const [r, row] of table.rows.entries()) {
    const heading = row.heading !== undefined;
    const texts = heading ? [[ellipsize(printableText(row.heading!), right - left - 2 * PAD_X, size, true)]] : lines(cells[r]!, false, true);
    // A row taller than a whole page is cut to the lines that fit.
    const height = Math.min(rowHeight(Math.max(...texts.map((l) => l.length))), fullHeight);
    // A heading row keeps the row after it on its page.
    const next = table.rows[r + 1];
    const keep = heading && next && next.heading === undefined ? rowHeight(Math.max(...lines(cells[r + 1]!, false, true).map((l) => l.length))) : 0;
    if (pages.y + height + Math.min(keep, fullHeight - height) > pages.frame.bottom) {
      pages.newPage();
      drawHeader(true);
    }
    if (heading) {
      pages.rect(left, pages.y, right - left, height, HEADING_FILL);
      pages.text(null, texts[0]![0]!, left + PAD_X, pages.y + PAD_Y + size * 0.95, size, { bold: true, layer: 'Table' });
      stripe = false;
    } else {
      if (stripe) pages.rect(left, pages.y, right - left, height, STRIPE);
      stripe = !stripe;
      drawRow(texts, height, false);
    }
    pages.y += height;
    pages.rule(pages.y, 0.1, RULE);
  }
}

/**
 * The pages of a print request, in the order of its blocks: vector pages as they are, and flowing pages for tables,
 * text and dividers between them, each with the title and its page number. Throws `limit.exceeded` past the page limit.
 */
export function printPages(blocks: readonly PrintBlock[], paper: { width: number; height: number }, title: string, format: QuantityFormatter): LayoutVectorPage[] {
  title = printableText(title);
  const pages = new Pages(frameOf(paper.width, paper.height), title);
  for (const block of blocks) {
    if (block.kind === 'page') pages.vector(block.page);
    else if (block.kind === 'table') layoutTable(pages, block.table, format);
    else if (block.kind === 'text') layoutText(pages, block.text);
    else { pages.room(2); pages.y += 1; pages.rule(pages.y, 0.2, RULE); pages.y += 1; }
  }
  const total = pages.pages.length;
  const { frame } = pages;
  return pages.pages.map(({ page, flow }, i) => {
    if (!flow) return page;
    const chrome: LayoutVectorItem[] = [];
    pages.text(chrome, ellipsize(title, (frame.right - frame.left) * 0.98, TITLE, true), frame.left, frame.top - TITLE * 0.9, TITLE, { bold: true, layer: 'Page' });
    chrome.push(lineItem([frame.left, frame.top - TITLE * 0.5], [frame.right, frame.top - TITLE * 0.5], 0.3, DARK_RULE, 'Page'));
    pages.text(chrome, `Page ${i + 1} of ${total}`, frame.right, frame.height - Math.min(12, Math.min(frame.width, frame.height) * 0.08), FOOTER, { end: true, color: MUTED, layer: 'Page' });
    return { ...page, items: [...chrome, ...page.items] };
  });
}

/** Quantities without a document's settings: lengths in millimeters, areas in square meters, volumes in cubic meters. */
export const metricQuantityFormatter: QuantityFormatter = (value, quantity) => {
  const n = (v: number, digits: number): string => String(Number(v.toFixed(digits)));
  switch (quantity) {
    case 'length': return `${n(value * 1000, 1)} mm`;
    case 'area': return `${n(value, 3)} m²`;
    case 'volume': return `${n(value, 4)} m³`;
    case 'angle': return `${n(value, 1)}°`;
    case 'percent': return `${n(value * 100, 2)} %`;
    case 'count': return String(Math.round(value));
    default: return String(Number(value.toPrecision(12)));
  }
};
