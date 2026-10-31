// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { ExtensionError, methodPermission, validateUiTree, type ExtensionManifest, type UiVector } from '@pushform/extension-protocol';
import { ExtensionUiHost } from './ui';
import { vectorExportServices, vectorPage, vectorPrintServices, vectorToDxf, vectorToSvg, type PrintRequest } from './vector';

/** A 2440 x 1220 mm sheet with two parts, in meters. */
const sheet = (overrides: Record<string, unknown> = {}) => ({
  type: 'vector', id: 'sheet', label: 'Sheet 1', units: 'length',
  bounds: { x: 0, y: 0, width: 2.44, height: 1.22 },
  styles: [{ stroke: '#333333' }, { fill: '#e8d5b0', stroke: '#8a6d3b' }, { hatch: true, stroke: '#999999' }, {}],
  shapes: [
    { kind: 'rect', x: 0, y: 0, width: 2.44, height: 1.22, style: 0 },
    { kind: 'rect', x: 0.01, y: 0.01, width: 0.72, height: 0.4, style: 1, item: 'side', tip: 'Side, 720 x 400' },
    { kind: 'polyline', points: [0.8, 0.01, 1.4, 0.01, 1.4, 0.5], closed: true, style: 1, item: 'gusset' },
    { kind: 'rect', x: 2.0, y: 0.8, width: 0.44, height: 0.42, style: 2 },
    { kind: 'text', x: 0.37, y: 0.21, text: 'Side <A&B>', size: 0.04, anchor: 'middle', angle: 90, style: 3, item: 'side' },
  ],
  selected: ['side'],
  ...overrides,
});

const vector = validateUiTree(sheet()) as UiVector;

describe('SVG export', () => {
  it('writes the drawing in millimeters with escaped text, through the Layout writer', () => {
    const svg = vectorToSvg(vector);
    expect(svg).toContain('width="2440mm" height="1220mm" viewBox="0 0 2440 1220"');
    expect(svg).toContain('<path data-layer="Style 2" d="M10 10 L730 10 L730 410 L10 410 Z" fill="#e8d5b0"');
    expect(svg).toContain('<path data-layer="Style 2" d="M800 10 L1400 10 L1400 500 Z"');
    expect(svg).toContain('Side &lt;A&amp;B&gt;');
    // 90° counterclockwise on screen.
    expect(svg).toContain('transform="matrix(0 -1 1 0 370 210)"');
    // Hatching is a light fill.
    expect(svg).toContain('fill="#e6e6e6"');
    expect(svg).not.toMatch(/<A&B>/);
  });
});

describe('DXF export', () => {
  it('writes a layer per style, filled outlines and rotated text, with y pointing up', () => {
    const dxf = vectorToDxf(vector).split(/\r?\n/);
    expect(dxf).toEqual(expect.arrayContaining(['$INSUNITS', 'Style 1', 'Style 2', 'Style 3', 'HATCH', 'LWPOLYLINE', 'TEXT', 'EOF']));
    // The part's top-left corner, at (10, 10) mm on screen, is (10, 1210) in DXF.
    expect(dxf.join('|')).toMatch(/LWPOLYLINE\|(?:[^|]*\|)*?8\|Style 2\|(?:[^|]*\|)*?70\|1\|10\|10\|20\|1210\|10\|730\|20\|1210/);
    const text = dxf.indexOf('TEXT', dxf.indexOf('ENTITIES'));
    expect(dxf.slice(text, text + 40)).toEqual(expect.arrayContaining(['Side <A&B>', '50', '90']));
  });
});

describe('vector events', () => {
  it('reach the extension only for items the drawing has', () => {
    const sent: unknown[] = [];
    const ui = new ExtensionUiHost({ contributions: [{ target: 'model.panel', id: 'p', name: 'P' }] } as unknown as ExtensionManifest, (e) => sent.push(e));
    ui.services()['ui.mount']!({ target: 'p', seq: 1, tree: sheet() }, {} as never);
    expect(ui.dispatch('p', { component: 'sheet', event: 'hover', item: 'side' })).toBe(true);
    expect(ui.dispatch('p', { component: 'sheet', event: 'select', value: null })).toBe(true);
    expect(ui.dispatch('p', { component: 'sheet', event: 'select', value: 'nothing' })).toBe(false);
    expect(ui.dispatch('p', { component: 'sheet', event: 'press' })).toBe(false);
    expect(sent).toHaveLength(2);
  });
});

describe('ui.export', () => {
  const manifest = { name: 'Cut list', contributions: [{ target: 'model.panel', id: 'com.example.cut.panel', name: 'Cut list' }] } as unknown as ExtensionManifest;

  it('needs file export permission, saves only a vector view on screen, and reports a declined save', async () => {
    expect(methodPermission('ui', 'export')).toBe('file.export');
    const saved: { name: string | undefined; text: string; accept: unknown }[] = [];
    let decline = false;
    const ui = new ExtensionUiHost(manifest, () => {});
    const services = vectorExportServices(manifest, () => ui, {
      open: async () => null,
      save: async (request, data) => {
        if (decline) return null;
        saved.push({ name: request.suggestedName, text: new TextDecoder().decode(data), accept: request.accept });
        return { name: request.suggestedName ?? 'x' };
      },
    });
    const exportIt = (input: unknown) => services['ui.export']!(input, {} as never) as Promise<unknown>;
    await expect(exportIt({ target: 'com.example.cut.panel', component: 'sheet', format: 'svg', purpose: 'Save the diagram' }))
      .rejects.toMatchObject({ code: 'validation.failed' });
    ui.services()['ui.mount']!({ target: 'com.example.cut.panel', seq: 1, tree: { type: 'stack', id: 'root', children: [sheet(), { type: 'button', id: 'b', label: 'B' }] } }, {} as never);
    await expect(exportIt({ target: 'com.example.cut.panel', component: 'b', format: 'svg', purpose: 'Save' })).rejects.toThrow(/not a vector view/);
    expect(await exportIt({ target: 'com.example.cut.panel', component: 'sheet', format: 'dxf', purpose: 'Save the diagram' })).toEqual({ name: 'Sheet 1.dxf' });
    expect(saved[0]).toMatchObject({ name: 'Sheet 1.dxf', accept: [{ extensions: ['dxf'] }] });
    expect(saved[0]!.text).toContain('ENTITIES');
    decline = true;
    const error = await exportIt({ target: 'com.example.cut.panel', component: 'sheet', format: 'svg', purpose: 'Save', suggestedName: 'a.svg' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe('cancelled');
  });
});

describe('ui.print', () => {
  const manifest = { name: 'Cut list', contributions: [{ target: 'model.panel', id: 'p', name: 'P' }] } as unknown as ExtensionManifest;
  const label = (id: string, width: number, height: number) => ({ type: 'vector', id, label: `Labels ${id}`, units: 'length',
    bounds: { x: 0, y: 0, width, height }, styles: [{}], shapes: [{ kind: 'rect', x: 0, y: 0, width, height, style: 0 }] });

  it('centers a drawing that fits at its real size, and scales down one that does not', () => {
    const small = vectorPage(validateUiTree(label('a', 0.1, 0.05)) as UiVector, { width: 210, height: 297 });
    expect(small).toMatchObject({ width: 210, height: 297 });
    expect((small.items[0] as { path: { segments: { point?: number[] }[] } }).path.segments[0]!.point).toEqual([55, 123.5]);
    const large = vectorPage(validateUiTree(label('b', 0.42, 0.297)) as UiVector, { width: 210, height: 297 });
    const corners = (large.items[0] as { path: { segments: { point?: number[] }[] } }).path.segments.map((seg) => seg.point).filter(Boolean);
    expect(corners[0]).toEqual([0, 74.25]);
    expect(corners[2]).toEqual([210, 222.75]);
  });

  it('asks the host printer with one page per view, and reports only the outcome', async () => {
    const requests: PrintRequest[] = [];
    let outcome: 'printed' | 'saved' | null = 'printed';
    const ui = new ExtensionUiHost(manifest, () => {});
    ui.services()['ui.mount']!({ target: 'p', seq: 1, tree: { type: 'stack', id: 'r', children: [label('s1', 0.21, 0.297), label('s2', 0.21, 0.297)] } }, {} as never);
    const print = (input: unknown, printer = { print: async (r: PrintRequest) => { requests.push(r); return outcome; } }) =>
      vectorPrintServices(manifest, () => ui, printer)['ui.print']!(input, {} as never) as Promise<unknown>;
    const input = { target: 'p', components: ['s1', 's2'], page: { width: 0.21, height: 0.297 }, purpose: 'Print part labels' };
    expect(await print(input)).toEqual({ outcome: 'printed' });
    expect(requests[0]).toMatchObject({ extensionName: 'Cut list', purpose: 'Print part labels', title: 'Labels s1', page: { width: 210, height: 297 } });
    expect(requests[0]!.pages).toHaveLength(2);
    outcome = null;
    await expect(print(input)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(print({ ...input, components: ['r'] })).rejects.toThrow(/not a vector view/);
    await expect(print({ ...input, page: { width: 5, height: 1 } })).rejects.toMatchObject({ code: 'validation.failed' });
    await expect(vectorPrintServices(manifest, () => ui, null)['ui.print']!(input, {} as never)).rejects.toMatchObject({ code: 'unavailable' });
    expect(methodPermission('ui', 'print')).toBe('file.export');
  });
});
