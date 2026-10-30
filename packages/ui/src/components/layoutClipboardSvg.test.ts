// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { layoutClipboardSvg } from './layoutClipboard';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const page = () => createLayoutDocument().state.pages.values().next().value!;

it('pastes SVG curves, compound contours, transformed shapes and styles as native editable paths', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const entities = await layoutClipboardSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">
    <style>.shape {fill:#123456;stroke:#ff0000;stroke-width:2}</style>
    <g transform="translate(10 20)"><rect class="shape" x="0" y="0" width="30" height="20"/>
    <path d="M 0 30 C 10 20 20 40 30 30" fill="none" stroke="blue"/>
    <path fill-rule="evenodd" d="M40 0H70V30H40Z M45 5H65V25H45Z"/></g>
  </svg>`, page());
  expect(entities.map(entity => entity.kind)).toEqual(['path', 'path', 'path']);
  expect(entities[0]!.style).toMatchObject({ fillColor: '#123456', strokeColor: '#ff0000', strokeWeightPt: 1.5 });
  expect(entities[1]!.handles!.some(handle => handle.in || handle.out)).toBe(true);
  expect(entities[2]!.contourStarts).toEqual([0, 4]);
  expect(entities.flatMap(entity => entity.points).every(point => point.every(Number.isFinite))).toBe(true);
});

it.each([
  { attributes: '', scale: 1 },
  { attributes: 'width="100mm" height="100mm" viewBox="0 0 100 100"', scale: 96 / 25.4 },
])('pastes editable SVG text at its physical scale ($scale) and strips active markup', async ({ attributes, scale }) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return new Proxy({ canvas: this, measureText: (value: string) => ({ width: value.length * 7 }) }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(),
    }) as unknown as CanvasRenderingContext2D;
  });
  const entities = await layoutClipboardSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><script>throw 1</script><text x="10" y="30" font-family="Arial" font-size="20" fill="#123456" onclick="bad()">Editable</text></svg>`, page());
  expect(entities).toHaveLength(1); expect(entities[0]!.kind).toBe('text');
  expect(entities[0]!.text).toMatchObject({ content: 'Editable', fontFamily: 'Arial', color: '#123456' });
  expect(entities[0]!.text!.fontSizePt).toBeCloseTo(15 * scale);
});

it('reports unsupported SVG effects without silently flattening, and rejects invalid SVG or external resources', async () => {
  vi.stubGlobal('Image', class {
    naturalWidth = 100; naturalHeight = 50;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  await expect(layoutClipboardSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)"/></svg>', page())).rejects.toThrow(/gradients/);
  await expect(layoutClipboardSvg('<svg><broken></svg>', page())).rejects.toThrow('invalid');
  await expect(layoutClipboardSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg#x"/></svg>', page())).rejects.toThrow('External');
});

it('ignores unused effects in definitions and clips paths into editable fill and open stroke geometry', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const entities = await layoutClipboardSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <defs><linearGradient id="unused"/><clipPath id="clip"><rect x="20" y="20" width="40" height="40"/></clipPath></defs>
    <g clip-path="url(#clip)"><rect x="0" y="0" width="50" height="50" fill="#ff0000" stroke="#0000ff"/>
    <path d="M 0 30 C 30 25 60 35 90 30" fill="none" stroke="green"/></g></svg>`, page());
  expect(entities.length).toBeGreaterThanOrEqual(2);
  expect(entities.every(entity => entity.kind === 'path')).toBe(true);
  expect(entities.some(entity => !entity.closed && entity.handles?.some(h => h.in || h.out))).toBe(true);
  const fill = entities.find(entity => entity.style?.fillColor === '#ff0000')!;
  expect(fill.closed).toBe(true); expect(fill.style!.strokeColor).toBe('#00000000');
  expect(Math.max(...fill.points.map(p => p[0])) - Math.min(...fill.points.map(p => p[0]))).toBeCloseTo(30 * 25.4 / 96);
});
it('retains physical dimensions and independent open and closed objects from exported SVG', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const entities = await layoutClipboardSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30">
    <path d="M0 0H50V30H0Z" fill="red"/><path d="M5 5L45 25" fill="none" stroke="blue" stroke-width="1"/></svg>`, page());
  expect(entities).toHaveLength(2);
  expect(entities.map(entity => entity.closed)).toEqual([true, false]);
  expect(Math.max(...entities[0]!.points.map(p => p[0]))).toBeCloseTo(50);
  expect(entities[1]!.style!.strokeWeightPt).toBeCloseTo(72 / 25.4);
});

it('clips straight open lines even when their bounds have zero area', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const entities = await layoutClipboardSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <defs><clipPath id="c"><rect x="20" y="20" width="40" height="40"/></clipPath></defs>
    <path clip-path="url(#c)" d="M0 30H90" fill="none" stroke="#000000"/></svg>`, page());
  expect(entities).toHaveLength(1);
  expect(entities[0]!.closed).toBe(false);
  expect(Math.max(...entities[0]!.points.map(p => p[0]))).toBeCloseTo(40 * 25.4 / 96);
});
