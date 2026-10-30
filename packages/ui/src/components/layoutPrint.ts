// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { entitiesForLayer, isViewport, type LayoutDocumentState, type LayoutPage } from '@pushform/layout';
import { prepareLayoutFonts } from './layoutFonts';
import { prepareLayoutImages } from './layoutImage';
import { layoutViewportPicture, settleLayoutViewportRenders } from './layoutViewportRenders';

export type LayoutPagePainter = (canvas: HTMLCanvasElement, page: LayoutPage, state: LayoutDocumentState, dpi: number) => void;
let previousFrame: HTMLIFrameElement | null = null;

/** Build isolated, physically sized sheets. No editor DOM or application styles enter this document. */
export function buildLayoutPrintDocument(doc: Document, state: LayoutDocumentState, pageIds: number[],
  title: string, paint: LayoutPagePainter, dpi: number): void {
  doc.title = title;
  const style = doc.createElement('style');
  style.textContent = `
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .sheet { margin: 0; padding: 0; overflow: hidden; break-inside: avoid; }
    .sheet + .sheet { break-before: page; }
    canvas { display: block; }
  `;
  doc.head.append(style);
  for (const [index, id] of pageIds.entries()) {
    const page = state.pages.get(id);
    if (!page) throw new Error('A selected page is no longer available.');
    const [width, height] = page.size;
    const name = `layoutSheet${index}`;
    style.textContent += `\n@page ${name} { size: ${width}mm ${height}mm; margin: 0; }`;
    const sheet = doc.createElement('section');
    sheet.className = 'sheet';
    sheet.style.cssText = `page: ${name}; width: ${width}mm; height: ${height}mm;`;
    sheet.setAttribute('aria-label', page.name);
    // Rasterize in the editor document, whose FontFaceSet contains the loaded webfonts.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width: ${width}mm; height: ${height}mm;`;
    paint(canvas, page, state, dpi);
    sheet.append(canvas);
    doc.body.append(sheet);
  }
}

/** Wait until the pages' model views are rendered and their pictures and fonts are loaded, for print or export. */
export async function prepareLayoutPages(state: LayoutDocumentState, pageIds: readonly number[]): Promise<void> {
  const entities = [...new Map(pageIds.flatMap(id => state.layerOrder.flatMap(layerId =>
    entitiesForLayer(state.pages.get(id)!, state, layerId))).map(entity => [entity.id, entity])).values()];
  if (entities.some(isViewport)) await settleLayoutViewportRenders(state, entities);
  await Promise.all([prepareLayoutFonts(entities), document.fonts?.ready, prepareLayoutImages(entities, entity => layoutViewportPicture(state, entity))]);
}

/** Prepare pictures/fonts before opening the browser's printer/PDF dialog. */
export async function printLayoutDocument(state: LayoutDocumentState, pageIds: number[], title: string,
  paint: LayoutPagePainter, dpi: number, signal: AbortSignal): Promise<void> {
  if (!pageIds.length) throw new Error('Choose at least one page to print.');
  await prepareLayoutPages(state, pageIds);
  if (signal.aborted) return;
  previousFrame?.remove();
  const frame = document.createElement('iframe');
  frame.title = 'Layout print document';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
  document.body.append(frame);
  previousFrame = frame;
  try {
    const target = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!target || !doc) throw new Error('The print document could not be opened.');
    doc.open(); doc.write('<!doctype html><html><head></head><body></body></html>'); doc.close();
    buildLayoutPrintDocument(doc, state, pageIds, title, paint, dpi);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (signal.aborted) { frame.remove(); return; }
    target.addEventListener('afterprint', () => {
      frame.remove();
      if (previousFrame === frame) previousFrame = null;
    }, { once: true });
    target.focus();
    target.print();
    // Some browsers return before preview closes. Keep its document alive until afterprint.
  } catch (error) {
    frame.remove();
    if (previousFrame === frame) previousFrame = null;
    throw error;
  }
}
