// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { combineLayoutVectorPages, layoutVectorBounds } from './layoutVector';
import type { LayoutVectorItem, LayoutVectorPage, VectorMatrix, VectorPath, VectorSegment } from './layoutVector';

function page(segments: VectorSegment[]): LayoutVectorPage {
  return {
    name: 'Drawing', width: 210, height: 297, background: '#ffffff',
    items: [{ kind: 'path', layer: 'Drawing', clips: [], path: { segments },
      fill: null, stroke: '#000000', weight: 2, dash: [], evenodd: false }],
  };
}

describe('Layout vector drawing bounds', () => {
  it('handles large paths without exceeding the function argument limit', () => {
    const segments: VectorSegment[] = [{ kind: 'move', point: [-10, -20] }];
    for (let i = 0; i < 100_000; i++) segments.push({ kind: 'line', point: [i, i % 100] });
    const bounds = layoutVectorBounds(page(segments), 'drawing');
    expect(bounds).toMatchObject({ x: -11, y: -21, width: 100_011 });
    expect(bounds.height).toBeGreaterThanOrEqual(121);
    expect(Number.isFinite(bounds.height)).toBe(true);
  });

  it('retains interior Bézier extrema and stroke padding', () => {
    expect(layoutVectorBounds(page([
      { kind: 'move', point: [0, 0] },
      { kind: 'cubic', c1: [0, 20], c2: [20, 20], point: [20, 0] },
    ]), 'drawing')).toEqual({ x: -1, y: -1, width: 22, height: 17 });
  });

  it('rejects empty drawing bounds while preserving full-page bounds', () => {
    const empty = page([]);
    expect(() => layoutVectorBounds(empty, 'drawing')).toThrow('There are no drawing elements to export.');
    expect(layoutVectorBounds(empty, 'page')).toEqual({ x: 0, y: 0, width: 210, height: 297 });
  });

  it('preserves minimum dimensions for a zero-width stroke at a single point', () => {
    const drawing = page([{ kind: 'move', point: [5, 7] }]);
    const item = drawing.items[0]!;
    if (item.kind === 'path') item.weight = 0;
    expect(layoutVectorBounds(drawing, 'drawing')).toEqual({ x: 5, y: 7, width: 0.01, height: 0.01 });
  });
});

it('writes escaped SVG with embedded images, transformed text and clipping', async () => {
  const { writeLayoutSvg } = await import('./layoutVector');
  const drawing = page([{ kind: 'move', point: [10, 20] }, { kind: 'line', point: [30, 40] }]);
  drawing.name = 'Plan <A> & B';
  drawing.items.push({ kind: 'image', layer: 'Pictures', clips: [{ segments: [{ kind: 'move', point: [0, 0] },
    { kind: 'line', point: [10, 0] }, { kind: 'line', point: [10, 10] }, { kind: 'close' }] }],
    src: 'data:image/png;base64,AA==', matrix: [0, 1, -1, 0, 50, 20], x: 0, y: 0, width: 10, height: 10 });
  drawing.items.push({ kind: 'text', layer: 'Notes', clips: [], text: '< & >', matrix: [1, 0, 0, 1, 0, 0], point: [10, 20],
    font: '4px "Arial"', color: '#123456', align: 'center', baseline: 'alphabetic', bounds: [0, 0, 10, 4] });
  const svg = writeLayoutSvg(drawing);
  expect(svg).toContain('width="210mm" height="297mm"');
  expect(svg).toContain('Plan &lt;A&gt; &amp; B');
  expect(svg).toContain('href="data:image/png;base64,AA=="');
  expect(svg).toContain('clip-path="url(#clip0)"');
  expect(svg).toContain('matrix(0 1 -1 0 50 20)');
  expect(svg).toContain('text-anchor="middle"');
  expect(svg).toContain('&lt; &amp; &gt;</text>');
});

it('includes mitered corners in artwork bounds so SVG does not cut them off', () => {
  const drawing = page([{ kind: 'move', point: [0, 10] }, { kind: 'line', point: [10, 0] }, { kind: 'line', point: [20, 10] }]);
  const bounds = layoutVectorBounds(drawing, 'drawing');
  expect(bounds.y).toBeCloseTo(-Math.SQRT2);
  expect(bounds.height).toBeCloseTo(11 + Math.SQRT2);
});

it('excludes text overflow outside retained clips from artwork bounds', () => {
  const drawing: LayoutVectorPage = { name: 'Text', width: 100, height: 80, background: '#ffffff', items: [{
    kind: 'text', layer: 'Notes', clips: [{ segments: [{ kind: 'move', point: [10, 10] }, { kind: 'line', point: [30, 10] },
      { kind: 'line', point: [30, 20] }, { kind: 'line', point: [10, 20] }, { kind: 'close' }] }], text: 'Overflow',
    point: [10, 15], matrix: [1, 0, 0, 1, 0, 0], font: '4px "Arial"', color: '#000000', align: 'left', baseline: 'alphabetic',
    bounds: [10, 10, 60, 100],
  }] };
  expect(layoutVectorBounds(drawing, 'drawing')).toEqual({ x: 10, y: 10, width: 20, height: 10 });
});

it('preserves inch paper dimensions without changing geometry or scale', async () => {
  const { writeLayoutSvg } = await import('./layoutVector');
  const drawing = page([{ kind: 'move', point: [25.4, 25.4] }, { kind: 'line', point: [50.8, 50.8] }]);
  drawing.paperUnits = 'in'; drawing.width = 279.4; drawing.height = 215.9;
  const svg = writeLayoutSvg(drawing);
  expect(svg).toContain('width="11in" height="8.5in"');
  expect(svg).toContain('viewBox="0 0 279.4 215.9"');
  expect(svg).toContain('inkscape:document-units="in" units="in"');
  expect(svg).toContain('d="M25.4 25.4 L50.8 50.8"');
  const item = drawing.items[0]!;
  if (item.kind !== 'path') throw new Error('Expected path');
  item.weight = 0;
  const cropped = writeLayoutSvg(drawing, 'drawing');
  expect(cropped).toContain('width="1in" height="1in"');
  expect(cropped).toContain('viewBox="25.4 25.4 25.4 25.4"');
});

it('retains millimeters for metric and legacy documents', async () => {
  const { writeLayoutSvg } = await import('./layoutVector');
  const drawing = page([]);
  for (const explicit of [false, true]) {
    if (explicit) drawing.paperUnits = 'mm';
    const svg = writeLayoutSvg(drawing);
    expect(svg).toContain('width="210mm" height="297mm"');
    expect(svg).toContain('inkscape:document-units="mm" units="mm"');
  }
});

describe('Layout vector bounds of transformed text and images', () => {
  const text = (matrix: VectorMatrix, bounds: [number, number, number, number]): LayoutVectorItem => ({
    kind: 'text', layer: 'Notes', clips: [], text: 'T', point: [bounds[0], bounds[3]], matrix, font: '4px "Arial"',
    color: '#000000', align: 'left', baseline: 'alphabetic', bounds,
  });
  const image = (matrix: VectorMatrix, x: number, y: number, width: number, height: number): LayoutVectorItem => ({
    kind: 'image', layer: 'Pictures', clips: [], src: 'data:image/png;base64,AA==', matrix, x, y, width, height,
  });
  const sheet = (...items: LayoutVectorItem[]): LayoutVectorPage => ({ name: 'Sheet', width: 200, height: 200, background: '#ffffff', items });

  it('translates text bounds by the matrix offset', () => {
    expect(layoutVectorBounds(sheet(text([1, 0, 0, 1, 30, 40], [0, 0, 10, 4])), 'drawing')).toEqual({ x: 30, y: 40, width: 10, height: 4 });
  });

  it('rotates a picture a quarter turn so its width and height swap', () => {
    // Corners (2,3) (12,3) (12,7) (2,7) map to (47,22) (47,32) (43,32) (43,22).
    expect(layoutVectorBounds(sheet(image([0, 1, -1, 0, 50, 20], 2, 3, 10, 4)), 'drawing')).toEqual({ x: 43, y: 22, width: 4, height: 10 });
  });

  it('covers every corner of text rotated by an arbitrary angle', () => {
    const angle = Math.PI / 6, cos = Math.cos(angle), sin = Math.sin(angle);
    const bounds = layoutVectorBounds(sheet(text([cos, sin, -sin, cos, 0, 0], [0, 0, 10, 4])), 'drawing');
    // Corners map to (0,0), (8.660,5), (6.660,8.464) and (-2,3.464).
    expect(bounds.x).toBeCloseTo(-2, 6);
    expect(bounds.y).toBeCloseTo(0, 6);
    expect(bounds.width).toBeCloseTo(10 * cos + 4 * sin, 6);
    expect(bounds.height).toBeCloseTo(10 * sin + 4 * cos, 6);
  });

  it('keeps reflected text and pictures inside positive extents', () => {
    expect(layoutVectorBounds(sheet(text([-1, 0, 0, 1, 100, 0], [10, 20, 30, 24])), 'drawing')).toEqual({ x: 70, y: 20, width: 20, height: 4 });
    expect(layoutVectorBounds(sheet(image([1, 0, 0, -1, 0, 100], 10, 20, 20, 4)), 'drawing')).toEqual({ x: 10, y: 76, width: 20, height: 4 });
  });

  it('scales text and pictures nonuniformly about the matrix origin', () => {
    expect(layoutVectorBounds(sheet(image([2, 0, 0, 0.5, 5, 5], 1, 2, 10, 8)), 'drawing')).toEqual({ x: 7, y: 6, width: 20, height: 4 });
    expect(layoutVectorBounds(sheet(text([0.5, 0, 0, 3, -1, 2], [4, 1, 8, 3])), 'drawing')).toEqual({ x: 1, y: 5, width: 2, height: 6 });
  });

  it('ignores pictures when includeImages is false', () => {
    const picture = image([1, 0, 0, 1, 100, 100], 0, 0, 50, 50);
    const note = text([1, 0, 0, 1, 0, 0], [10, 10, 20, 14]);
    expect(layoutVectorBounds(sheet(picture, note), 'drawing')).toEqual({ x: 10, y: 10, width: 140, height: 140 });
    expect(layoutVectorBounds(sheet(picture, note), 'drawing', false)).toEqual({ x: 10, y: 10, width: 10, height: 4 });
    expect(() => layoutVectorBounds(sheet(picture), 'drawing', false)).toThrow('There are no drawing elements to export.');
    expect(layoutVectorBounds(sheet(picture), 'page', false)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });
});

describe('Combining Layout vector pages', () => {
  const rect = (x: number, y: number, w: number, h: number): VectorPath => ({ segments: [{ kind: 'move', point: [x, y] },
    { kind: 'line', point: [x + w, y] }, { kind: 'line', point: [x + w, y + h] }, { kind: 'line', point: [x, y + h] }, { kind: 'close' }] });
  const pages = (): LayoutVectorPage[] => [
    { name: 'A', width: 100, height: 50, background: '#ffffff', items: [
      { kind: 'path', layer: 'Drawing', clips: [], path: { segments: [{ kind: 'move', point: [10, 10] }, { kind: 'line', point: [20, 30] }] },
        fill: null, stroke: '#000000', weight: 1, dash: [], evenodd: false },
    ] },
    { name: 'B', width: 60, height: 80, background: '#eeeeee', paperUnits: 'in', items: [
      { kind: 'path', layer: 'Drawing', clips: [rect(0, 0, 60, 80)], path: { segments: [{ kind: 'move', point: [5, 5] },
        { kind: 'cubic', c1: [10, 0], c2: [15, 10], point: [20, 5] }, { kind: 'close' }] }, fill: '#ff0000', stroke: null, weight: 0, dash: [], evenodd: true },
      { kind: 'text', layer: 'Notes', clips: [rect(1, 1, 20, 10)], text: 'B', point: [3, 8], matrix: [1, 0, 0, 1, 3, 4], font: '4px "Arial"',
        color: '#000000', align: 'left', baseline: 'alphabetic', bounds: [0, 0, 10, 4] },
      { kind: 'image', layer: 'Pictures', clips: [], src: 'data:image/png;base64,AA==', matrix: [0, 1, -1, 0, 7, 8], x: 0, y: 0, width: 10, height: 10 },
    ] },
    { name: 'C', width: 20, height: 20, background: '#000000', items: [
      { kind: 'path', layer: 'Drawing', clips: [], path: { segments: [{ kind: 'move', point: [0, 0] }, { kind: 'line', point: [20, 20] }] },
        fill: null, stroke: '#0000ff', weight: 2, dash: [1, 1], evenodd: false },
    ] },
  ];

  it('rejects an empty page list', () => {
    expect(() => combineLayoutVectorPages([])).toThrow('Choose at least one page to export.');
  });

  it('places pages of different sizes side by side in input order with a 10 mm gap', () => {
    const combined = combineLayoutVectorPages(pages());
    expect(combined.name).toBe('A, B, C');
    expect(combined.width).toBe(100 + 10 + 60 + 10 + 20);
    expect(combined.height).toBe(80);
    expect(combined.background).toBe('#ffffff');
    expect(combined.paperUnits).toBe('mm');
    expect(combined.items.map(i => i.layer)).toEqual(['Drawing', 'Drawing', 'Notes', 'Pictures', 'Drawing']);
    expect(layoutVectorBounds(combined, 'page')).toEqual({ x: 0, y: 0, width: 200, height: 80 });
    expect(combineLayoutVectorPages(pages().slice(1, 2)).paperUnits).toBe('in');
  });

  it('shifts geometry, controls, clips and matrices by the preceding pages', () => {
    const [a, b, bText, bImage, c] = combineLayoutVectorPages(pages()).items;
    if (a?.kind !== 'path' || b?.kind !== 'path' || bText?.kind !== 'text' || bImage?.kind !== 'image' || c?.kind !== 'path') throw new Error('Unexpected items');
    expect(a.path.segments).toEqual([{ kind: 'move', point: [10, 10] }, { kind: 'line', point: [20, 30] }]);
    expect(b.path.segments).toEqual([{ kind: 'move', point: [115, 5] }, { kind: 'cubic', c1: [120, 0], c2: [125, 10], point: [130, 5] }, { kind: 'close' }]);
    expect(b.clips).toEqual([rect(110, 0, 60, 80)]);
    expect(b).toMatchObject({ fill: '#ff0000', stroke: null, evenodd: true });
    expect(bText.matrix).toEqual([1, 0, 0, 1, 113, 4]);
    expect(bText.point).toEqual([3, 8]);
    expect(bText.bounds).toEqual([0, 0, 10, 4]);
    expect(bText.clips).toEqual([rect(111, 1, 20, 10)]);
    expect(bImage.matrix).toEqual([0, 1, -1, 0, 117, 8]);
    expect(bImage).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(c.path.segments).toEqual([{ kind: 'move', point: [180, 0] }, { kind: 'line', point: [200, 20] }]);
    expect(c).toMatchObject({ stroke: '#0000ff', weight: 2, dash: [1, 1] });
  });

  it('leaves the input pages, items, paths and matrices unchanged', () => {
    const input = pages();
    const snapshot = structuredClone(input);
    const combined = combineLayoutVectorPages(input);
    expect(input).toEqual(snapshot);
    const [, b, bText, bImage] = combined.items;
    const [, bIn, bTextIn, bImageIn] = input[1]!.items;
    expect(b).not.toBe(bIn);
    if (b?.kind === 'path' && bIn?.kind === 'path') { expect(b.path).not.toBe(bIn.path); expect(b.clips[0]).not.toBe(bIn.clips[0]); }
    if (bText?.kind === 'text' && bTextIn?.kind === 'text') expect(bText.matrix).not.toBe(bTextIn.matrix);
    if (bImage?.kind === 'image' && bImageIn?.kind === 'image') expect(bImage.matrix).not.toBe(bImageIn.matrix);
  });
});
