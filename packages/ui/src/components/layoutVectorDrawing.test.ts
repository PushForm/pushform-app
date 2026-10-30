// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from '@pushform/commands';
import { parseDxf, writeLayoutDxf, writeLayoutSvg } from '@pushform/io';
import { strToU8 } from 'fflate';
import { drawLayoutVectorPage } from './layoutVectorDrawing';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 2, actualBoundingBoxAscent: 3, actualBoundingBoxDescent: 1 }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const rectangle = (x: number) => commands.execute('layout.shape.add', { pageId, closed: true,
    points: [[x, 10], [x + 20, 10], [x + 20, 30], [x, 30]] }) as number;
  const drawing = () => drawLayoutVectorPage(doc.state, doc.state.pages.get(pageId)!);
  const svg = () => new DOMParser().parseFromString(writeLayoutSvg(drawing(), 'drawing'), 'image/svg+xml').documentElement;
  return { doc, commands, pageId, rectangle, drawing, svg };
}

it('exports each filled shape as one editable path and leaves ungrouped objects on the same layer separate', () => {
  const { commands, pageId, rectangle, drawing, svg } = setup();
  const first = rectangle(10), second = rectangle(40);
  commands.execute('layout.shape.setStyle', { pageId, entityId: first, fillColor: '#ff000080', strokeColor: '#0000ff', strokeWeightPt: 2, strokeDashMm: [2, 1] });
  const root = svg(), paths = root.querySelectorAll('path');
  expect(root.querySelector('parsererror')).toBeNull();
  expect(root.querySelectorAll('g')).toHaveLength(0);
  expect(paths).toHaveLength(2);
  expect([...paths].map(path => path.getAttribute('data-object-id'))).toEqual([String(first), String(second)]);
  expect(paths[0]!.getAttribute('fill')).toBe('#ff000080');
  expect(paths[0]!.getAttribute('stroke')).toBe('#0000ff');
  expect(paths[0]!.getAttribute('stroke-dasharray')).toBe('2 1');
  expect(paths[0]!.getAttribute('data-layer')).toBe('Layer 1');
  // A combined vector item must still produce both the CAD hatch and its outline.
  expect(parseDxf(strToU8(writeLayoutDxf(drawing()).text)).items.map(item => item.kind)).toEqual(['fill', 'path', 'fill', 'path']);
});

it('retains real nested groups without including their ungrouped neighbor', () => {
  const { commands, pageId, rectangle, svg } = setup();
  const ids = [rectangle(10), rectangle(40), rectangle(70), rectangle(100)];
  const inner = commands.execute('layout.shape.group', { pageId, entityIds: ids.slice(0, 2) }) as number;
  const outer = commands.execute('layout.shape.group', { pageId, entityIds: ids.slice(0, 3) }) as number;
  const root = svg(), outerNode = root.querySelector(`g[data-group-id="${outer}"]`)!;
  expect(root.querySelectorAll('g')).toHaveLength(2);
  expect(outerNode.parentElement).toBe(root);
  expect(outerNode.querySelector(`g[data-group-id="${inner}"]`)!.querySelectorAll('path')).toHaveLength(2);
  expect(outerNode.querySelectorAll('path')).toHaveLength(3);
  expect(root.querySelector(`[data-object-id="${ids[3]}"]`)!.parentElement).toBe(root);
});

it('preserves stacking order when a source group is interrupted by an ungrouped object', () => {
  const { commands, pageId, rectangle, svg } = setup();
  const ids = [rectangle(10), rectangle(20), rectangle(30)];
  const group = commands.execute('layout.shape.group', { pageId, entityIds: [ids[0], ids[2]] }) as number;
  const root = svg();
  expect([...root.querySelectorAll('path')].map(node => node.getAttribute('data-object-id'))).toEqual(ids.map(String));
  expect(root.querySelectorAll(`g[data-group-id="${group}"]`)).toHaveLength(2);
  expect(root.querySelector(`[data-object-id="${ids[1]}"]`)!.parentElement).toBe(root);
});

it('keeps compound holes in a single filled and stroked path', () => {
  const { commands, pageId, svg } = setup();
  commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true,
    points: [[10, 10], [50, 10], [50, 50], [10, 50], [20, 20], [40, 20], [40, 40], [20, 40]], contourStarts: [0, 4],
    style: { fillColor: '#ff0000', strokeColor: '#000000', strokeWeightPt: 1 } }] });
  const paths = svg().querySelectorAll('path');
  expect(paths).toHaveLength(1);
  expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd');
  expect(paths[0]!.getAttribute('fill')).toBe('#ff0000');
  expect(paths[0]!.getAttribute('stroke')).toBe('#000000');
  expect(paths[0]!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
});

it('keeps a table together as one object without grouping it with other objects on its layer', () => {
  const { commands, pageId, rectangle, svg } = setup();
  const id = commands.execute('layout.table.add', { pageId, first: [10, 10], second: [70, 40], rows: 2, columns: 2 }) as number;
  const neighbor = rectangle(100), root = svg();
  expect(root.querySelectorAll('g')).toHaveLength(1);
  const table = root.querySelector(`g[data-object-id="${id}"]`)!;
  expect(table.querySelectorAll('path').length).toBeGreaterThan(1);
  expect(root.querySelector(`[data-object-id="${neighbor}"]`)!.parentElement).toBe(root);
});

it('keeps different fill and stroke geometry together without closing open stroke contours', () => {
  const { commands, pageId, svg } = setup();
  const [id] = commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'path', closed: true,
    points: [[10, 10], [50, 10], [50, 50], [10, 50], [20, 20], [40, 20], [40, 40]], contourStarts: [0, 4], openContours: [1],
    style: { fillColor: '#ff0000', strokeColor: '#000000', strokeWeightPt: 1 } }] }) as number[];
  const root = svg(), object = root.querySelector(`g[data-object-id="${id}"]`)!;
  expect(root.querySelectorAll('g')).toHaveLength(1);
  expect(object.querySelectorAll('path')).toHaveLength(2);
  const fill = object.querySelector('[fill="#ff0000"]')!, stroke = object.querySelector('[stroke="#000000"]')!;
  expect(fill.getAttribute('d')!.match(/Z/g)).toHaveLength(2);
  expect(stroke.getAttribute('d')!.match(/Z/g)).toHaveLength(1);
});

it('exports a rotated multiline text block as one editable text element with styled spans', () => {
  const { commands, pageId, svg } = setup();
  const [id] = commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'text', closed: false,
    points: [[10, 10], [80, 50]], text: { content: 'Hello bold\nNext line', fontFamily: 'Arial', fontSizePt: 12,
      color: '#123456', bold: false, italic: false, underline: false, align: 'left', vertical: 'top', bounded: true,
      rotationDeg: 30, leader: 'none', endpoint: 'none',
      spans: [{ start: 6, end: 10, bold: true, italic: true, underline: true, color: '#ff0000' }] } }] }) as number[];
  const root = svg(), text = root.querySelector('text')!;
  expect(root.querySelectorAll('text')).toHaveLength(1);
  expect(text.textContent).toBe('Hello boldNext line');
  const spans = [...text.querySelectorAll('tspan')];
  expect(spans.map(span => span.textContent)).toEqual(['Hello ', 'bold', 'Next line']);
  expect(spans[1]!.getAttribute('style')).toContain('bold');
  expect(spans[1]!.getAttribute('style')).toContain('italic');
  expect(spans[1]!.getAttribute('style')).toContain('text-decoration:underline');
  expect(spans[1]!.getAttribute('fill')).toBe('#ff0000');
  expect(spans[0]!.getAttribute('x')!.split(' ')).toHaveLength(6);
  expect(spans[0]!.getAttribute('y')).not.toBe(spans[2]!.getAttribute('y'));
  expect(text.getAttribute('transform')).not.toBe('matrix(1 0 0 1 0 0)');
  expect(root.querySelector('[clip-path]')).toBeTruthy();
  expect(text.getAttribute('data-object-id')).toBe(String(id));
  // Underlines remain text decoration instead of interrupting the block with one path per glyph.
  expect(root.querySelectorAll('g[data-object-id]')).toHaveLength(0);
  expect(root.querySelectorAll('path[d]')).toHaveLength(1); // The clipping rectangle only.
});

it('keeps neighboring text boxes and table cells as separate editable text elements', () => {
  const { commands, pageId, doc, svg } = setup();
  const text = { content: 'Same', fontFamily: 'Arial', fontSizePt: 12, color: '#000000', bold: false, italic: false,
    underline: false, align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none' };
  commands.execute('layout.clipboard.paste', { pageId, entities: [
    { kind: 'text', closed: false, points: [[10, 10], [70, 30]], text },
    { kind: 'text', closed: false, points: [[10, 40], [70, 60]], text },
  ] });
  const id = commands.execute('layout.table.add', { pageId, first: [90, 10], second: [160, 40], rows: 1, columns: 2 }) as number;
  const table = structuredClone(doc.state.pages.get(pageId)!.entities.get(id)!.table!);
  table.cells[0]!.text.content = 'First'; table.cells[1]!.text.content = 'Second';
  commands.execute('layout.table.update', { pageId, entityId: id, table });
  const root = svg();
  expect([...root.querySelectorAll('text')].map(node => node.textContent)).toEqual(['Same', 'Same', 'First', 'Second']);
  expect(root.querySelector(`g[data-object-id="${id}"]`)!.querySelectorAll('text')).toHaveLength(2);
});

it('uses the original per-glyph canvas painting when recording CAD text and underlines', () => {
  const { commands, pageId, doc } = setup();
  commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'text', closed: false,
    points: [[10, 10], [70, 30]], text: { content: 'ABC', fontFamily: 'Arial', fontSizePt: 12, color: '#000000',
      bold: false, italic: false, underline: true, align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none' } }] });
  const drawing = drawLayoutVectorPage(doc.state, doc.state.pages.get(pageId)!, { editableTextBlocks: false });
  expect(drawing.items.filter(item => item.kind === 'text')).toHaveLength(3);
  expect(drawing.items.filter(item => item.kind === 'path')).toHaveLength(3);
  expect(parseDxf(strToU8(writeLayoutDxf(drawing).text)).items.filter(item => item.kind === 'text')).toHaveLength(3);
});

it('carries inch paper settings from the document into SVG export', () => {
  const { commands, doc, drawing } = setup();
  commands.execute('layout.document.setup', { widthMm: 279.4, heightMm: 215.9, units: 'in' });
  const vector = drawing();
  expect(vector.paperUnits).toBe('in');
  const root = new DOMParser().parseFromString(writeLayoutSvg(vector), 'image/svg+xml').documentElement;
  expect(root.getAttribute('width')).toBe('11in');
  expect(root.getAttribute('height')).toBe('8.5in');
  expect(root.querySelector('parsererror')).toBeNull();
  const view = root.getElementsByTagNameNS('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'namedview')[0]!;
  expect(view.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'document-units')).toBe('in');
  expect(doc.state.settings.paperUnits).toBe('in');
});

it('exports a centered initial view in CSS pixels for inch paper', () => {
  const { commands, drawing } = setup();
  commands.execute('layout.document.setup', { widthMm: 279.4, heightMm: 215.9, units: 'in' });
  const root = new DOMParser().parseFromString(writeLayoutSvg(drawing()), 'image/svg+xml').documentElement;
  const view = root.getElementsByTagNameNS('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'namedview')[0]!;
  const attribute = (name: string) => Number(view.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', name));
  expect(attribute('zoom')).toBeCloseTo(700 / (8.5 * 96));
  expect(attribute('cx')).toBe(11 * 96 / 2);
  expect(attribute('cy')).toBe(8.5 * 96 / 2);
  expect(root.getAttribute('viewBox')).toBe('0 0 279.4 215.9');
});

it('uses the exported viewport size for metric and cropped initial views, independent of drawing position', () => {
  const { commands, pageId, drawing } = setup();
  commands.execute('layout.document.setup', { widthMm: 210, heightMm: 297, units: 'mm' });
  const getView = (area: 'page' | 'drawing') => {
    const root = new DOMParser().parseFromString(writeLayoutSvg(drawing(), area), 'image/svg+xml').documentElement;
    const view = root.getElementsByTagNameNS('http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'namedview')[0]!;
    const attribute = (name: string) => Number(view.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', name));
    return { root, zoom: attribute('zoom'), cx: attribute('cx'), cy: attribute('cy') };
  };
  const page = getView('page');
  expect(page.zoom).toBeCloseTo(700 / (297 * 96 / 25.4));
  expect(page.cx).toBeCloseTo(210 * 96 / 25.4 / 2);
  expect(page.cy).toBeCloseTo(297 * 96 / 25.4 / 2);
  commands.execute('layout.shape.add', { pageId, points: [[1000, 2000], [1025.4, 2050.8]] });
  const cropped = getView('drawing');
  const [, , width, height] = cropped.root.getAttribute('viewBox')!.split(' ').map(Number);
  expect(cropped.zoom).toBe(1);
  expect(cropped.cx).toBeCloseTo(width! * 96 / 25.4 / 2);
  expect(cropped.cy).toBeCloseTo(height! * 96 / 25.4 / 2);
  expect(cropped.cx).toBeLessThan(100);
});
