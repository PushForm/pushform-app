// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { zipSync, type Zippable } from 'fflate';
import type { LayoutDocumentState } from '@pushform/layout';
import { prepareLayoutPages, type LayoutPagePainter } from './layoutPrint';

export type LayoutImageFormat = 'png' | 'jpeg';
export const LAYOUT_IMAGE_RESOLUTIONS = [72, 150, 300] as const;
/** Largest picture exported per page: browsers refuse or fail canvases much bigger than this. */
export const MAX_LAYOUT_IMAGE_SIDE = 16384, MAX_LAYOUT_IMAGE_PIXELS = 100_000_000;
const JPEG_QUALITY = 0.92;

export interface LayoutImageExportOptions { format: LayoutImageFormat; dpi: number }
export interface LayoutImageExportFile { bytes: Uint8Array; name: string; mime: string; extension: string; warnings?: string[] }

/** Pixel size of a page exported at `dpi`. */
export function layoutImageSize(size: readonly [number, number], dpi: number): [number, number] {
  return [Math.round(size[0] / 25.4 * dpi), Math.round(size[1] / 25.4 * dpi)];
}

/** A name that every file system accepts. */
export const safeLayoutExportName = (name: string): string => [...name].map(c => c < ' ' || '\\/:*?"<>|'.includes(c) ? '-' : c).join('').trim() || 'Untitled';

/**
 * The file an image export writes: one page is one picture named after the document, or after the document
 * and page when it has several; more pages are one zip of numbered page pictures named after the document.
 */
export function layoutImageExportName(documentName: string, state: LayoutDocumentState, pageIds: readonly number[], format: LayoutImageFormat | 'svg' | 'dxf'): string {
  const base = safeLayoutExportName(documentName.replace(/\.(pfl|layout)$/i, '')), extension = format === 'jpeg' ? 'jpg' : format;
  if (pageIds.length !== 1) return `${base}.zip`;
  return state.pageOrder.length === 1 ? `${base}.${extension}` : `${base} - ${safeLayoutExportName(state.pages.get(pageIds[0]!)!.name)}.${extension}`;
}

/** Paint the pages as pictures once their fonts, images and model views are ready, and pack them as one file. */
export async function exportLayoutImages(state: LayoutDocumentState, pageIds: readonly number[], documentName: string,
  options: LayoutImageExportOptions, paint: LayoutPagePainter, signal?: AbortSignal): Promise<LayoutImageExportFile | null> {
  if (!pageIds.length) throw new Error('Choose at least one page to export.');
  for (const id of pageIds) {
    const page = state.pages.get(id);
    if (!page) throw new Error('A selected page is no longer available.');
    const [width, height] = layoutImageSize(page.size, options.dpi);
    if (width > MAX_LAYOUT_IMAGE_SIDE || height > MAX_LAYOUT_IMAGE_SIDE || width * height > MAX_LAYOUT_IMAGE_PIXELS)
      throw new Error(`${page.name} would be ${width} × ${height} pixels at ${options.dpi} dpi, too large to export. Choose a lower resolution.`);
  }
  await prepareLayoutPages(state, pageIds);
  if (signal?.aborted) return null;
  const mime = options.format === 'png' ? 'image/png' : 'image/jpeg', extension = options.format === 'png' ? 'png' : 'jpg';
  const pictures: Uint8Array[] = [];
  for (const id of pageIds) {
    const canvas = document.createElement('canvas');
    paint(canvas, state.pages.get(id)!, state, options.dpi);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, JPEG_QUALITY));
    if (!blob) throw new Error(`${state.pages.get(id)!.name} could not be turned into a picture. Choose a lower resolution.`);
    pictures.push(new Uint8Array(await blob.arrayBuffer()));
    if (signal?.aborted) return null;
  }
  const name = layoutImageExportName(documentName, state, pageIds, options.format);
  if (pictures.length === 1) return { bytes: pictures[0]!, name, mime, extension };
  const digits = String(pageIds.length).length, entries: Zippable = {};
  // Numbered so the pages keep their order and pages with the same name stay apart; pictures are already compressed.
  pageIds.forEach((id, index) => {
    entries[`${String(index + 1).padStart(digits, '0')} ${safeLayoutExportName(state.pages.get(id)!.name)}.${extension}`] = [pictures[index]!, { level: 0 }];
  });
  return { bytes: zipSync(entries), name, mime: 'application/zip', extension: 'zip' };
}
