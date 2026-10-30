// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { LayoutEntity } from '@pushform/layout';
import { GOOGLE_LAYOUT_FONTS } from './layoutFontCatalog';

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules();
  document.querySelectorAll('link[data-layout-font]').forEach(link => link.remove());
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts); else Reflect.deleteProperty(document, 'fonts');
});
const text = (family: string): LayoutEntity => ({ id: 1, kind: 'text', layerId: 1, points: [[0, 0], [50, 20]], closed: false,
  text: { content: 'Hello world', fontFamily: family, fontSizePt: 12, color: '#222222', bold: false, italic: false, underline: false,
    align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('offers 160 verified popular families and requests only supported upright and italic styles', async () => {
  const { googleLayoutFontUrl } = await import('./layoutFonts');
  expect(GOOGLE_LAYOUT_FONTS).toHaveLength(160);
  expect(new Set(GOOGLE_LAYOUT_FONTS.map(font => font.family)).size).toBe(160);
  expect(googleLayoutFontUrl('Open Sans')).toBe('https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap');
  expect(googleLayoutFontUrl('Bebas Neue')).toBe('https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap');
  expect(googleLayoutFontUrl('Unknown local font')).toBeNull();
});

it('loads only used families, deduplicates requests, and waits for real glyph faces before notifying painters', async () => {
  let resolveFace!: (faces: FontFace[]) => void;
  let loaded = false;
  const load = vi.fn(() => new Promise<FontFace[]>(resolve => { resolveFace = resolve; }));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => loaded, load } });
  const { prepareLayoutFonts, layoutFontLoads } = await import('./layoutFonts');
  const notify = vi.fn(), unsubscribe = layoutFontLoads.subscribe(notify);
  let finished = false;
  const first = prepareLayoutFonts([text('Inter')]).then(() => { finished = true; });
  const second = prepareLayoutFonts([text('Inter')]);
  const links = document.querySelectorAll('link[data-layout-font]');
  expect(links).toHaveLength(1); expect(load).not.toHaveBeenCalled();
  links[0]!.dispatchEvent(new Event('load')); await tick();
  expect(load).toHaveBeenCalledOnce(); expect(finished).toBe(false);
  expect(load).toHaveBeenCalledWith('normal 400 16px "Inter"', expect.stringContaining('Hello world'));
  loaded = true; resolveFace([{} as FontFace]); await Promise.all([first, second]);
  expect(finished).toBe(true); expect(notify).toHaveBeenCalledOnce();
  await prepareLayoutFonts([text('Inter')]);
  expect(load).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
  unsubscribe();
});

it('includes selected-range fonts and dimensions, while preserving local font support without network requests', async () => {
  const { layoutFontRequests, prepareLayoutFonts } = await import('./layoutFonts');
  const entity = text('Arial');
  entity.text!.spans = [{ start: 6, end: 11, fontFamily: 'Roboto', bold: true, italic: true, underline: false }];
  const { createLinearDimension } = await import('@pushform/layout');
  const dimension: LayoutEntity = { id: 2, kind: 'dimension', layerId: 1, closed: false, points: [[0, 0], [10, 0], [0, 10]],
    dimension: { ...createLinearDimension(), fontFamily: 'Open Sans' } };
  const requests = layoutFontRequests([entity, dimension]);
  expect(requests.map(request => request.family)).toEqual(['Roboto', 'Open Sans']);
  expect(requests[0]!.descriptor).toContain('italic 700');
  await prepareLayoutFonts([text('Arial')]);
  expect(document.querySelectorAll('link[data-layout-font]')).toHaveLength(0);
});

it('reports stylesheet and font-download failures instead of silently printing a substitute', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => false, load: vi.fn().mockRejectedValue(new Error('Network down')) } });
  const { prepareLayoutFonts, layoutFontStatus } = await import('./layoutFonts');
  const failedSheet = prepareLayoutFonts([text('Lato')]);
  const sheetAssertion = expect(failedSheet).rejects.toThrow('Could not load Lato');
  document.querySelector('link[data-layout-font="Lato"]')!.dispatchEvent(new Event('error'));
  await sheetAssertion; expect(layoutFontStatus('Lato')).toBe('failed');
  const failedFace = prepareLayoutFonts([text('Inter')]);
  const faceAssertion = expect(failedFace).rejects.toThrow('Network down');
  document.querySelector('link[data-layout-font="Inter"]')!.dispatchEvent(new Event('load'));
  await faceAssertion; expect(layoutFontStatus('Inter')).toBe('failed');
});

it('tracks readiness per face, so a later bold face of a ready family is not ready until it arrives', async () => {
  const load = vi.fn(async () => [{} as FontFace]);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => false, load } });
  const { prepareLayoutFonts, layoutFontFaceReady, layoutFontRequests, layoutFontStatus } = await import('./layoutFonts');
  const regular = text('Inter');
  const first = prepareLayoutFonts([regular]);
  document.querySelector('link[data-layout-font="Inter"]')!.dispatchEvent(new Event('load'));
  await first;
  expect(layoutFontStatus('Inter')).toBe('ready');
  const sample = layoutFontRequests([regular])[0]!.sample;
  expect(layoutFontFaceReady('normal 400 16px "Inter"', sample)).toBe(true);
  expect(layoutFontFaceReady('normal 700 16px "Inter"', sample)).toBe(false);
});
