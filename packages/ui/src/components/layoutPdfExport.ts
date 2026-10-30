// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { entitiesForLayer, isViewport, layoutFrameSize, type LayoutDocumentState } from '@pushform/layout';
import { GOOGLE_LAYOUT_FONTS } from './layoutFontCatalog';
import { prepareLayoutPages } from './layoutPrint';
import { prepareLayoutImages } from './layoutImage';
import { layoutViewportPicture, settleLayoutViewportRenders } from './layoutViewportRenders';
import { drawLayoutVectorPage } from './layoutVectorDrawing';
import { safeLayoutExportName } from './layoutImageExport';
import { encodeImage, rasterizeImage } from '../rasterizeImage';
import type { PdfFontLoader } from './layoutPdf';

/** PDF export choices beyond the pages and resolution. */
export interface LayoutPdfOptions {
  /** JPEG quality (0–1) for the PDF's images, model views and pictures alike; undefined keeps them lossless (PNG). */
  jpegQuality?: number | undefined;
}

/** Bytes as a data: URL of the given type. */
async function dataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
}

/** One-based ranges such as 1, 3-5, in document order without duplicates. */
export function pdfPageRange(order: readonly number[], range: string): number[] {
  const selected = new Set<number>();
  for (const part of range.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    const from = Number(match?.[1]), to = Number(match?.[2] ?? match?.[1]);
    if (!match || from < 1 || to < from || to > order.length) throw new Error('Enter page numbers or ranges within the document, such as 1, 3-5.');
    for (let index = from - 1; index < to; index++) selected.add(order[index]!);
  }
  return order.filter(id => selected.has(id));
}

export const loadPdfWebFont: PdfFontLoader = async (family, bold, italic) => {
  const face = GOOGLE_LAYOUT_FONTS.find(f => f.family === family);
  if (!face) return null;
  const desired = `${italic ? 1 : 0},${bold ? 700 : 400}`;
  const style = face.styles.some(style => style === desired) ? desired : face.styles[0]!;
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${style}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${family} for PDF export.`);
  const css = await response.text();
  const sources = [...new Set([...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map(match => match[1]!.replace(/["']/g, '')))];
  if (!sources.length) throw new Error(`No embeddable font was returned for ${family}.`);
  return Promise.all(sources.map(async src => {
    const font = await fetch(src);
    if (!font.ok) throw new Error(`Could not load ${family} for PDF export.`);
    return new Uint8Array(await font.arrayBuffer());
  }));
};

export async function exportLayoutPdf(state: LayoutDocumentState, ids: readonly number[], documentName: string, dpi: number, signal?: AbortSignal, options: LayoutPdfOptions = {}) {
  if (!ids.length || ids.some(id => !state.pages.has(id))) throw new Error('Choose available pages to export.');
  if (dpi !== 150 && dpi !== 300) throw new Error('Choose 150 or 300 dpi.');
  const { jpegQuality } = options;
  if (jpegQuality !== undefined && !(jpegQuality > 0 && jpegQuality <= 1)) throw new Error('Choose a JPEG quality between 0 and 1.');
  await prepareLayoutPages(state, ids);
  const entities = ids.flatMap(id => state.layerOrder.flatMap(layer => entitiesForLayer(state.pages.get(id)!, state, layer)));
  for (const entity of entities) if (isViewport(entity)) {
    const { width, height } = layoutFrameSize(entity.points);
    const w = Math.ceil(width * dpi / 25.4), h = Math.ceil(height * dpi / 25.4);
    if (w > 16384 || h > 16384 || w * h > 100_000_000) throw new Error('A model view is too large at this resolution. Choose a lower resolution.');
  }
  await settleLayoutViewportRenders(state, entities, 60_000, dpi);
  await prepareLayoutImages(entities, entity => layoutViewportPicture(state, entity, undefined, dpi / 25.4, true));
  if (signal?.aborted) return null;
  const pages = ids.map(id => drawLayoutVectorPage(state, state.pages.get(id)!, { exportDpi: dpi }));
  // PDF directly accepts PNG/JPEG; normalize other image formats without rasterizing any page geometry.
  for (const page of pages) for (const item of page.items) if (item.kind === 'image' && !/^data:image\/(png|jpe?g)[;,]/i.test(item.src)) {
    item.src = await dataUrl(await rasterizeImage(item.src, Math.max(1, Math.ceil(item.width * dpi / 25.4)), Math.max(1, Math.ceil(item.height * dpi / 25.4))), 'image/png');
  }
  // JPEG compression: every image at its own pixel size, transparent areas over white, as JPEG has no alpha.
  if (jpegQuality !== undefined) for (const page of pages) for (const item of page.items) if (item.kind === 'image') {
    if (signal?.aborted) return null;
    item.src = await dataUrl(await encodeImage(item.src, { mime: 'image/jpeg', quality: jpegQuality, fill: '#ffffff' }), 'image/jpeg');
  }
  const { writeLayoutPdf } = await import('./layoutPdf');
  const result = await writeLayoutPdf(pages, loadPdfWebFont);
  return signal?.aborted ? null : { ...result, name: `${safeLayoutExportName(documentName.replace(/\.(pfl|layout)$/i, ''))}.pdf`, mime: 'application/pdf', extension: 'pdf' };
}
