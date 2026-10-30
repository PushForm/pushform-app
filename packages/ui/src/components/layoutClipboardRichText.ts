// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { importLayoutText, LAYOUT_DEFAULT_TEXT, layoutTextStyleAt, type LayoutText, type LayoutTextSpan, type LayoutTextStyle } from '@pushform/layout';
import { clipboardColor, clipboardStyleReader } from './clipboardHtml';

export type ClipboardRichText = Pick<LayoutText, 'content'> & Partial<Pick<LayoutText, 'spans' | 'align' | 'list' | 'lineSpacing' | 'tabStopsPt'>>;
export const defaultClipboardTextStyle: LayoutTextStyle = { ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false, underline: false };

function pointSize(value: string, parent: number): number | undefined {
  const match = /^([\d.]+)(pt|px|in|cm|mm|em|rem|%)?$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const scale = ({ pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, em: parent, rem: 12, '%': parent / 100 } as Record<string, number>)[match[2] ?? 'px']!;
  return Number.isFinite(n) && n > 0 ? n * scale : undefined;
}

/** Flatten supported HTML formatting into native UTF-16 text runs, without executing markup. */
export function readHtmlRichText(root: Node, base = defaultClipboardTextStyle): ClipboardRichText {
  const doc = root.ownerDocument ?? root as Document, styleOf = clipboardStyleReader(doc);
  let content = '';
  const spans: LayoutTextSpan[] = [];
  let align: LayoutText['align'] | undefined, lineSpacing: LayoutText['lineSpacing'] | undefined;
  const append = (value: string, style: LayoutTextStyle) => {
    if (!value) return;
    const start = content.length; content += value;
    const previous = spans.at(-1), next = { ...style, start, end: content.length };
    if (previous && previous.end === start && Object.keys(style).every(key => previous[key as keyof LayoutTextStyle] === style[key as keyof LayoutTextStyle])) previous.end = content.length;
    else spans.push(next);
  };
  const newline = (style: LayoutTextStyle) => { if (content && !content.endsWith('\n')) append('\n', style); };
  const styled = (node: Element, inherited: LayoutTextStyle): LayoutTextStyle => {
    const tag = node.localName.toLowerCase(), css = styleOf(node), style = { ...inherited };
    if (['b', 'strong', 'th'].includes(tag)) style.bold = true;
    if (['i', 'em'].includes(tag)) style.italic = true;
    if (tag === 'u') style.underline = true;
    if (css.fontWeight) style.bold = css.fontWeight === 'bold' || css.fontWeight === 'bolder' || Number(css.fontWeight) >= 600;
    if (css.fontStyle) style.italic = css.fontStyle === 'italic' || css.fontStyle === 'oblique';
    const decoration = css.textDecorationLine || css.textDecoration;
    if (decoration) style.underline = decoration.includes('underline');
    const family = css.fontFamily || node.getAttribute('face');
    if (family) style.fontFamily = family.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
    const size = pointSize(css.fontSize, inherited.fontSizePt);
    if (size) style.fontSizePt = size;
    if (/^h[1-6]$/.test(tag) && !size) { style.bold = true; style.fontSizePt = [24, 20, 16, 14, 12, 10][Number(tag[1]) - 1]!; }
    const color = clipboardColor(css.color || node.getAttribute('color') || '', doc);
    if (color) style.color = color;
    return style;
  };
  const paragraph = (node: Element, style: LayoutTextStyle) => {
    const css = styleOf(node), alignment = css.textAlign || node.getAttribute('align') || '';
    if (!content && ['left', 'center', 'right'].includes(alignment)) align = alignment as LayoutText['align'];
    if (!content && css.lineHeight && css.lineHeight !== 'normal') {
      const multiple = Number(css.lineHeight), height = pointSize(css.lineHeight, style.fontSizePt);
      if (multiple > 0) lineSpacing = { mode: 'multiple', value: multiple };
      else if (height) lineSpacing = { mode: 'exactly', value: height };
    }
  };
  const visit = (node: Node, inherited: LayoutTextStyle, preserve: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let value = (node.textContent ?? '').replace(/\r\n?/g, '\n');
      if (!preserve) {
        value = value.replace(/[\t\n\r ]+/g, ' ');
        if (!content || /[\n ]$/.test(content)) value = value.replace(/^ /, '');
      }
      append(value, inherited); return;
    }
    if (!(node instanceof Element)) { node.childNodes.forEach(child => visit(child, inherited, preserve)); return; }
    const tag = node.localName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'img', 'svg', 'iframe', 'object', 'template'].includes(tag)) return;
    const css = styleOf(node);
    if (css.display === 'none' || css.visibility === 'hidden') return;
    const style = styled(node, inherited);
    paragraph(node, style);
    const block = /^(p|div|h[1-6]|li|pre|blockquote|tr)$/.test(tag);
    if (block) newline(style);
    if (tag === 'br') { append('\n', style); return; }
    if (tag === 'li') {
      const list = node.parentElement;
      const number = list?.localName === 'ol' ? Number(list.getAttribute('start') ?? 1) + Array.from(list.children).indexOf(node) : null;
      append(number === null ? '• ' : `${number}. `, style);
    }
    node.childNodes.forEach(child => visit(child, style, preserve || tag === 'pre' || /pre/.test(css.whiteSpace)));
    if (block) newline(style);
  };
  const ancestors: Element[] = [];
  for (let node = root.parentElement; node; node = node.parentElement) ancestors.unshift(node);
  let inherited = base, preserve = false;
  for (const node of ancestors) {
    const css = styleOf(node);
    if (css.display === 'none' || css.visibility === 'hidden') return { content: '', spans: [] };
    inherited = styled(node, inherited); paragraph(node, inherited);
    preserve ||= node.localName === 'pre' || /pre/.test(css.whiteSpace);
  }
  visit(root, inherited, preserve);
  content = content.replace(/[ \n]+$/, '');
  return { content, spans: spans.map(span => ({ ...span, end: Math.min(span.end, content.length) })).filter(span => span.end > span.start),
    ...(align ? { align } : {}), ...(lineSpacing ? { lineSpacing } : {}) };
}

export function readClipboardRichText(data: DataTransfer, plain = false, base = defaultClipboardTextStyle): ClipboardRichText | null {
  if (!plain) {
    const html = data.getData('text/html');
    if (html) {
      const value = readHtmlRichText(new DOMParser().parseFromString(html, 'text/html').body, base);
      if (value.content) return value;
    }
    const rtf = data.getData('text/rtf') || data.getData('application/rtf') || data.getData('text/richtext');
    if (rtf) return importLayoutText(rtf);
  }
  const text = data.getData('text/plain');
  if (text) return { content: text.replace(/\r\n?/g, '\n') };
  if (plain) {
    const rich = readClipboardRichText(data, false, base);
    if (rich) return { content: rich.content };
  }
  return null;
}

/** Replace the selected range and split/shift existing runs so surrounding formatting survives. */
export function insertClipboardRichText(text: LayoutText, start: number, end: number, insert: ClipboardRichText): ClipboardRichText {
  const delta = insert.content.length - (end - start), spans: LayoutTextSpan[] = [];
  for (const span of text.spans ?? []) {
    if (span.start < start) spans.push({ ...span, end: Math.min(span.end, start) });
    if (span.end > end) spans.push({ ...span, start: Math.max(span.start, end) + delta, end: span.end + delta });
  }
  const inserted = insert.spans ?? [{ ...layoutTextStyleAt(text, start), start: 0, end: insert.content.length }];
  spans.push(...inserted.map(span => ({ ...span, start: span.start + start, end: span.end + start })));
  return { content: text.content.slice(0, start) + insert.content + text.content.slice(end), spans: spans.filter(span => span.end > span.start),
    ...(start === 0 && end === text.content.length ? { ...(insert.align ? { align: insert.align } : {}), ...(insert.lineSpacing ? { lineSpacing: insert.lineSpacing } : {}), ...(insert.tabStopsPt ? { tabStopsPt: insert.tabStopsPt } : {}) } : {}) };
}
