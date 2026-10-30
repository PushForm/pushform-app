// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, moveTo, lineTo, appendBezierCurve, closePath, clip, endPath, fill, stroke, fillAndStroke, setFillingColor, setStrokingColor, setLineWidth, setDashPattern, PDFOperator, PDFOperatorNames, setGraphicsState, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { LayoutVectorPage, VectorPath } from '@pushform/io';

const PT = 72 / 25.4;
const hex = (value: string) => value.length === 4 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value;
const color = (value: string) => { const h = hex(value); return rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255); };
const alpha = (value: string | null) => value?.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
const fillEvenOdd = () => PDFOperator.of(PDFOperatorNames.FillEvenOdd);
const fillAndStrokeEvenOdd = () => PDFOperator.of(PDFOperatorNames.FillEvenOddAndStroke);
const pathOperators = (path: VectorPath): PDFOperator[] => path.segments.map(s => s.kind === 'move' ? moveTo(...s.point) : s.kind === 'line' ? lineTo(...s.point) : s.kind === 'cubic' ? appendBezierCurve(...s.c1, ...s.c2, ...s.point) : closePath());
export type PdfFontLoader = (family: string, bold: boolean, italic: boolean, text: string) => Promise<Uint8Array | Uint8Array[] | null>;

/** Vector page writer, independent of the DOM. Font loading is supplied by the browser adapter. */
export async function writeLayoutPdf(pages: readonly LayoutVectorPage[], loadFont: PdfFontLoader): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (!pages.length) throw new Error('Choose at least one page to export.');
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const fonts = new Map<string, PDFFont[]>(), warnings = new Set<string>();
  const textItems = pages.flatMap(p => p.items.filter(i => i.kind === 'text'));
  const characterSets = new Map<PDFFont, Set<number>>();
  for (const item of textItems) {
    if (fonts.has(item.font)) continue;
    const family = item.font.match(/px\s+["']?([^"',]+)/)?.[1]?.trim() ?? 'sans-serif';
    const bold = /\bbold\b|\b700\b/.test(item.font), italic = /\bitalic\b/.test(item.font);
    const bytes = await loadFont(family, bold, italic, textItems.filter(i => i.font === item.font).map(i => i.text).join(''));
    if (bytes) fonts.set(item.font, await Promise.all((Array.isArray(bytes) ? bytes : [bytes]).filter(data => { const face = fontkit.create(data); return [...textItems.filter(i => i.font === item.font).map(i => i.text).join('')].some(char => face.hasGlyphForCodePoint(char.codePointAt(0)!)); }).map(data => pdf.embedFont(data, { subset: true }))));
    else {
      warnings.add(`The system font ${family} was replaced by a standard PDF font.`);
      const serif = /Times|Georgia|serif/.test(family) && !/sans/.test(family), mono = /Courier|mono/i.test(family);
      const standard = mono ? (bold ? italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier)
        : serif ? (bold ? italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman)
        : (bold ? italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica);
      fonts.set(item.font, [await pdf.embedFont(standard)]);
    }
  }
  for (const source of pages) {
    const page = pdf.addPage([source.width * PT, source.height * PT]);
    page.drawRectangle({ width: source.width * PT, height: source.height * PT, color: color(source.background) });
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(PT, 0, 0, -PT, 0, source.height * PT));
    for (const item of source.items) {
      if (item.kind === 'text' && !item.text) continue;
      page.pushOperators(pushGraphicsState());
      for (const c of item.clips) page.pushOperators(...pathOperators(c), clip(), endPath());
      if (item.kind === 'path') {
        const opacity = pdf.context.obj({ Type: 'ExtGState', ca: alpha(item.fill), CA: alpha(item.stroke) });
        page.pushOperators(setGraphicsState(page.node.newExtGState('GS', opacity)));
        page.pushOperators(...pathOperators(item.path), setLineWidth(item.weight), setDashPattern(item.dash, 0));
        if (item.fill) page.pushOperators(setFillingColor(color(item.fill)));
        if (item.stroke) page.pushOperators(setStrokingColor(color(item.stroke)));
        page.pushOperators(item.fill && item.stroke ? item.evenodd ? fillAndStrokeEvenOdd() : fillAndStroke() : item.fill ? item.evenodd ? fillEvenOdd() : fill() : item.stroke ? stroke() : endPath());
      } else if (item.kind === 'text') {
        const candidates = fonts.get(item.font)!, font = candidates[0]!, size = Number(item.font.match(/([\d.]+)px/)?.[1] ?? 10);
        const [left, top, right, bottom] = item.bounds;
        let y = item.point[1];
        if (!font) throw new Error(`The PDF font for ${item.font} does not contain the required characters.`);
        if (item.baseline !== 'alphabetic') y = top + font.heightAtSize(size, { descender: false });
        const x = item.align === 'center' ? item.point[0] - (right - left) / 2 : item.align === 'right' || item.align === 'end' ? item.point[0] - right + left : item.point[0];
        page.pushOperators(concatTransformationMatrix(...item.matrix), concatTransformationMatrix(1, 0, 0, -1, 0, 0));
        let cursor = x;
        const runs: { font: PDFFont; text: string }[] = [];
        for (const char of item.text) {
          const selected = candidates.find(candidate => {
            let characters = characterSets.get(candidate);
            if (!characters) { characters = new Set(candidate.getCharacterSet()); characterSets.set(candidate, characters); }
            return characters.has(char.codePointAt(0)!);
          });
          if (!selected) throw new Error(`The PDF font for ${item.font} does not contain ${char}. Choose a font that supports this text.`);
          const previous = runs.at(-1);
          if (previous?.font === selected) previous.text += char; else runs.push({ font: selected, text: char });
        }
        for (const run of runs) {
          page.drawText(run.text, { x: cursor, y: -y, size, font: run.font, color: color(item.color), opacity: alpha(item.color) });
          cursor += run.font.widthOfTextAtSize(run.text, size);
        }
        if (item.underline) page.drawLine({ start: { x: left, y: -bottom }, end: { x: right, y: -bottom }, thickness: size / 15, color: color(item.color), opacity: alpha(item.color) });
      } else {
        const response = await fetch(item.src);
        if (!response.ok) throw new Error('A page image could not be loaded.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const image = bytes[0] === 137 ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        page.pushOperators(concatTransformationMatrix(...item.matrix));
        page.pushOperators(concatTransformationMatrix(1, 0, 0, -1, item.x, item.y + item.height));
        page.drawImage(image, { x: 0, y: 0, width: item.width, height: item.height });
      }
      page.pushOperators(popGraphicsState());
    }
    page.pushOperators(popGraphicsState());
  }
  return { bytes: await pdf.save(), warnings: [...warnings] };
}
