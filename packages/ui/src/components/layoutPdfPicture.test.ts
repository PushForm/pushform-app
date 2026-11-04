// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, expect, it, vi } from 'vitest';
import type { LayoutEntity } from '@pushform/layout';

/** A stand-in for PDF.js: records how documents are opened and drawn; a document whose bytes start "bad" fails. */
const pdfjs = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  rendered: [] as { page: number; width: number; height: number; background: unknown }[],
  destroyed: 0,
  pageSize: [612, 792] as [number, number],
  workerSrc: '',
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { set workerSrc(value: string) { pdfjs.workerSrc = value; } },
  getDocument: (options: Record<string, unknown>) => {
    pdfjs.options.push(options);
    const data = options.data as Uint8Array;
    const bad = String.fromCharCode(...data.subarray(0, 3)) === 'bad';
    const viewport = (scale: number) => ({ width: pdfjs.pageSize[0] * scale, height: pdfjs.pageSize[1] * scale });
    return {
      promise: bad ? Promise.reject(new Error('Invalid PDF structure.')) : Promise.resolve({
        getPage: async (page: number) => ({
          getViewport: ({ scale }: { scale: number }) => viewport(scale),
          render: ({ canvas: given, canvasContext, viewport: { width, height }, background }: { canvas: null; canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number }; background: unknown }) => {
            // Drawn through the context it is given, which keeps transparency.
            expect(given).toBeNull();
            const canvas = canvasContext.canvas;
            pdfjs.rendered.push({ page, width: canvas.width, height: canvas.height, background });
            expect([canvas.width, canvas.height]).toEqual([Math.ceil(width), Math.ceil(height)]);
            return { promise: Promise.resolve() };
          },
        }),
      }),
      destroy: async () => { pdfjs.destroyed++; },
    };
  },
}));

const { isPdfPicture, pdfPictureScale, PDF_PICTURE_MAX_PX } = await import('./layoutPdfPicture');
const { layoutImageLoads, layoutImageState, paintLayoutImage, prepareLayoutImages } = await import('./layoutImage');

const pdf = (text: string) => `data:application/pdf;base64,${btoa(text)}`;
function picture(src: string): LayoutEntity {
  return { id: 1, layerId: 1, kind: 'image', points: [[0, 0], [30, 0], [30, 20], [0, 20]], closed: true, image: { src } };
}
function context() {
  return { save: vi.fn(), restore: vi.fn(), transform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' } as unknown as CanvasRenderingContext2D & { drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  // jsdom has no 2D canvas; the stand-in renderer only needs the context's canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this } as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  pdfjs.options.length = 0; pdfjs.rendered.length = 0; pdfjs.destroyed = 0; pdfjs.pageSize = [612, 792];
});

it('recognizes PDF pictures by their data URL type', () => {
  expect(isPdfPicture(pdf('%PDF-1.7'))).toBe(true);
  expect(isPdfPicture('data:image/png;base64,iVBOR')).toBe(false);
});

it('draws a PDF picture at 200 pixels per inch of its page, within the size limits', () => {
  expect(pdfPictureScale(612, 792)).toBeCloseTo(200 / 72, 10);
  // A 36 × 24 in sheet is held to 4096 px on its longer side.
  expect(pdfPictureScale(2592, 1728) * 2592).toBeCloseTo(PDF_PICTURE_MAX_PX, 6);
  // A long, narrow page is held to 16 million pixels in all.
  const scale = pdfPictureScale(100 * 72, 20 * 72);
  expect(scale * 100 * 72).toBeLessThanOrEqual(PDF_PICTURE_MAX_PX);
});

it('paints a placeholder while the first page is drawn, then the drawn page', async () => {
  const src = pdf('%PDF-1.7 first');
  const repaint = vi.fn();
  const stop = layoutImageLoads.subscribe(repaint);
  const ctx = context();
  paintLayoutImage(ctx, picture(src), false);
  expect(ctx.drawImage).not.toHaveBeenCalled();
  expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1, 1);
  expect(layoutImageState(src)).toBe('pending');
  // PDF.js loads on first use, so this takes a few turns.
  await vi.waitFor(() => expect(layoutImageState(src)).toBe('loaded'));
  expect(repaint).toHaveBeenCalled();
  // The PDF is opened from its own bytes and drawn once: its first page, on no paper.
  expect(pdfjs.options).toHaveLength(1);
  expect(String.fromCharCode(...(pdfjs.options[0]!.data as Uint8Array))).toBe('%PDF-1.7 first');
  expect(pdfjs.options[0]).toMatchObject({ useWorkerFetch: false });
  expect(pdfjs.rendered).toEqual([{ page: 1, width: 1700, height: 2200, background: 'rgba(0,0,0,0)' }]);
  expect(pdfjs.destroyed).toBe(1);
  expect(pdfjs.workerSrc).toMatch(/pdf\.worker/);
  const again = context();
  paintLayoutImage(again, picture(src), false);
  const [drawn, ...placement] = again.drawImage.mock.calls[0]!;
  expect((drawn as HTMLCanvasElement).width).toBe(1700);
  expect(placement).toEqual([0, 0, 1, 1]);
  paintLayoutImage(context(), picture(src), false);
  expect(pdfjs.rendered).toHaveLength(1);
  stop();
});

it('makes printing wait for a PDF picture, and reports one that cannot be drawn', async () => {
  pdfjs.pageSize = [216, 144];
  await prepareLayoutImages([picture(pdf('%PDF-1.4 print')), picture(pdf('%PDF-1.4 print'))]);
  expect(pdfjs.rendered).toEqual([{ page: 1, width: 600, height: 400, background: 'rgba(0,0,0,0)' }]);
  const broken = pdf('bad PDF');
  await expect(prepareLayoutImages([picture(broken)])).rejects.toThrow('A picture could not be loaded');
  expect(layoutImageState(broken)).toBe('failed');
});

it('supplies the bundled image decoders PDF.js asks for, and nothing else', async () => {
  await prepareLayoutImages([picture(pdf('%PDF-1.4 decoders'))]);
  const Data = pdfjs.options[0]!.BinaryDataFactory as new (options: object) => { fetch(request: { kind: string; filename: string }): Promise<Uint8Array> };
  const fetched: string[] = [];
  const fetchStub = vi.fn(async (url: string) => { fetched.push(url); return new Response(new Uint8Array([0, 97, 115, 109])); });
  vi.stubGlobal('fetch', fetchStub);
  try {
    const data = new Data({});
    expect([...await data.fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' })]).toEqual([0, 97, 115, 109]);
    expect(fetched[0]).toMatch(/openjpeg\.wasm/);
    await expect(data.fetch({ kind: 'wasmUrl', filename: 'jbig2.wasm' })).resolves.toBeInstanceOf(Uint8Array);
    expect(fetched[1]).toMatch(/jbig2\.wasm/);
    await expect(data.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSans.pfb' })).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
