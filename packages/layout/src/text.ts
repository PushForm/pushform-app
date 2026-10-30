// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { layoutAccountFields } from './accountFields';
import type { LayoutDocumentState, LayoutLineSpacing, LayoutPage, LayoutPageNumbering, LayoutPageNumberStyle, LayoutText, LayoutTextSpan, LayoutTextStyle } from './LayoutDocument';

export const LAYOUT_AUTO_TEXT_TAGS: readonly string[] = ['PageNumber', 'PageName', 'PageCount', 'FileName', 'CurrentDate'];

/** Built-in tags that cannot number pages. */
export const LAYOUT_NON_PAGE_NUMBER_TAGS: readonly string[] = ['PageName', 'PageCount', 'FileName', 'CurrentDate'];

/** `<PageNumber>` until its settings change: the first page, from 1, in arabic numerals. */
export const DEFAULT_LAYOUT_PAGE_NUMBERING: LayoutPageNumbering = { startPageId: null, startNumber: 1, style: 'arabic' };

/** A number in a page-number style: 01 for two-digit, A … Z, AA … for letters, and Roman numerals from I to MMMCMXCIX. */
export function formatLayoutPageNumber(value: number, style: LayoutPageNumberStyle): string {
  const letters = (n: number): string => { let s = ''; for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + (v - 1) % 26) + s; return s || 'A'; };
  const roman = (n: number): string => {
    let s = '', v = Math.max(1, Math.min(3999, n));
    for (const [unit, symbol] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const)
      while (v >= unit) { s += symbol; v -= unit; }
    return s;
  };
  switch (style) {
    case 'two-digit': return String(value).padStart(2, '0');
    case 'upper-letter': return letters(value);
    case 'lower-letter': return letters(value).toLowerCase();
    case 'upper-roman': return roman(value);
    case 'lower-roman': return roman(value).toLowerCase();
    default: return String(value);
  }
}

/** A page-number field's settings, or null when the name is not one; `<PageNumber>` always is. */
export function layoutPageNumbering(name: string, state: LayoutDocumentState): LayoutPageNumbering | null {
  return state.pageNumberFields?.get(name) ?? (name === 'PageNumber' ? DEFAULT_LAYOUT_PAGE_NUMBERING : null);
}

/** What a page-number field shows on a page: nothing before its start page; a deleted start page counts from the first. */
export function layoutPageNumberText(numbering: LayoutPageNumbering, page: LayoutPage, state: LayoutDocumentState): string {
  const position = state.pageOrder.indexOf(page.id);
  const start = Math.max(0, numbering.startPageId === null ? 0 : state.pageOrder.indexOf(numbering.startPageId));
  return position < start ? '' : formatLayoutPageNumber(numbering.startNumber + position - start, numbering.style);
}

/** The default text style for text, labels, tables, and dimensions. */
export const LAYOUT_DEFAULT_TEXT = { fontFamily: 'Verdana', fontSizePt: 10, color: '#000000' } as const;

/** Text sits 0.03 in from its box's left and right sides. */
export const LAYOUT_TEXT_INSET_MM = 0.03 * 25.4;

/**
 * Unknown tokens stay visible so unresolved fields are never silently discarded. Page tags first, then the document's
 * custom fields, then the account's profile.
 */
export function resolveLayoutText(content: string, page: LayoutPage, state: LayoutDocumentState, modelFields?: Readonly<Record<string, string>>): string {
  const account = layoutAccountFields();
  return content.replace(/<([^<>\r\n]+)>/g, (token, key: string) => {
    if (key === 'PageName') return page.name;
    const numbering = layoutPageNumbering(key, state);
    if (numbering) return layoutPageNumberText(numbering, page, state);
    if (key === 'PageCount') return String(state.pageOrder.length);
    if (key === 'FileName') return state.customFields.get('FileName') ?? 'Untitled';
    if (key === 'CurrentDate') return new Date().toLocaleDateString();
    if (modelFields && Object.hasOwn(modelFields, key)) return modelFields[key]!;
    return state.customFields.get(key) ?? account.get(key) ?? token;
  });
}

/** Freeze model Auto-Text for a disconnected label or appearance-only export, keeping each token's character style. */
export function bakeLayoutModelText(text: LayoutText, fields: Readonly<Record<string, string>> | undefined): LayoutText {
  if (!fields) return text;
  let result = text;
  for (const match of [...text.content.matchAll(/<([^<>\r\n]+)>/g)].reverse()) {
    const key = match[1]!;
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key]!, start = match.index, end = start + match[0].length;
    const changed = editLayoutTextContent(result, result.content.slice(0, start) + value + result.content.slice(end));
    result = { ...result, ...changed, spans: [...changed.spans ?? [],
      ...(value.length ? [{ start, end: start + value.length, ...layoutTextStyleAt(text, start) }] : []),
    ] };
  }
  return result;
}

/** RTF `\fcharset` values and `\ansicpg` code pages as WHATWG encoding labels. */
const CHARSET_ENCODINGS: Record<number, string> = {
  0: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253',
  162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257',
  204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250',
};
const CODEPAGE_ENCODINGS: Record<number, string> = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh' };

function codepageEncoding(codepage: number): string {
  return CODEPAGE_ENCODINGS[codepage] ?? (codepage >= 1250 && codepage <= 1258 ? `windows-${codepage}` : 'windows-1252');
}

/**
 * Font table entries by font number. Handles Windows RichEdit tables (`{\f0\fnil\fcharset0 Arial;}`) and
 * macOS Cocoa tables without per-font groups (`\f1\fnil\fcharset222 Thonburi;`).
 */
export function rtfFontTable(source: string): Map<string, { name: string; charset: number }> {
  const fonts = new Map<string, { name: string; charset: number }>();
  const start = source.indexOf('{\\fonttbl');
  if (start < 0) return fonts;
  let depth = 0, end = start;
  for (; end < source.length; end++) {
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  for (const entry of source.slice(start + '{\\fonttbl'.length, end).split(';')) {
    const id = /\\f(\d+)/.exec(entry)?.[1];
    if (id === undefined) continue;
    const name = entry.replace(/\{\\\*[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?|[{}]/gi, '').trim();
    fonts.set(id, { name, charset: Number(/\\fcharset(\d+)/.exec(entry)?.[1] ?? 0) });
  }
  return fonts;
}

/**
 * Font family and style from an RTF font name. Documents saved on macOS name PostScript faces
 * (ArialMT, Verdana-Bold, TimesNewRomanPSMT, GillSans), which browsers do not resolve, so they become
 * the family (Arial, Verdana, Times New Roman, Gill Sans) plus bold/italic.
 */
export function postScriptFace(name: string): { family: string; bold: boolean; italic: boolean } {
  if (/\s/.test(name) || !/^[A-Za-z0-9-]+$/.test(name)) return { family: name, bold: false, italic: false };
  const [base = name, style = ''] = name.replace(/(PS)?MT$/, '').split('-', 2);
  const styleName = style.replace(/(PS)?MT$/, '');
  const bold = /Bold|Black|Heavy|Semibold|Demi/i.test(styleName) && !/^Black$/i.test(styleName);
  const italic = /Italic|Oblique/i.test(styleName);
  // A style that is neither weight nor slant (Arial-Black, Gill Sans-Light) is part of the family name.
  const family = (bold || italic || !styleName ? base : `${base}${styleName}`).replace(/(PS)?MT$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return { family, bold, italic };
}

/** `\colortbl` entries by `\cf` index; index 0 (often empty) is the automatic color, black. */
function rtfColorTable(source: string): string[] {
  const colors: string[] = [];
  const table = /\{\\colortbl\s*([^}]*)\}/.exec(source)?.[1];
  if (table) for (const entry of table.split(';').slice(0, -1)) {
    const channel = (name: string) => Number(new RegExp(`\\\\${name}(\\d+)`).exec(entry)?.[1] ?? 0);
    colors.push(entry.trim() ? `#${[channel('red'), channel('green'), channel('blue')].map((value) => value.toString(16).padStart(2, '0')).join('')}` : '#000000');
  }
  return colors;
}

/** RTF paragraph line spacing (`\slN\slmultM`, twips) as a text box's line spacing; single spacing is undefined. */
export function rtfLineSpacing(sl: number, slmult: number): LayoutLineSpacing | undefined {
  if (sl === 0) return undefined;
  if (slmult === 1) return Math.abs(sl) === 240 ? undefined : { mode: 'multiple', value: Math.round(Math.abs(sl) / 240 * 1000) / 1000 };
  return sl < 0 ? { mode: 'exactly', value: -sl / 20 } : { mode: 'atLeast', value: sl / 20 };
}

/** The RTF paragraph controls for a line spacing, the inverse of `rtfLineSpacing`. */
export function lineSpacingRtf(spacing: LayoutLineSpacing | undefined): string {
  if (!spacing || spacing.mode === 'multiple' && spacing.value === 1) return '\\sl240\\slmult1';
  if (spacing.mode === 'multiple') return `\\sl${Math.round(spacing.value * 240)}\\slmult1`;
  const twips = Math.round(spacing.value * 20);
  return spacing.mode === 'exactly' ? `\\sl-${twips}\\slmult0` : `\\sl${twips}\\slmult0`;
}

/** The tab interval where a paragraph sets no stops, and past its last one: half an inch. */
export const LAYOUT_DEFAULT_TAB_PT = 36;

/**
 * Where a tab starting `position` mm from the left side of its text box ends: the first stop past it, then every half
 * inch past the last stop.
 */
export function nextLayoutTabStop(position: number, stopsPt: readonly number[] | undefined): number {
  const mm = 25.4 / 72, epsilon = 1e-6;
  for (const stop of stopsPt ?? []) if (stop * mm > position + epsilon) return stop * mm;
  const interval = LAYOUT_DEFAULT_TAB_PT * mm;
  return (Math.floor((position + epsilon) / interval) + 1) * interval;
}

/** The RTF paragraph controls for tab stops, the inverse of `\txN` import. */
export function tabStopsRtf(stopsPt: readonly number[] | undefined): string {
  return (stopsPt ?? []).map(stop => `\\tx${Math.round(stop * 20)}`).join('');
}

/**
 * Import the text body and its character formatting from RTF without executing embedded objects: per-run font family,
 * size, color, bold, italic and underline, plus the line spacing and tab stops of the first paragraph with text.
 */
export function importLayoutText(source: string): {
  content: string;
  spans: LayoutTextSpan[];
  lineSpacing?: LayoutLineSpacing;
  tabStopsPt?: number[];
} {
  if (!source.startsWith('{\\rtf')) return { content: source, spans: [] };
  let content = '';
  const spans: LayoutTextSpan[] = [];
  // `\'xx` bytes are in the current font's charset, else the document code page.
  const fonts = rtfFontTable(source);
  const faces = new Map([...fonts].map(([id, font]) => [id, postScriptFace(font.name)]));
  const colors = rtfColorTable(source);
  const documentEncoding = codepageEncoding(Number(/\\ansicpg(\d+)/.exec(source)?.[1] ?? 1252));
  const defaultFont = /\\deff(\d+)/.exec(source)?.[1] ?? fonts.keys().next().value ?? '0';
  const fontEncoding = (id: string): string => {
    const charset = fonts.get(id)?.charset ?? 0;
    return charset === 0 || charset === 1 || charset === 2 ? documentEncoding : CHARSET_ENCODINGS[charset] ?? documentEncoding;
  };
  // RTF's default size is 12 pt (`\fs24`); `\cf0` is the automatic color.
  let state = { bold: false, italic: false, underline: false, skip: false, uc: 1, encoding: fontEncoding(defaultFont),
    font: defaultFont, size: 24, color: 0, sl: 0, slmult: 0, tabs: [] as readonly number[] };
  const stack: typeof state[] = [];
  let fallback = 0;
  let lineSpacing: LayoutLineSpacing | undefined, tabStopsPt: number[] | undefined, spaced = false;
  // Consecutive bytes decode together, so double-byte (CJK) characters stay whole.
  let bytes: number[] = [], bytesEncoding = documentEncoding;
  const flush = (): void => {
    if (!bytes.length) return;
    const decoded = new TextDecoder(bytesEncoding).decode(new Uint8Array(bytes));
    bytes = [];
    append(decoded);
  };
  const append = (value: string): void => {
    if (state.skip) return;
    if (fallback > 0) { fallback--; return; }
    if (!spaced && /[^\n]/.test(value)) {
      spaced = true; lineSpacing = rtfLineSpacing(state.sl, state.slmult);
      if (state.tabs.length) tabStopsPt = [...state.tabs].sort((a, b) => a - b).map(twips => twips / 20);
    }
    const face = faces.get(state.font);
    const run: LayoutTextSpan = { start: content.length, end: content.length + value.length,
      bold: state.bold || !!face?.bold, italic: state.italic || !!face?.italic, underline: state.underline,
      ...(face ? { fontFamily: face.family } : {}), fontSizePt: state.size / 2, color: colors[state.color] ?? '#000000' };
    content += value;
    const previous = spans.at(-1);
    if (previous && previous.end === run.start && (['bold', 'italic', 'underline', 'fontFamily', 'fontSizePt', 'color'] as const)
      .every(key => previous[key] === run[key])) previous.end = run.end;
    else spans.push(run);
  };
  for (const match of source.matchAll(/\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|([^])/gi)) {
    const [, word, argument, hex, symbol, brace, char] = match;
    if (hex) {
      if (state.skip) continue;
      if (fallback > 0) { fallback--; continue; }
      if (bytes.length && bytesEncoding !== state.encoding) flush();
      bytesEncoding = state.encoding;
      bytes.push(parseInt(hex, 16));
      continue;
    }
    flush();
    if (brace === '{') { stack.push({ ...state }); continue; }
    if (brace === '}') { const parent = stack.pop(); if (!parent) throw new Error('Unbalanced RTF'); state = parent; continue; }
    if (word) {
      // listtext holds a list paragraph's visible marker (macOS); the list kind is read separately.
      if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'listtable', 'listoverridetable', 'listtext'].includes(word)) state.skip = true;
      if (state.skip) continue;
      if (word === 'f') { state.font = argument ?? '0'; state.encoding = fontEncoding(state.font); }
      if (word === 'fs') state.size = Math.max(1, Number(argument ?? 24));
      if (word === 'cf') state.color = Number(argument ?? 0);
      if (word === 'b') state.bold = argument !== '0';
      if (word === 'i') state.italic = argument !== '0';
      if (word === 'ul') state.underline = argument !== '0';
      if (word === 'ulnone') state.underline = false;
      if (word === 'plain') {
        Object.assign(state, { bold: false, italic: false, underline: false, font: defaultFont, size: 24, color: 0 });
        state.encoding = fontEncoding(defaultFont);
      }
      if (word === 'pard') { state.sl = 0; state.slmult = 0; state.tabs = []; }
      if (word === 'tx' && Number(argument) > 0) state.tabs = [...state.tabs, Number(argument)];
      if (word === 'sl') state.sl = Number(argument ?? 0);
      if (word === 'slmult') state.slmult = Number(argument ?? 0);
      if (word === 'par' || word === 'line') append('\n');
      if (word === 'tab') append('\t');
      if (word === 'uc') state.uc = Math.max(0, Number(argument ?? 1));
      if (word === 'u') { fallback = 0; append(String.fromCharCode(Number(argument) & 0xffff)); fallback = state.uc; }
    } else if (symbol === '*') state.skip = true;
    else if (symbol === '~') append(' ');
    // macOS (Cocoa) RTF ends a paragraph with a backslash before the line break.
    else if (symbol === '\n' || symbol === '\r') append('\n');
    else if (symbol && ['\\', '{', '}'].includes(symbol)) append(symbol);
    else if (char && char !== '\r' && char !== '\n') append(char);
  }
  flush();
  if (stack.length) throw new Error('Unbalanced RTF');
  return { content, spans, ...(lineSpacing ? { lineSpacing } : {}), ...(tabStopsPt ? { tabStopsPt } : {}) };
}

/**
 * A line's height and first-baseline offset under the box's line spacing, from the natural ascent and
 * descent of its largest font. The baseline stays one descent above the bottom of the line.
 */
export function spaceLayoutLine(ascent: number, descent: number, spacing: LayoutLineSpacing | undefined): { ascent: number; height: number } {
  const natural = ascent + descent;
  const points = (spacing?.value ?? 0) * 25.4 / 72;
  const height = !spacing ? natural : spacing.mode === 'multiple' ? natural * spacing.value
    : spacing.mode === 'exactly' ? points : Math.max(natural, points);
  return { ascent: spacing?.mode === 'multiple' ? ascent : height - descent, height };
}

/** Keep formatting ranges aligned with a text edit using its unchanged prefix and suffix. */
export function editLayoutTextContent(text: { content: string; spans?: ReturnType<typeof importLayoutText>['spans'] }, content: string): ReturnType<typeof importLayoutText> {
  let start = 0;
  while (start < text.content.length && start < content.length && text.content[start] === content[start]) start++;
  let oldEnd = text.content.length, newEnd = content.length;
  while (oldEnd > start && newEnd > start && text.content[oldEnd - 1] === content[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  return { content, spans: (text.spans ?? []).map((span) => ({ ...span,
    start: span.start <= start ? span.start : span.start >= oldEnd ? span.start + delta : start,
    end: span.end < start ? span.end : span.end >= oldEnd ? span.end + delta : newEnd,
  })).filter((span) => span.end > span.start) };
}

/** Resolve legacy emphasis spans and newer character font/color/size overrides. */
export function layoutTextStyleAt(text: LayoutText, index: number): LayoutTextStyle {
  const style: LayoutTextStyle = { bold: text.bold, italic: text.italic, underline: text.underline,
    fontFamily: text.fontFamily, fontSizePt: text.fontSizePt, color: text.color };
  for (const span of text.spans ?? []) if (index >= span.start && index < span.end) {
    for (const key of Object.keys(style) as (keyof LayoutTextStyle)[]) {
      const value = span[key];
      if (value !== undefined) Object.assign(style, { [key]: value });
    }
  }
  return style;
}

/** Apply only the requested attributes, retaining all other formatting and unaffected characters. */
export function formatLayoutTextRange(text: LayoutText, range: { start: number; end: number }, patch: Partial<LayoutTextStyle>): Partial<LayoutText> {
  const start = Math.max(0, Math.min(range.start, text.content.length)), end = Math.max(start, Math.min(range.end, text.content.length));
  if (start === end || start === 0 && end === text.content.length)
    return { ...patch, ...(text.spans ? { spans: text.spans.map(span => ({ ...span, ...patch })) } : {}) };
  const spans: LayoutTextSpan[] = [];
  const nativeSpans = text.spans?.filter(span => span.nativeUnknownFields?.size) ?? [];
  let previousRun: LayoutTextSpan[] = [];
  for (let index = 0; index < text.content.length; index++) {
    const style = { ...layoutTextStyleAt(text, index), ...(index >= start && index < end ? patch : {}) };
    const owners = nativeSpans.filter(span => index >= span.start && index < span.end).map(span => span.nativeUnknownFields!);
    // Optional wire wrappers remain present when their unknown fields still have an owner.
    const overrides = { bold: style.bold, italic: style.italic, underline: style.underline,
      ...(style.fontFamily !== text.fontFamily || owners.some(fields => fields.has('fontFamily')) ? { fontFamily: style.fontFamily } : {}),
      ...(style.fontSizePt !== text.fontSizePt || owners.some(fields => fields.has('fontSizePt')) ? { fontSizePt: style.fontSizePt } : {}),
      ...(style.color !== text.color || owners.some(fields => fields.has('color')) ? { color: style.color } : {}) };
    const previous = previousRun[0], ownerCount = Math.max(1, owners.length);
    if (previous && Object.entries(overrides).every(([key, value]) => previous[key as keyof LayoutTextSpan] === value) &&
      ['fontFamily', 'fontSizePt', 'color'].every(key => (key in previous) === (key in overrides)) &&
      previousRun.length === ownerCount && previousRun.every((span, i) => span.nativeUnknownFields === owners[i])) {
      for (const span of previousRun) span.end = index + 1;
    } else {
      // Overlapping source owners remain separate records with the same resolved visible style.
      previousRun = Array.from({ length: ownerCount }, (_, i) => ({ start: index, end: index + 1, ...overrides,
        ...(owners[i] ? { nativeUnknownFields: owners[i] } : {}) }));
      spans.push(...previousRun);
    }
  }
  return { spans };
}
