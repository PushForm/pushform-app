// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { parseDxf } from './dxf';
import { writeLayoutDxf } from './layoutDxfExport';
import type { LayoutVectorPage } from './layoutVector';

const page = (): LayoutVectorPage => ({ name: 'Plan', width: 100, height: 80, background: '#ffffff', items: [{
  kind: 'path', layer: 'Walls', clips: [], path: { segments: [
    { kind: 'move', point: [10, 20] }, { kind: 'line', point: [30, 20] },
    { kind: 'cubic', c1: [40, 20], c2: [40, 40], point: [30, 40] }, { kind: 'close' },
  ] }, fill: '#ff0000', stroke: '#123456', weight: 0.25, dash: [2, 1], evenodd: false,
}] });

it('writes readable CAD geometry, fills, layers and scaled dashes with Y up', () => {
  const { text, warnings } = writeLayoutDxf(page(), 'page', 50);
  expect(warnings).toEqual([]);
  const drawing = parseDxf(strToU8(text));
  expect(drawing.version).toBe('AC1024'); expect(drawing.units?.unit).toBe('mm');
  expect(drawing.layers.has('Walls')).toBe(true);
  expect(drawing.linetypes.get('PF_DASH_1')).toEqual([100, -50]);
  expect(drawing.items.map(item => item.kind)).toEqual(['fill', 'path', 'path', 'path']);
  const fill = drawing.items[0]!;
  expect(fill.kind === 'fill' && fill.loops[0]!.length).toBe(3);
  const line = drawing.items[1]!;
  expect(line).toMatchObject({ layer: 'Walls', lineweight: 25, curves: [{ kind: 'line', a: [500, 3000, 0], b: [1500, 3000, 0] }] });
  const curve = drawing.items[2]!;
  expect(curve.kind === 'path' && curve.curves[0]!.kind).toBe('points');
});

it('retains compound fill holes as separate boundary loops', () => {
  const drawing = page(), shape = drawing.items[0]!;
  if (shape.kind !== 'path') throw new Error('Expected path');
  shape.evenodd = true;
  shape.path.segments.push({ kind: 'move', point: [20, 25] }, { kind: 'line', point: [25, 25] },
    { kind: 'line', point: [25, 30] }, { kind: 'close' });
  const fill = parseDxf(strToU8(writeLayoutDxf(drawing).text)).items[0]!;
  expect(fill.kind === 'fill' && fill.loops).toHaveLength(2);
});

it('omits images with a notice and exports rotated text with font and clipping notices', () => {
  const drawing = page();
  drawing.items.push({ kind: 'image', layer: 'Walls', clips: [], src: 'data:image/png;base64,AA==', x: 0, y: 0,
    width: 10, height: 10, matrix: [1, 0, 0, 1, 0, 0] });
  drawing.items.push({ kind: 'text', layer: 'Notes', clips: [{ segments: [] }], text: 'Ø 50%', point: [1, 2],
    matrix: [0, 1, -1, 0, 10, 20], font: '4px "Arial"', color: '#000000', align: 'left', baseline: 'alphabetic', bounds: [0, 0, 10, 4] });
  const result = writeLayoutDxf(drawing);
  expect(result.warnings).toHaveLength(3);
  const text = parseDxf(strToU8(result.text)).items.at(-1)!;
  expect(text).toMatchObject({ kind: 'text', text: 'Ø 50%', anchor: [8, 59, 0] });
});
