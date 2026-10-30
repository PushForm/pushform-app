// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createLayoutDocumentState, layoutDashMm, createLinearDimension, createAngularDimension, formatLinearDimension,
  type LayoutDocumentState, type LayoutEntity, type LayoutLinearDimension, type LayoutText,
} from '@pushform/layout';
import { exportSketchUpLayout } from './sketchupLayoutExport';
import { importSketchUpLayout } from './sketchupLayout';
import { child, childrenNamed, parseXml, type XmlElement } from './xml';
import type { Id } from '@pushform/core';

const NOW = new Date('2026-10-22T12:00:00Z');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')}`;

it('exports native model label fields as their last resolved text and reports the lost live connection', async () => {
  const state = documentState((_state, add) => {
    add({ kind: 'label', closed: false, points: [[20, 20], [80, 30], [10, 10]], text: text('Unit <ComponentInstance> / <PageNumber>', { leader: 'elbow' }),
      modelAnnotation: { status: 'unavailable', fields: { ComponentInstance: 'North window' }, attachments: [{ viewportId: 99,
        modelGuid: 'source-model', source: { referenceId: 7 }, anchor: { kind: 'sketchVertex', path: [], id: 100 as Id } }] } });
  });
  const exported = await exportSketchUpLayout(state);
  expect(exported.warnings).toContain('A native model annotation was exported as paper geometry; its model connection is unavailable in LayOut');
  const reopened = importSketchUpLayout(exported.bytes).doc.state;
  const label = [...reopened.pages.values()].flatMap(page => [...page.entities.values()]).find(entity => entity.kind === 'label')!;
  expect(label.text!.content).toBe('Unit North window / <PageNumber>');
  expect([...state.pages.values()].flatMap(page => [...page.entities.values()]).find(entity => entity.kind === 'label')!.text!.content)
    .toBe('Unit <ComponentInstance> / <PageNumber>');
});

function documentState(build: (state: LayoutDocumentState, add: (entity: Omit<LayoutEntity, 'id' | 'layerId'> & { layerId?: number }) => number) => void): LayoutDocumentState {
  const state = createLayoutDocumentState();
  const page = state.pages.get(state.pageOrder[0]!)!;
  build(state, (entity) => {
    const id = state.meta.nextId++;
    const full = { layerId: state.activeLayerId, ...entity, id } as LayoutEntity;
    if (state.layers.get(full.layerId)?.shared) { state.sharedEntities.set(id, full); state.sharedEntityOrder.push(id); }
    else { page.entities.set(id, full); page.entityOrder.push(id); }
    return id;
  });
  return state;
}

function text(content: string, extra: Partial<LayoutText> = {}): LayoutText {
  return {
    content, fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false,
    align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none', ...extra,
  };
}

async function roundTrip(state: LayoutDocumentState) {
  const exported = await exportSketchUpLayout(state, { now: NOW });
  return { exported, imported: importSketchUpLayout(exported.bytes, 'Export.layout'), files: unzipSync(exported.bytes) };
}

function xml(files: Record<string, Uint8Array>, name: string): XmlElement {
  return parseXml(strFromU8(files[name]!), { 'http://sketchup.google.com/schemas/layout/1.0/references': 'r', 'http://sketchup.google.com/schemas/layout/1.0/layout': 'l' });
}

function pageEntities(files: Record<string, Uint8Array>, index = 1): XmlElement[] {
  return child(child(xml(files, `pages/page${index}.xml`), 'layerEntityManager')!, 'entityList')!.children;
}

function close(a: [number, number][], b: [number, number][]): void {
  expect(a).toHaveLength(b.length);
  a.forEach((point, i) => { expect(point[0]).toBeCloseTo(b[i]![0], 4); expect(point[1]).toBeCloseTo(b[i]![1], 4); });
}

describe('SketchUp LayOut export', () => {
  it('leaves hidden objects out of the exported file', async () => {
    const state = documentState((_, add) => {
      add({ kind: 'path', points: [[0, 0], [10, 0]], closed: false });
      add({ kind: 'path', points: [[0, 5], [10, 5]], closed: false, hidden: true });
    });
    const { files } = await roundTrip(state);
    expect(pageEntities(files)).toHaveLength(1);
  });

  it('writes the parts LayOut expects with consistent cross-references', async () => {
    const { files } = await roundTrip(createLayoutDocumentState());
    expect(Object.keys(files).sort()).toEqual(['doc_thumbnail.png', 'document.xml', 'documentProperties.xml', 'pages/page1.xml', 'references.xml', 'styleManager.xml']);
    const references = xml(files, 'references.xml');
    const pageRef = childrenNamed(references, 'pageFileReference')[0]!;
    expect(pageRef.attrs.internalTarget).toBe('pages/page1.xml');
    const document = xml(files, 'document.xml');
    const ref = childrenNamed(child(document, 'pageManager')!, 'pageRef')[0]!;
    expect(ref.attrs['r:id']).toBe(pageRef.attrs['r:id']);
    expect(xml(files, 'pages/page1.xml').attrs.id).toBe(ref.attrs.id);
    // Ids are unique across parts (a page's root repeats its pageRef id) and below the recorded nextId.
    const pageIds = [...strFromU8(files['pages/page1.xml']!).matchAll(/ id="id(\d+)"/g)].map((m) => Number(m[1])).slice(1);
    const ids = [...strFromU8(files['document.xml']!).matchAll(/ id="id(\d+)"/g)].map((m) => Number(m[1])).concat(pageIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeLessThan(Number(references.attrs.nextId!.slice(2)));
    expect([...files['doc_thumbnail.png']!.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });

  it('keeps pages, paper, and layers with their visibility, lock, sharing, and order', async () => {
    const state = documentState((s, add) => {
      const page = s.pages.get(s.pageOrder[0]!)!;
      page.name = 'Plan & Notes';
      page.size = [420, 297];
      page.margin = { top: 5, right: 6, bottom: 7, left: 8 };
      s.pages.set(90, { ...page, id: 90, name: 'Details', entities: new Map(), entityOrder: [] });
      s.pageOrder.push(90);
      s.layers.set(91, { id: 91, name: 'Notes', visible: false, locked: true, shared: false });
      s.layers.set(92, { id: 92, name: 'Title Block', visible: true, locked: false, shared: true });
      s.layerOrder.push(91, 92);
      add({ kind: 'path', layerId: 92, points: [[10, 10], [50, 10]], closed: false, style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null } });
    });
    const { imported: { doc }, exported } = await roundTrip(state);
    expect(exported.warnings).toEqual([]);
    const out = doc.state;
    expect(out.pageOrder.map((id) => out.pages.get(id)!.name)).toEqual(['Plan & Notes', 'Details']);
    const page = out.pages.get(out.pageOrder[0]!)!;
    expect(page.size[0]).toBeCloseTo(420, 4);
    expect(page.size[1]).toBeCloseTo(297, 4);
    expect(page.margin.left).toBeCloseTo(8, 4);
    expect(page.margin.bottom).toBeCloseTo(7, 4);
    expect(out.layerOrder.map((id) => out.layers.get(id)).map((l) => [l!.name, l!.visible, l!.locked, l!.shared]))
      .toEqual([['Layer 1', true, false, false], ['Notes', false, true, false], ['Title Block', true, false, true]]);
    expect([...out.sharedEntities.values()]).toHaveLength(1);
    expect(page.entities.size).toBe(0);
  });

  it('reports pages whose paper differs from the first page', async () => {
    const state = createLayoutDocumentState();
    const page = state.pages.get(state.pageOrder[0]!)!;
    state.pages.set(90, { ...page, id: 90, size: [210, 297], entities: new Map(), entityOrder: [] });
    state.pageOrder.push(90);
    const { exported } = await roundTrip(state);
    expect(exported.warnings.join()).toMatch(/one paper size/);
  });

  it('keeps path geometry, curves, closure, fill, stroke color, alpha, and weight', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'path', points: [[10, 10], [60, 10], [60, 40]], closed: false, style: { strokeColor: '#ff0000', strokeWeightPt: 2, fillColor: null } });
      add({ kind: 'path', points: [[100, 10], [150, 10], [125, 50]], closed: true, style: { strokeColor: '#80808080', strokeWeightPt: 0.1, fillColor: '#00ff00' } });
      add({ kind: 'path', points: [[10, 100], [60, 100]], handles: [{ out: [20, 80] }, { in: [50, 80] }], closed: false, style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null } });
      add({ kind: 'path', points: [[200, 10], [240, 10], [240, 40]], closed: true, style: { strokeColor: '#00000000', strokeWeightPt: 1, fillColor: '#0000ff' } });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const raw = pageEntities(files).map((e) => child(e, 'graphicEntity')!.attrs);
    expect(raw[0]).toMatchObject({ shouldFill: '0', strokeColor: String(0xff0000ff), strokeWidth: '2' });
    expect(raw[1]).toMatchObject({ fillColor: String(0xff00ff00), strokeColor: String(0x80808080), strokeWidth: '0' });
    expect(raw[3]).toMatchObject({ shouldStroke: '0', fillColor: String(0xffff0000) });
    expect(child(pageEntities(files)[1]!, 'elements')!.text).toBe('0,1,1,1,3');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [open, closed, curve, unstroked] = page.entityOrder.map((id) => page.entities.get(id)!);
    close(open!.points, [[10, 10], [60, 10], [60, 40]]);
    expect(open!.style).toEqual({ strokeColor: '#ff0000', strokeWeightPt: 2, fillColor: null });
    close(closed!.points, [[100, 10], [150, 10], [125, 50]]);
    expect(closed!.closed).toBe(true);
    expect(closed!.style).toEqual({ strokeColor: '#80808080', strokeWeightPt: 0.1, fillColor: '#00ff00' });
    close([curve!.handles![0]!.out!, curve!.handles![1]!.in!], [[20, 80], [50, 80]]);
    expect(unstroked!.style?.fillColor).toBe('#0000ff');
    expect(unstroked!.style?.strokeColor).toBe('#00000000');
  });

  it('writes a compound path as one path with a subpath per contour, leaving open contours unclosed', async () => {
    const points: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10], [30, 30], [10, 30], [50, 0], [60, 10]];
    const state = documentState((_s, add) => {
      add({ kind: 'path', points, contourStarts: [0, 4, 8], openContours: [2], closed: true,
        style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: '#ff0000' } });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    expect(child(pageEntities(files)[0]!, 'elements')!.text).toBe('0,1,1,1,1,3,0,1,1,1,1,3,0,1');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    expect(page.entityOrder).toHaveLength(1);
    const path = page.entities.get(page.entityOrder[0]!)!;
    expect(path.contourStarts).toEqual([0, 4, 8]); expect(path.openContours).toEqual([2]);
    close(path.points, points);
  });

  it('writes LayOut stroke patterns and scales, and the nearest pattern for other dashes', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'path', points: [[10, 10], [60, 10]], closed: false, style: { strokeColor: '#000000', strokeWeightPt: 2, fillColor: null, strokeDashMm: layoutDashMm(3, 2, 1.5) } });
      add({ kind: 'path', points: [[10, 20], [60, 20]], closed: false, style: { strokeColor: '#000000', strokeWeightPt: 0.5, fillColor: null, strokeDashMm: layoutDashMm(8, 0.5) } });
      add({ kind: 'path', points: [[10, 30], [60, 30]], closed: false, style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null, strokeDashMm: [3, 1] } });
    });
    const { exported, imported: { doc }, files } = await roundTrip(state);
    const raw = pageEntities(files).map((e) => child(e, 'graphicEntity')!.attrs);
    expect(raw[0]).toMatchObject({ strokeDashPattern: '3', 'stroke.patternscale': '1.5' });
    expect(raw[1]).toMatchObject({ strokeDashPattern: '8' });
    expect(raw[1]!['stroke.patternscale']).toBeUndefined();
    expect(raw[2]).toMatchObject({ strokeDashPattern: '1' });
    expect(exported.warnings).toEqual(['dash patterns LayOut does not have were exported as the nearest LayOut pattern']);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [dashDot, dashDashDot, nearest] = page.entityOrder.map((id) => page.entities.get(id)!.style!.strokeDashMm!);
    for (const [actual, expected] of [[dashDot!, layoutDashMm(3, 2, 1.5)], [dashDashDot!, layoutDashMm(8, 0.5)]] as const) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach((length, i) => expect(length).toBeCloseTo(expected[i]!, 5));
    }
    expect(nearest!.reduce((sum, n) => sum + n, 0)).toBeCloseTo(4, 3);
  });

  it('keeps text content, runs, font, size, color, alignment, anchoring, wrapping, and rotation', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'text', points: [[20, 20], [80, 30]], closed: false,
        text: text('Bold italic {red} \\ Ü', { fontFamily: 'Times New Roman', fontSizePt: 12, color: '#336699', align: 'center', vertical: 'middle', bounded: true,
          spans: [{ start: 0, end: 4, bold: true, italic: false, underline: false }, { start: 5, end: 11, bold: false, italic: true, underline: true }] }) });
      add({ kind: 'text', points: [[100, 100], [140, 110]], closed: false, text: text('Line one\nLine two', { align: 'right', vertical: 'bottom', rotationDeg: 90 }) });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const [boxed, rotated] = pageEntities(files);
    expect(boxed!.attrs).toMatchObject({ anchorType: '48', growMode: '1' });
    expect(rotated!.attrs).toMatchObject({ anchorType: '10', growMode: '0' });
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [a, b] = page.entityOrder.map((id) => page.entities.get(id)!);
    expect(a!.text).toMatchObject({ content: 'Bold italic {red} \\ Ü', fontFamily: 'Times New Roman', fontSizePt: 12, color: '#336699',
      align: 'center', vertical: 'middle', bounded: true, bold: true });
    expect(a!.text!.spans).toEqual([
      { start: 0, end: 4, bold: true, italic: false, underline: false },
      { start: 4, end: 5, bold: false, italic: false, underline: false },
      { start: 5, end: 11, bold: false, italic: true, underline: true },
      { start: 11, end: 21, bold: false, italic: false, underline: false },
    ]);
    close(a!.points, [[20, 20], [80, 30]]);
    expect(b!.text).toMatchObject({ content: 'Line one\nLine two', align: 'right', vertical: 'bottom', bounded: false, rotationDeg: 90 });
    close(b!.points, [[100, 100], [140, 110]]);
  });

  it('writes line arrows as LayOut arrow styles that re-import the same', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'path', points: [[10, 10], [60, 10]], closed: false,
        style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null,
          startArrow: { type: 'open-skinny-triangle', sizePt: 6 }, endArrow: { type: 'slash-left', sizePt: 3 } } });
      add({ kind: 'path', points: [[10, 30], [60, 30]], closed: false,
        style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null, endArrow: { type: 'filled-diamond', sizePt: 9 } } });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const arrowData = pageEntities(files).map((entity) => entity.children.find((child) => child.name.endsWith('arrowData'))?.attrs);
    expect(arrowData[0]).toMatchObject({ startArrowType: '18', startArrowSize: '6', endArrowType: '14', endArrowSize: '3' });
    expect(arrowData[1]).toMatchObject({ startArrowType: '0', endArrowType: '9', endArrowSize: '9' });
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [a, b] = page.entityOrder.map((id) => page.entities.get(id)!);
    expect(a!.style).toMatchObject({ startArrow: { type: 'open-skinny-triangle', sizePt: 6 }, endArrow: { type: 'slash-left', sizePt: 3 } });
    expect(b!.style?.startArrow).toBeUndefined();
    expect(b!.style?.endArrow).toEqual({ type: 'filled-diamond', sizePt: 9 });
    close(a!.points, [[10, 10], [60, 10]]);
  });

  it('keeps line spacing and per-run sizes through LayOut', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'text', points: [[20, 20], [80, 40]], closed: false, text: text('Title\nsmall print', { fontSizePt: 18, bounded: true,
        lineSpacing: { mode: 'multiple', value: 0.8 }, spans: [{ start: 6, end: 17, bold: false, italic: false, underline: false, fontSizePt: 7 }] }) });
      add({ kind: 'text', points: [[20, 50], [80, 70]], closed: false, text: text('Fixed\nlines', { lineSpacing: { mode: 'exactly', value: 14 } }) });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const rtf = pageEntities(files).map((entity) => entity.children.find((child) => child.name.endsWith('rtfTextRep'))?.text ?? '');
    expect(rtf[0]).toContain('\\sl192\\slmult1');
    expect(rtf[1]).toContain('\\sl-280\\slmult0');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [a, b] = page.entityOrder.map((id) => page.entities.get(id)!.text!);
    expect(a).toMatchObject({ content: 'Title\nsmall print', fontSizePt: 18, lineSpacing: { mode: 'multiple', value: 0.8 } });
    expect(a!.spans?.find((span) => span.start === 5 || span.start === 6)).toMatchObject({ fontSizePt: 7 });
    expect(b!.lineSpacing).toEqual({ mode: 'exactly', value: 14 });
  });

  it('keeps a two-column key\'s tabs and tab stops through LayOut', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'text', points: [[20, 20], [80, 40]], closed: false, text: text('WM\t\tWashing Machine\nTD\t\tTumble Dryer',
        { bounded: true, tabStopsPt: [28, 56, 84] }) });
      add({ kind: 'text', points: [[20, 50], [80, 70]], closed: false, text: text('a\tb') });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const rtf = pageEntities(files).map((entity) => entity.children.find((child) => child.name.endsWith('rtfTextRep'))?.text ?? '');
    expect(rtf[0]).toContain('\\tx560\\tx1120\\tx1680');
    expect(rtf[1]).not.toContain('\\tx');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [a, b] = page.entityOrder.map((id) => page.entities.get(id)!.text!);
    expect(a).toMatchObject({ content: 'WM\t\tWashing Machine\nTD\t\tTumble Dryer', tabStopsPt: [28, 56, 84] });
    expect(b).toMatchObject({ content: 'a\tb' });
    expect(b!.tabStopsPt).toBeUndefined();
  });

  it('writes bulleted and numbered lists as LayOut list paragraphs', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'text', points: [[10, 10], [90, 30]], closed: false, text: text('First\nSecond', { list: 'bullet', bounded: true }) });
      add({ kind: 'text', points: [[10, 50], [90, 70]], closed: false, text: text('One\nTwo\nThree', { list: 'number', bounded: true, fontFamily: 'Verdana' }) });
    });
    const { exported, imported: { doc }, files } = await roundTrip(state);
    expect(exported.warnings).toEqual([]);
    const xmlText = strFromU8(files['pages/page1.xml']!);
    expect(xmlText).toContain("{\\pntext\\f1\\'B7\\tab}{\\*\\pn\\pnlvlblt\\pnf1");
    expect(xmlText).toContain('{\\f1\\fnil\\fcharset2 Symbol;}');
    expect(xmlText).toContain('{\\pntext\\f0 3.\\tab}');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [bullets, numbers] = page.entityOrder.map((id) => page.entities.get(id)!.text!);
    expect(bullets).toMatchObject({ content: 'First\nSecond', list: 'bullet', fontFamily: 'Arial' });
    expect(numbers).toMatchObject({ content: 'One\nTwo\nThree', list: 'number', fontFamily: 'Verdana' });
  });

  it('turns page fields into LayOut auto-text and custom fields into custom auto-text', async () => {
    const state = documentState((s, add) => {
      s.customFields.set('Sheet', 'A-101');
      s.customFields.set('Company', 'Acme');
      add({ kind: 'text', points: [[10, 10], [90, 20]], closed: false,
        text: text('<PageNumber>/<PageCount> <PageName> <Sheet> <Company> <CurrentDate> <FileName>') });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    expect(strFromU8(files['pages/page1.xml']!)).toContain('&lt;PageNumber&gt;/&lt;PageCount&gt; &lt;PageName&gt; &lt;Sheet&gt; &lt;Company&gt;');
    const definitions = child(child(xml(files, 'document.xml'), 'autoTextManager')!, 'entityList')!.children;
    expect(definitions.find((d) => d.attrs.name === 'Sheet')!.attrs).toMatchObject({ type: '3', textValue: 'A-101' });
    expect(definitions.find((d) => d.attrs.name === 'Company')!.attrs).toMatchObject({ type: '3', textValue: 'Acme' });
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    expect(page.entities.get(page.entityOrder[0]!)!.text!.content)
      .toBe('<PageNumber>/<PageCount> <PageName> <Sheet> <Company> <CurrentDate> <FileName>');
    expect(doc.state.customFields.get('Sheet')).toBe('A-101');
  });

  it('writes page-number fields as LayOut page-number auto-text with their start page and style', async () => {
    let second = 0;
    const state = documentState((s, add) => {
      const first = s.pages.get(s.pageOrder[0]!)!;
      second = s.meta.nextId++;
      s.pages.set(second, { ...first, id: second, name: 'Sheet', entities: new Map(), entityOrder: [] });
      s.pageOrder.push(second);
      s.pageNumberFields = new Map([
        ['PageNumber', { startPageId: second, startNumber: 1, style: 'two-digit' as const }],
        ['Folio', { startPageId: null, startNumber: 4, style: 'lower-roman' as const }],
      ]);
      add({ kind: 'text', points: [[10, 10], [90, 20]], closed: false, text: text('<PageNumber> <Folio>') });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const definitions = child(child(xml(files, 'document.xml'), 'autoTextManager')!, 'entityList')!.children;
    const pageRefs = child(xml(files, 'document.xml'), 'pageManager')!.children.map((ref) => ref.attrs['r:id']);
    expect(definitions.find((d) => d.attrs.name === 'PageNumber')!.attrs).toMatchObject({ type: '2', 'l:ref': pageRefs[1], numberingType: '1', startNumber: '1' });
    expect(definitions.find((d) => d.attrs.name === 'Folio')!.attrs).toMatchObject({ type: '2', 'l:ref': pageRefs[0], numberingType: '5', startNumber: '4' });
    expect(strFromU8(files['pages/page1.xml']!)).toContain('&lt;PageNumber&gt; &lt;Folio&gt;');
    // Reading the export back gives the same fields.
    expect([...doc.state.pageNumberFields!]).toEqual([
      ['PageNumber', { startPageId: doc.state.pageOrder[1], startNumber: 1, style: 'two-digit' }],
      ['Folio', { startPageId: null, startNumber: 4, style: 'lower-roman' }],
    ]);
  });

  it('places PNG pictures with their frame and crop, sharing one file per picture', async () => {
    const clip = { points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]] as [number, number][] };
    const state = documentState((_s, add) => {
      add({ kind: 'image', points: [[10, 10], [60, 10], [60, 40], [10, 40]], closed: true, image: { src: PNG } });
      add({ kind: 'image', points: [[100, 10], [150, 10], [150, 40], [100, 40]], closed: true, image: { src: PNG, clip } });
      add({ kind: 'image', points: [[200, 10], [200, 60], [170, 60], [170, 10]], closed: true, image: { src: PNG } });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    expect(Object.keys(files).filter((name) => name.startsWith('ref/'))).toHaveLength(1);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [plain, cropped, rotated] = page.entityOrder.map((id) => page.entities.get(id)!);
    close(plain!.points, [[10, 10], [60, 10], [60, 40], [10, 40]]);
    expect(plain!.image!.src.startsWith('data:image/png;base64,')).toBe(true);
    close(cropped!.image!.clip!.points, clip.points);
    close(rotated!.points, [[200, 10], [200, 60], [170, 60], [170, 10]]);
  });

  it('converts other pictures through the rasterizer, or skips them with a warning', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'image', points: [[10, 10], [35.4, 10], [35.4, 35.4], [10, 35.4]], closed: true, image: { src: SVG } });
    });
    const skipped = await exportSketchUpLayout(state, { now: NOW });
    expect(skipped.warnings.join()).toMatch(/cannot place/);
    expect(Object.keys(unzipSync(skipped.bytes)).some((name) => name.startsWith('ref/'))).toBe(false);
    const sizes: [number, number][] = [];
    const converted = await exportSketchUpLayout(state, { now: NOW, rasterize: async (_src, w, h) => {
      sizes.push([w, h]);
      return Uint8Array.from(atob(PNG.split(',')[1]!), (c) => c.charCodeAt(0));
    } });
    expect(sizes).toEqual([[300, 300]]);
    expect(Object.keys(unzipSync(converted.bytes)).filter((name) => name.endsWith('.png') && name.startsWith('ref/'))).toHaveLength(1);
    expect(converted.warnings.join()).toMatch(/converted to PNG/);
  });

  it('writes drawing scale, feet-and-inch formats, precision, and dashes that read back the same', async () => {
    const base = { ...createLinearDimension(), cachedValueMm: 25.4 };
    const styles: Partial<LayoutLinearDimension>[] = [
      { format: 'architectural', units: 'inch', precision: 4, scale: 1 / 48, showDashes: false },
      { format: 'fractional', units: 'inch', precision: 6, showUnits: false },
      { format: 'engineering', units: 'ft', precision: 3, scale: 1 / 96 },
      { units: 'pt', precision: 1 }, { units: 'ft', precision: 2, scale: 1 / 12 }, { units: 'mm', precision: 0, scale: 0.02 },
    ];
    const state = documentState((_s, add) => styles.forEach((style, index) =>
      add({ kind: 'dimension', points: [[10, 20 + index * 20], [35.4, 20 + index * 20], [20, 15 + index * 20]], closed: false, dimension: { ...base, ...style } })));
    const { exported, imported: { doc, warnings }, files } = await roundTrip(state);
    expect(exported.warnings).toEqual([]);
    expect(warnings).toEqual([]);
    const xml = strFromU8(files['pages/page1.xml']!);
    // Codes as LayOut 2027 saved them for each Ruby API unit; the scale keeps full precision.
    for (const units of ['format="1" unit="0" precision="4"', 'format="3" unit="0" precision="6" suppressUnitDisplay="1"',
      'format="2" unit="1" precision="3"', 'format="0" unit="5" precision="1"', 'format="0" unit="1" precision="2"']) expect(xml).toContain(units);
    expect(xml).toContain('suppressDashesDisplay="1"');
    expect(xml).toContain(`autoScale="0" scale="${1 / 48}"`);
    expect(xml.match(/autoScale="1" scale="1"/g)).toHaveLength(2);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const dims = page.entityOrder.map((id) => page.entities.get(id)!.dimension!);
    expect(dims.map(formatLinearDimension)).toEqual([`4' 0"`, '1', `8'`, '72.0 pt', `1.00'`, '1270 mm']);
    styles.forEach((style, index) => expect(dims[index]).toMatchObject(style));
  });

  it('writes a rotated dimension that re-imports with the same angle and value', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'dimension', points: [[20, 20], [80, 50], [20, 0]], closed: false,
        dimension: { ...createLinearDimension(), alignment: 'rotated', angleDeg: 20, cachedValueMm: 0 } });
    });
    const { imported: { doc, warnings } } = await roundTrip(state);
    expect(warnings).toEqual([]);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const dim = page.entities.get(page.entityOrder[0]!)!.dimension!;
    expect(dim.alignment).toBe('rotated');
    expect(dim.angleDeg).toBeCloseTo(20, 3);
    const u = [Math.cos(20 * Math.PI / 180), Math.sin(20 * Math.PI / 180)];
    expect(dim.cachedValueMm).toBeCloseTo(60 * u[0]! + 30 * u[1]!, 3);
  });

  it('writes native LayOut dimensions and labels that round-trip to the same annotations', async () => {
    const linear = { ...createLinearDimension(), units: 'cm' as const, precision: 2, showUnits: false, text: 'W = <>', endpoint: 'tick' as const, cachedValueMm: 100 };
    const state = documentState((_s, add) => {
      add({ kind: 'dimension', points: [[10, 50], [110, 50], [60, 40]], closed: false, dimension: linear });
      add({ kind: 'dimension', points: [[50, 50], [150, 150], [30, 100]], closed: false,
        dimension: { ...createLinearDimension(), alignment: 'vertical', endpoint: 'dot', cachedValueMm: 100 }, style: { strokeColor: '#c00000', strokeWeightPt: 1, fillColor: null } });
      add({ kind: 'angular-dimension', points: [[200, 100], [250, 100], [200, 50], [230, 80]], closed: false,
        angularDimension: { ...createAngularDimension(), reflex: true, cachedAngleDeg: 270 } });
      add({ kind: 'label', points: [[150, 150], [190, 160], [120, 130], [140, 155]], closed: false,
        text: text('Note', { leader: 'elbow', endpoint: 'arrow', vertical: 'middle', bounded: true }) });
      add({ kind: 'label', points: [[150, 200], [190, 210], [120, 180]], closed: false,
        text: text('Dot', { leader: 'straight', endpoint: 'dot', vertical: 'middle', bounded: true }) });
    });
    const { exported, imported: { doc, warnings }, files } = await roundTrip(state);
    expect(exported.warnings).toEqual([]);
    expect(warnings).toEqual([]);
    expect(pageEntities(files).map((e) => e.name)).toEqual(['linearDimension', 'linearDimension', 'angularDimension', 'label', 'label']);
    // LayOut keeps the template as the text body, which makes the measurement live rather than custom text.
    expect(strFromU8(files['pages/page1.xml']!)).toContain('\\fs20 W = &lt;&gt;\\par');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [first, second, angular, elbow, straight] = page.entityOrder.map((id) => page.entities.get(id)!);
    expect(first!.kind).toBe('dimension');
    close(first!.points, [[10, 50], [110, 50], [60, 40]]);
    expect(first!.dimension).toMatchObject({ alignment: 'aligned', units: 'cm', precision: 2, showUnits: false, text: 'W = <>', endpoint: 'tick', fontSizePt: 10 });
    // Files hold inches to six decimals, so values come back within a few ten-thousandths of a millimeter.
    expect(first!.dimension!.cachedValueMm).toBeCloseTo(100, 4);
    expect(first!.dimension!.arrowSizeMm).toBeCloseTo(linear.arrowSizeMm, 4);
    expect(first!.dimension!.extensionGapMm).toBeCloseTo(linear.extensionGapMm, 4);
    expect(first!.dimension!.extensionOverrunMm).toBeCloseTo(linear.extensionOverrunMm, 4);
    expect(second!.dimension).toMatchObject({ alignment: 'vertical', endpoint: 'dot' });
    expect(second!.style).toEqual({ strokeColor: '#c00000', strokeWeightPt: 1, fillColor: null });
    expect(angular!.kind).toBe('angular-dimension');
    close(angular!.points.slice(0, 3), [[200, 100], [250, 100], [200, 50]]);
    expect(angular!.angularDimension).toMatchObject({ reflex: true, units: 'degrees' });
    expect(angular!.angularDimension!.cachedAngleDeg).toBeCloseTo(270, 4);
    expect(elbow!.kind).toBe('label');
    expect(elbow!.text).toMatchObject({ content: 'Note', leader: 'elbow', endpoint: 'arrow' });
    close(elbow!.points, [[150, 150], [190, 160], [120, 130], [140, 155]]);
    expect(straight!.text).toMatchObject({ content: 'Dot', leader: 'straight', endpoint: 'dot' });
    close(straight!.points, [[150, 200], [190, 210], [120, 180]]);
  });

  it('writes dimension ends and label tips attached to path vertices as LayOut connections', async () => {
    let poly = 0, square = 0;
    const state = documentState((_s, add) => {
      poly = add({ kind: 'path', points: [[10, 10], [60, 10], [60, 40]], closed: false });
      square = add({ kind: 'path', points: [[80, 10], [120, 10], [120, 30], [80, 30]], closed: true });
      add({ kind: 'dimension', points: [[10, 10], [60, 10], [35, 0]], closed: false,
        dimension: { ...createLinearDimension(), cachedValueMm: 50, anchors: [{ entityId: poly, pointIndex: 0, pointCount: 3 }, { entityId: poly, pointIndex: 1, pointCount: 3 }] } });
      add({ kind: 'dimension', points: [[120, 30], [140, 30], [130, 40]], closed: false,
        dimension: { ...createLinearDimension(), cachedValueMm: 20, anchors: [{ entityId: square, pointIndex: 2, pointCount: 4 }, null] } });
      add({ kind: 'label', points: [[80, 60], [100, 66], [60, 40], [70, 63]], closed: false,
        labelAnchor: { entityId: poly, pointIndex: 2, pointCount: 3 }, text: text('Tip', { leader: 'elbow', endpoint: 'arrow', vertical: 'middle', bounded: false }) });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const document = strFromU8(files['document.xml']!);
    // LayOut keeps connections in the document: the vertex by index and position, then the dimension end or label.
    const connections = [...document.matchAll(/<n0:connection>([\s\S]*?)<\/n0:connection>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
    expect(connections).toHaveLength(4);
    expect(connections[0]).toMatch(/type="1" x="0\.393701" y="0\.393701" dirx="0" diry="0" param1="0" param2="0" l:ref="id\d+"\/> <n0:dimensionConnectionPoint l:ref="id\d+" componentId="5"\/>/);
    expect(connections[2]).toMatch(/param1="2" .*componentId="5"/);
    expect(connections[3]).toMatch(/param1="2" .*<n0:labelConnectionPoint l:ref="id\d+" componentIndex="4294967295"\/>/);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = page.entityOrder.map((id) => page.entities.get(id)!);
    const [line, rect] = all.filter((entity) => entity.kind === 'path');
    const dims = all.filter((entity) => entity.kind === 'dimension');
    expect(dims.map((entity) => entity.dimension!.anchors)).toEqual([
      [{ entityId: line!.id, pointIndex: 0, pointCount: 3 }, { entityId: line!.id, pointIndex: 1, pointCount: 3 }],
      [{ entityId: rect!.id, pointIndex: 2, pointCount: 4 }, null],
    ]);
    expect(all.find((entity) => entity.kind === 'label')!.labelAnchor).toEqual({ entityId: line!.id, pointIndex: 2, pointCount: 3 });
  });

  it('writes ends and tips attached along a straight or curved segment as LayOut connections, and reads them back', async () => {
    let poly = 0, arc = 0;
    const state = documentState((_s, add) => {
      poly = add({ kind: 'path', points: [[10, 10], [60, 10], [60, 40]], closed: false });
      // One cubic from (100, 10) to (160, 10), bulging down the page.
      arc = add({ kind: 'path', points: [[100, 10], [160, 10]], closed: false, handles: [{ out: [110, 40] }, { in: [150, 40] }] });
      add({ kind: 'dimension', points: [[20, 10], [60, 25], [40, 0]], closed: false,
        dimension: { ...createLinearDimension(), cachedValueMm: 42.7, anchors: [{ entityId: poly, pointIndex: 0, pointCount: 3, t: 0.2 }, { entityId: poly, pointIndex: 1, pointCount: 3, t: 0.5 }] } });
      add({ kind: 'label', points: [[180, 60], [200, 66], [130, 32.5], [190, 63]], closed: false,
        labelAnchor: { entityId: arc, pointIndex: 0, pointCount: 2, t: 0.5 }, text: text('Arc', { leader: 'straight', endpoint: 'arrow', vertical: 'middle', bounded: false }) });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    const document = strFromU8(files['document.xml']!);
    const connections = [...document.matchAll(/<n0:connection>([\s\S]*?)<\/n0:connection>/g)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
    expect(connections).toHaveLength(3);
    // Along a straight segment: type 8, the segment's index plus the fraction, and its direction.
    expect(connections[0]).toMatch(/type="8" x="0\.787402" y="0\.393701" dirx="1" diry="0" param1="0\.2" param2="0"/);
    expect(connections[1]).toMatch(/type="8" x="2\.362205" y="0\.984252" dirx="0" diry="1" param1="1\.5"/);
    // Along a cubic: type 4 and the curve parameter, with the tangent there.
    expect(connections[2]).toMatch(/type="4" x="5\.11811" y="1\.279528" dirx="1" diry="0" param1="0\.5" .*labelConnectionPoint/);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = page.entityOrder.map((id) => page.entities.get(id)!);
    const [line, curve] = all.filter((entity) => entity.kind === 'path');
    const [start, end] = all.find((entity) => entity.kind === 'dimension')!.dimension!.anchors;
    expect(start).toMatchObject({ entityId: line!.id, pointIndex: 0, pointCount: 3 });
    expect(start!.t).toBeCloseTo(0.2, 6);
    expect(end).toMatchObject({ entityId: line!.id, pointIndex: 1, pointCount: 3 });
    expect(end!.t).toBeCloseTo(0.5, 6);
    const tip = all.find((entity) => entity.kind === 'label')!.labelAnchor!;
    expect(tip).toMatchObject({ entityId: curve!.id, pointIndex: 0, pointCount: 2 });
    expect(tip.t).toBeCloseTo(0.5, 5);
  });

  it('keeps a label leader meeting the text off its center as a last-line connection', async () => {
    const state = documentState((_s, add) => {
      add({ kind: 'label', points: [[150, 250], [190, 262], [120, 230], [140, 259]], closed: false,
        text: text('Two\nlines', { leader: 'elbow', endpoint: 'arrow', vertical: 'bottom', bounded: false, leaderOffsetMm: 3 }) });
    });
    const { imported: { doc }, files } = await roundTrip(state);
    expect(strFromU8(files['pages/page1.xml']!)).toContain('connectionType="5"');
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const label = page.entities.get(page.entityOrder[0]!)!;
    close(label.points, [[150, 250], [190, 262], [120, 230], [140, 259]]);
    expect(label.text!.leaderOffsetMm).toBeCloseTo(3, 4);
  });
});
