// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Pictures stored as PDF documents. The picture keeps the PDF itself (so saving and export write it unchanged) and
 * shows its first page, drawn into a canvas by PDF.js. PDF.js and its worker load only when a PDF picture is first
 * shown, so documents without one do not download them.
 */

import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfJs = typeof PdfJsModule;

const PDF_PICTURE = /^data:application\/pdf[;,]/i;
/** Resolution of a PDF picture's raster, in pixels per inch of its page, and its longest side in pixels. */
export const PDF_PICTURE_DPI = 200;
export const PDF_PICTURE_MAX_PX = 4096;
/** Browsers refuse canvases much above this many pixels (Safari: 16,777,216). */
const MAX_CANVAS_PIXELS = 16_000_000;
const UNREADABLE = 'A PDF picture could not be read.';

const loads = new Map<string, Promise<HTMLCanvasElement>>();
const pictures = new Map<string, HTMLCanvasElement>();
const failures = new Set<string>();
let pdfjs: Promise<PdfJs> | undefined;

export function isPdfPicture(src: string): boolean {
  return PDF_PICTURE.test(src);
}

/** The first page of a PDF picture, drawn once and reused; the promise rejects when the PDF cannot be drawn. */
export function loadPdfPicture(src: string): Promise<HTMLCanvasElement> {
  let load = loads.get(src);
  if (!load) {
    load = rasterizePdf(src).then(
      (canvas) => { pictures.set(src, canvas); return canvas; },
      (error: unknown) => { failures.add(src); throw error instanceof Error ? error : new Error(UNREADABLE); },
    );
    loads.set(src, load);
  }
  return load;
}

/** The drawn picture, or null while it is drawn (started on first request; `done` runs once it finishes or fails). */
export function pdfPicture(src: string, done: () => void): HTMLCanvasElement | null {
  const picture = pictures.get(src);
  if (picture) return picture;
  if (!loads.has(src)) loadPdfPicture(src).then(done, done);
  return null;
}

export function pdfPictureState(src: string): 'loaded' | 'failed' | 'pending' {
  return pictures.has(src) ? 'loaded' : failures.has(src) ? 'failed' : 'pending';
}

/** Pixels per PDF point for a page of this size (in points): the picture resolution, kept within the size limits. */
export function pdfPictureScale(widthPt: number, heightPt: number): number {
  const scale = PDF_PICTURE_DPI / 72;
  const longest = Math.max(widthPt, heightPt, 1e-6);
  return Math.min(scale, PDF_PICTURE_MAX_PX / longest, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(widthPt * heightPt, 1e-6)));
}

function loadPdfJs(): Promise<PdfJs> {
  // The legacy build carries polyfills for recent JavaScript built-ins the plain build expects (Map upserts,
  // Math.sumPrecise), which older system webviews lack.
  pdfjs ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([module, worker]) => {
    module.GlobalWorkerOptions.workerSrc = worker.default;
    return module;
  });
  return pdfjs;
}

/**
 * Supplies the decoders PDF.js fetches by file name (JBIG2 for scans, OpenJPEG for JPEG 2000) from the app's own
 * bundled files. Other resources (CMaps, standard font files) are not bundled: PDF.js falls back to system fonts.
 */
const DECODERS: Record<string, () => Promise<{ default: string }>> = {
  'jbig2.wasm': () => import('pdfjs-dist/wasm/jbig2.wasm?url'),
  'openjpeg.wasm': () => import('pdfjs-dist/wasm/openjpeg.wasm?url'),
};
class BundledPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const asset = kind === 'wasmUrl' ? DECODERS[filename] : undefined;
    if (!asset) throw new Error(`${filename} is not bundled`);
    const response = await fetch((await asset()).default);
    if (!response.ok) throw new Error(`${filename} could not be loaded`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function pdfBytes(src: string): Uint8Array {
  const comma = src.indexOf(',');
  const header = src.slice(0, comma);
  const payload = src.slice(comma + 1);
  if (header.endsWith(';base64')) return Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  return new TextEncoder().encode(decodeURIComponent(payload));
}

async function rasterizePdf(src: string): Promise<HTMLCanvasElement> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({
    data: pdfBytes(src), enableXfa: false, useWorkerFetch: false, BinaryDataFactory: BundledPdfData,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pdfPictureScale(size.width, size.height) });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    // The page has no paper of its own: what it leaves unpainted shows what lies under the picture. Given a canvas,
    // PDF.js draws into an opaque context, where unpainted means black, so it gets a context with transparency.
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) throw new Error(UNREADABLE);
    await page.render({ canvas: null, canvasContext, viewport, background: 'rgba(0,0,0,0)' }).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}
