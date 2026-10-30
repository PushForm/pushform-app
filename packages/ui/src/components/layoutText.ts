// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { layoutModelFields, LAYOUT_DEFAULT_TAB_PT, LAYOUT_TEXT_INSET_MM, layoutTextStyleAt, nextLayoutTabStop, spaceLayoutLine, type LayoutTextStyle, layoutLabelLeader, type LayoutLabelLeader, type LayoutText, resolveLayoutText, type LayoutEntity, type LayoutPage, type LayoutDocumentState } from '@pushform/layout';

/** Positioned glyphs after wrapping and formatting, also used to retain editable SVG text blocks. */
export interface LayoutPaintedGlyph { text: string; x: number; y: number; font: string; color: string; underline: boolean }
export type LayoutTextBlockPainter = (glyphs: LayoutPaintedGlyph[]) => void;

/**
 * Sets text: lines stay 0.03 in inside the box's left and right sides, each line
 * is as tall as its font's ascent plus descent, and the first baseline sits one ascent below the top.
 */
export function paintLayoutText(ctx: CanvasRenderingContext2D, entity: LayoutEntity,
  page: LayoutPage, state: LayoutDocumentState, selected: boolean, paintBlock?: LayoutTextBlockPainter): void {
  const text = entity.text;
  if (!text) return;
  const a = entity.points[0]!, b = entity.points[1]!;
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  const width = Math.max(0.001, Math.abs(b[0] - a[0])), height = Math.max(0.001, Math.abs(b[1] - a[1]));
  const inset = layoutTextInset(width);
  ctx.save();
  if (text.rotationDeg) {
    ctx.translate(x + width / 2, y + height / 2);
    ctx.rotate(text.rotationDeg * Math.PI / 180);
    ctx.translate(-x - width / 2, -y - height / 2);
  }
  ctx.strokeStyle = entity.modelAnnotation?.status === 'detached' ? '#c43b32' : selected ? '#1e63d1' : entity.style?.strokeColor ?? '#222222';
  ctx.lineWidth = (entity.style?.strokeWeightPt ?? 0.5) * 25.4 / 72;
  const leader = layoutLabelLeader(entity);
  if (leader) paintLayoutLabelLeader(ctx, leader, text.endpoint);
  if (selected) { ctx.setLineDash([1, 1]); ctx.strokeRect(x, y, width, height); ctx.setLineDash([]); }
  const { lineHeights, lineAscents, lines, font } = layoutTextBlock(ctx, text, width - 2 * inset, page, state, layoutModelFields(entity));
  ctx.fillStyle = text.color;
  ctx.textBaseline = 'alphabetic';
  if (text.bounded) { ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip(); }
  const blockHeight = lineHeights.reduce((sum, value) => sum + value, 0);
  const offset = text.vertical === 'middle' ? (height - blockHeight) / 2
    : text.vertical === 'bottom' ? height - blockHeight : 0;
  let top = y + Math.max(0, offset);
  const glyphs: LayoutPaintedGlyph[] = [];
  lines.forEach((line, index) => {
    const measured = line.reduce((sum, item) => sum + item.width, 0), room = width - 2 * inset;
    let left = x + inset + (text.align === 'center' ? (room - measured) / 2 : text.align === 'right' ? room - measured : 0);
    for (const glyph of line) {
      const size = glyph.fontSizePt * 25.4 / 72;
      const baseline = top + lineAscents[index]!;
      if (paintBlock) glyphs.push({ text: glyph.char, x: left, y: baseline, font: font(glyph), color: glyph.color, underline: glyph.underline });
      else { ctx.font = font(glyph); ctx.fillStyle = glyph.color; ctx.fillText(glyph.char, left, baseline); }
      if (!paintBlock && glyph.underline) {
        const underline = baseline + size * 0.1;
        ctx.strokeStyle = glyph.color;
        ctx.beginPath(); ctx.moveTo(left, underline); ctx.lineTo(left + glyph.width, underline); ctx.stroke();
      }
      left += glyph.width;
    }
    top += lineHeights[index]!;
  });
  paintBlock?.(glyphs);
  ctx.restore();
}

/** The side inset, which never takes more than half a narrow box. */
export function layoutTextInset(width: number): number {
  return Math.min(LAYOUT_TEXT_INSET_MM, width / 4);
}

/** Shared wrapping and line heights keep page text and its editor vertically aligned. */
export function layoutTextBlock(ctx: CanvasRenderingContext2D, text: LayoutText, width: number,
  page: LayoutPage, state: LayoutDocumentState, modelFields?: Readonly<Record<string, string>>) {
  const size = text.fontSizePt * 25.4 / 72;
  type Glyph = LayoutTextStyle & { char: string; width: number; ascent: number; descent: number };
  const font = (style: LayoutTextStyle): string =>
    // An unavailable family falls back to sans-serif, not to the browser's default serif.
    `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSizePt * 25.4 / 72}px "${style.fontFamily.replace(/["\\]/g, '')}", sans-serif`;
  const lines: Glyph[][] = [[]];
  // Each paragraph's mark (the style of its line break) sets the height of a line with no characters.
  const marks: LayoutTextStyle[] = [];
  let paragraph = 0;
  // Arial's ascent and descent stand in where the canvas cannot report the font's own.
  const vertical = (metrics: TextMetrics, fontSizePt: number) => ({
    ascent: metrics.fontBoundingBoxAscent ?? fontSizePt * 25.4 / 72 * 0.905,
    descent: metrics.fontBoundingBoxDescent ?? fontSizePt * 25.4 / 72 * 0.212,
  });
  const append = (char: string, sourceIndex: number): void => {
    const style = layoutTextStyleAt(text, sourceIndex);
    ctx.font = font(style);
    const metrics = ctx.measureText(char);
    const glyph: Glyph = { ...style, char, width: metrics.width, ...vertical(metrics, style.fontSizePt) };
    lines.at(-1)!.push(glyph);
  };
  const prefix = (): void => {
    if (text.list === 'bullet') for (const char of '• ') append(char, -1);
    if (text.list === 'number') for (const char of `${paragraph + 1}. `) append(char, -1);
  };
  prefix();
  const segments = text.content.matchAll(/<[^<>\r\n]+>|[^]/g);
  for (const segment of segments) {
    for (const char of resolveLayoutText(segment[0], page, state, modelFields)) {
      if (char === '\n') { marks.push(layoutTextStyleAt(text, segment.index)); lines.push([]); paragraph++; prefix(); }
      else append(char, segment.index);
    }
  }
  marks.push(layoutTextStyleAt(text, Math.max(0, text.content.length - 1)));
  // A tab runs from where it starts on its line to the next tab stop, measured from the box's left side
  // (the inset lies inside it; a box narrower than 0.12 in has half its text width as inset).
  const inset = Math.min(LAYOUT_TEXT_INSET_MM, width / 2);
  const advance = (glyph: Glyph, used: number): number => {
    if (glyph.char === '\t') glyph.width = nextLayoutTabStop(inset + used, text.tabStopsPt) - inset - used;
    return used + glyph.width;
  };
  const lineMarks: LayoutTextStyle[] = [];
  const wrapped = text.bounded ? lines.flatMap((paragraph, index) => {
    const result: Glyph[][] = [[]];
    const tokens: Glyph[][] = [];
    for (const glyph of paragraph) {
      if (!tokens.length || /\s/.test(tokens.at(-1)![0]!.char) !== /\s/.test(glyph.char)) tokens.push([]);
      tokens.at(-1)!.push(glyph);
    }
    let used = 0;
    for (const token of tokens) {
      const whitespace = /\s/.test(token[0]!.char);
      if (whitespace) { for (const glyph of token) used = advance(glyph, used); result.at(-1)!.push(...token); continue; }
      const tokenWidth = token.reduce((sum, glyph) => sum + glyph.width, 0);
      if (used + tokenWidth > width && result.at(-1)!.some(glyph => !/\s/.test(glyph.char))) {
        result.push([]); used = 0;
      }
      result.at(-1)!.push(...token); used += tokenWidth;
    }
    lineMarks.push(...result.map(() => marks[index]!));
    return result;
  }) : lines.map(line => { line.reduce((used, glyph) => advance(glyph, used), 0); return line; });
  if (!text.bounded) lineMarks.push(...marks);
  const measure = (style: LayoutTextStyle) => { ctx.font = font(style); return vertical(ctx.measureText(''), style.fontSizePt); };
  const base = measure(text);
  // A line is as tall as the largest font on it;: line spacing scales or replaces that height.
  const spaced = wrapped.map((line, index) => {
    const empty = line.length ? null : measure(lineMarks[index] ?? text);
    return spaceLayoutLine(empty?.ascent ?? Math.max(...line.map(glyph => glyph.ascent)),
      empty?.descent ?? Math.max(...line.map(glyph => glyph.descent)), text.lineSpacing);
  });
  const lineAscents = spaced.map(line => line.ascent);
  const lineHeights = spaced.map(line => line.height);
  return { size, lineHeight: base.ascent + base.descent, lineHeights, lineAscents, lines: wrapped, font };
}

let measuring: CanvasRenderingContext2D | null | undefined;
/** A font's ascent plus descent over its size: the painted line height, for DOM editors. */
export function layoutFontLineHeight(style: Pick<LayoutText, 'fontFamily' | 'bold' | 'italic'>): number {
  if (measuring === undefined) {
    try { measuring = document.createElement('canvas').getContext('2d'); } catch { measuring = null; }
  }
  if (!measuring) return 0.905 + 0.212;
  measuring.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}100px "${style.fontFamily.replace(/["\\]/g, '')}", sans-serif`;
  const metrics = measuring.measureText('');
  return ((metrics.fontBoundingBoxAscent ?? 90.5) + (metrics.fontBoundingBoxDescent ?? 21.2)) / 100;
}

/** The on-page editors' CSS line height, relative to the box's font size, with its line spacing. */
export function layoutEditorLineHeight(text: Pick<LayoutText, 'fontFamily' | 'bold' | 'italic' | 'fontSizePt' | 'lineSpacing'>): number {
  const natural = layoutFontLineHeight(text), spacing = text.lineSpacing;
  if (!spacing) return natural;
  if (spacing.mode === 'multiple') return natural * spacing.value;
  const points = spacing.value / text.fontSizePt;
  return spacing.mode === 'exactly' ? points : Math.max(natural, points);
}

/**
 * The on-page editors' tab spacing in mm. Browsers space tabs evenly, so evenly spaced stops (LayOut's
 * default, and the stops most documents set) keep their spacing while editing; uneven stops show at the default.
 */
export function layoutEditorTabSizeMm(text: Pick<LayoutText, 'tabStopsPt'>): number {
  const stops = text.tabStopsPt ?? [], first = stops[0];
  const even = first !== undefined && stops.every((stop, index) => Math.abs(stop - first * (index + 1)) < 0.05);
  return (even ? first : LAYOUT_DEFAULT_TAB_PT) * 25.4 / 72;
}

export function paintLayoutLabelLeader(ctx: CanvasRenderingContext2D, { tip, bend, start }: LayoutLabelLeader,
  endpoint: LayoutText['endpoint']): void {
  ctx.beginPath(); ctx.moveTo(...start); ctx.lineTo(...bend); ctx.lineTo(...tip); ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  if (endpoint === 'dot') { ctx.beginPath(); ctx.arc(...tip, 0.8, 0, Math.PI * 2); ctx.fill(); }
  if (endpoint === 'arrow') {
    const angle = Math.atan2(tip[1] - bend[1], tip[0] - bend[0]);
    ctx.beginPath(); ctx.moveTo(...tip);
    ctx.lineTo(tip[0] - 3 * Math.cos(angle - 0.4), tip[1] - 3 * Math.sin(angle - 0.4));
    ctx.lineTo(tip[0] - 3 * Math.cos(angle + 0.4), tip[1] - 3 * Math.sin(angle + 0.4));
    ctx.closePath(); ctx.fill();
  }
}

/** Tight paper-space line bounds for click-placed text, using the same metrics as painting. */
export function fittedLayoutTextBounds(ctx: CanvasRenderingContext2D, entity: LayoutEntity,
  page: LayoutPage, state: LayoutDocumentState): [[number, number], [number, number]] {
  const text = entity.text!;
  const block = layoutTextBlock(ctx, { ...text, bounded: false }, Infinity, page, state, layoutModelFields(entity));
  const width = Math.max(0.1, ...block.lines.map(line => line.reduce((sum, glyph) => sum + glyph.width, 0))) + 2 * LAYOUT_TEXT_INSET_MM;
  const height = block.lineHeights.reduce((sum, value) => sum + value, 0);
  const a = entity.points[0]!, b = entity.points[1]!;
  const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
  if (entity.kind === 'label') {
    const leader = layoutLabelLeader(entity);
    const attachRight = leader ? leader.start[0] > (a[0] + b[0]) / 2 : text.align === 'right';
    const x = attachRight ? Math.max(a[0], b[0]) - width : left;
    const y = (a[1] + b[1]) / 2 - height / 2;
    return [[x, y], [x + width, y + height]];
  }
  return [[left, top], [left + width, top + height]];
}
