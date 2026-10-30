// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeLayoutDocument, encodeLayoutDocument } from './layoutFile';
import { importSketchUpLayout, installSketchUpLayout, isSketchUpLayoutFile, prepareSketchUpLayout } from './sketchupLayout';
import { parseXml } from './xml';
import { decodePng, encodePng } from './png';
import { readOriginalLayoutArchive, readPreservedSketchUpModel } from './layoutModelArchive';
import { exportSketchUpLayout } from './sketchupLayoutExport';
import { layoutModelFields, entitiesForLayer, layoutLabelLeader, layoutPathArrows, refreshLayoutDimensions, formatLinearDimension, isLayoutLayerVisible, tableCellEntities, tableCells, resolveLayoutDimension, resolveLayoutLabelAnchor, resolveLayoutText } from '@pushform/layout';

const NS = 'xmlns:l="http://sketchup.google.com/schemas/layout/1.0/layout" xmlns:ld="http://sketchup.google.com/schemas/layout/1.0/layoutdocument" xmlns:r="http://sketchup.google.com/schemas/layout/1.0/references" xmlns:e="http://sketchup.google.com/schemas/layout/1.0/entities"';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function layoutFile(page: string, master = '', visibility = '1,1,1', masterIds = ['id90'], autoText = '', extra: Record<string, Uint8Array> = {}): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<layoutDocument xmlns="http://sketchup.google.com/schemas/layout/1.0/layoutdocument" ${NS} xmlns:n0="http://sketchup.google.com/schemas/layout/1.0/page">
  <ld:pageInfo width="11" height="8.5" leftMargin="0.5" rightMargin="0.5" topMargin="0.25" bottomMargin="0.25" paperColor="4294967295" />
  <ld:unitsInfo unit="2" />
  <ld:layerManager>
    <ld:layerDefinition ver="2" id="id10" name="Base" visible="1" locked="0" shared="0" />
    <ld:layerDefinition ver="2" id="id11" name="Notes" visible="1" locked="1" shared="0" />
    <ld:layerDefinition ver="2" id="id12" name="Title" visible="1" locked="0" shared="1" />
    <ld:currentLayerDefinition ver="2" l:ref="id11" />
  </ld:layerManager>
  <n0:layerEntityManager>
    <n0:entityList>${master}</n0:entityList>
    <n0:layerInstanceManager>
      <ld:layerInstance><ld:layerDefinition l:ref="id12" /><ld:entityList>${master ? masterIds.map(id => `<e:entity l:ref="${id}" />`).join('') : ''}</ld:entityList></ld:layerInstance>
    </n0:layerInstanceManager>
  </n0:layerEntityManager>
  <ld:pageManager>
    <ld:pageRef r:id="id1" name="Plan &amp; Notes"><r:layerVisibility>${visibility}</r:layerVisibility></ld:pageRef>
  </ld:pageManager>
  <ld:autoTextManager><ld:entityList>
    <ld:autoTextDefinition name="PageNumber" type="2" />
    <ld:autoTextDefinition name="Sheet" type="3" textValue="A2" />${autoText}
  </ld:entityList></ld:autoTextManager>
</layoutDocument>`;
  const references = `<?xml version="1.0" ?>
<references xmlns="http://sketchup.google.com/schemas/layout/1.0/references" xmlns:r="http://sketchup.google.com/schemas/layout/1.0/references">
  <r:pageFileReference r:id="id1" internalTarget="pages/page1.xml" />
  <r:imageFileReference r:id="id2" internalTarget="ref/logo.png" />
  <r:vectorFileReference r:id="id3" type="2" internalTarget="vectordata/vectordata3.xml" />
</references>`;
  const vector = `<?xml version="1.0" ?>
<vectordata xmlns="http://sketchup.google.com/schemas/layout/1.0/group" xmlns:n0="http://sketchup.google.com/schemas/layout/1.0/entities">
  <n0:group><n0:path id="id1" rotationAngle="0">
    <n0:graphicEntity fillColor="4282915071" strokeColor="4278190080" strokeWidth="0" />
    <n0:elements>0,1,1,1,1</n0:elements><n0:points2f>2,2,3,2,3,3,2,3,2,2</n0:points2f>
  </n0:path></n0:group>
</vectordata>`;
  return zipSync({
    'document.xml': strToU8(document),
    'references.xml': strToU8(references),
    'pages/page1.xml': strToU8(`<?xml version="1.0" ?><page xmlns="http://sketchup.google.com/schemas/layout/1.0/page" ${NS}>${page}</page>`),
    'ref/logo.png': PNG,
    'vectordata/vectordata3.xml': strToU8(vector),
    'ref/model.skp': new Uint8Array([1, 2, 3]),
    ...extra,
  });
}

const PROPERTIES = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<documentProperties xmlns="http://sketchup.google.com/schemas/layout/1.0/documentproperties" xmlns:dp="http://sketchup.google.com/schemas/1.0/documentproperties" xmlns:ldp="http://sketchup.google.com/schemas/layout/1.0/documentproperties">
  <dp:path>C:/Users/Example/Documents/Drawing.layout</dp:path>
  <dp:revision>251</dp:revision>
  <dp:created>2011-12-08T21:20:31Z</dp:created>
  <dp:modified>2016-08-04T15:24:06Z</dp:modified>
  <dp:published>1970-12-31T12:00:00Z</dp:published>
  <ldp:documentStatistic pageCount="2" />
  <dp:generator name="LayOut" version="16.1.1449" />
  <ldp:version current="16.1.1449" fullCompatible="16.0.0" partialCompatible="16.0.0" />
</documentProperties>`;

describe('document properties', () => {
  it('reads the saving LayOut version, creation and modification times, revision and page count', () => {
    const { properties } = importSketchUpLayout(layoutFile('', '', '1,1,1', ['id90'], '', { 'documentProperties.xml': strToU8(PROPERTIES) }));
    expect(properties).toEqual({ version: '16.1.1449', created: '2011-12-08T21:20:31.000Z', modified: '2016-08-04T15:24:06.000Z', revision: 251, pageCount: 2 });
  });
  it('falls back to the generator version and yields nulls for missing, invalid, or malformed properties', () => {
    const partial = PROPERTIES.replace(/<ldp:version[^>]*\/>/, '').replace('2011-12-08T21:20:31Z', 'yesterday').replace('<dp:revision>251</dp:revision>', '<dp:revision>-1</dp:revision>');
    expect(importSketchUpLayout(layoutFile('', '', '1,1,1', ['id90'], '', { 'documentProperties.xml': strToU8(partial) })).properties)
      .toEqual({ version: '16.1.1449', created: null, modified: '2016-08-04T15:24:06.000Z', revision: null, pageCount: 2 });
    const empty = { version: null, created: null, modified: null, revision: null, pageCount: null };
    expect(importSketchUpLayout(layoutFile('')).properties).toEqual(empty);
    expect(importSketchUpLayout(layoutFile('', '', '1,1,1', ['id90'], '', { 'documentProperties.xml': strToU8('<broken') })).properties).toEqual(empty);
  });
});

/** Documents written by LayOut 2027 (27.0.264) through its own Ruby API. */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

/** Page millimeters back to the inches used in the fixtures. */
function inches([x, y]: [number, number]): [number, number] {
  return [Math.round(x / 25.4 * 1e6) / 1e6, Math.round(y / 25.4 * 1e6) / 1e6];
}

function onLayer(layer: string, ids: string[]): string {
  return `<ld:layerInstance><ld:layerDefinition l:ref="${layer}" /><ld:entityList>${ids.map((id) => `<e:entity l:ref="${id}" />`).join('')}</ld:entityList></ld:layerInstance>`;
}

function page(entities: string, layers: string): string {
  return `<layerEntityManager><entityList>${entities}</entityList><layerInstanceManager>${layers}</layerInstanceManager></layerEntityManager>`;
}

const RTF = (body: string) => `{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Helvetica;}}{\\colortbl ;\\red255\\green0\\blue0;}\\pard\\qc\\f0\\cf1\\fs20 ${body}\\par &#x0A;}`;

describe('SketchUp LayOut import', () => {
  it('recognizes .layout files by extension', () => {
    expect(isSketchUpLayoutFile('Sheet A1.LAYOUT')).toBe(true);
    expect(isSketchUpLayoutFile('sheet.pfl')).toBe(false);
  });

  it('prepares plain state that survives structured cloning and installs into the same document', () => {
    const entities = `
      <e:image id="id40">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
        <r:imageFileReference r:id="id2" />
      </e:image>
      <e:skpModelRef id="id41">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
        <r:imageFileReference r:id="id2" /><r:vectorFileReference r:id="id3" />
      </e:skpModelRef>`;
    const bytes = layoutFile(page(entities, onLayer('id10', ['id40', 'id41'])), '', '1,1,1', ['id90'], '', { 'documentProperties.xml': strToU8(PROPERTIES) });
    const prepared = prepareSketchUpLayout(bytes, 'Sheet.layout');
    // What crosses the worker boundary: Maps, arrays, strings and numbers only.
    const cloned = structuredClone(prepared);
    const installed = installSketchUpLayout(cloned);
    const direct = importSketchUpLayout(bytes, 'Sheet.layout');
    const strip = (state: typeof direct.doc.state) => ({ ...state, meta: { ...state.meta, guid: '' },
      modelArchives: [...state.modelArchives?.values() ?? []] });
    expect(strip(installed.doc.state)).toEqual(strip(direct.doc.state));
    expect(installed.warnings).toEqual(direct.warnings);
    expect(installed.properties).toEqual(direct.properties);
    expect(installed.properties.version).toBe('16.1.1449');
    expect(installed.doc.state.pages.size).toBe(1);
    expect(installed.doc.undoStack.canUndo).toBe(false);
  });

  it('converts paper, pages, and layers in stacking order', () => {
    const { doc } = importSketchUpLayout(layoutFile(page('', '')), 'Sheet.layout');
    const state = doc.state;
    const [pageState] = [...state.pages.values()];
    expect(pageState!.name).toBe('Plan & Notes');
    expect(pageState!.size[0]).toBeCloseTo(279.4);
    expect(pageState!.size[1]).toBeCloseTo(215.9);
    expect(pageState!.margin).toEqual({ top: 6.35, right: 12.7, bottom: 6.35, left: 12.7 });
    expect(state.layerOrder.map((id) => state.layers.get(id)!.name)).toEqual(['Base', 'Notes', 'Title']);
    expect(state.layerOrder.map((id) => state.layers.get(id)!.locked)).toEqual([false, true, false]);
    expect(state.layers.get(state.activeLayerId)!.name).toBe('Notes');
    expect(state.customFields.get('FileName')).toBe('Sheet');
  });

  it('keeps path curves, closure, colors, and layer membership of grouped leaves', () => {
    const entities = `
      <e:group>
        <e:path id="id20" rotationAngle="0">
          <e:graphicEntity fillColor="4278190335" strokeColor="4294901760" strokeWidth="2" />
          <e:elements>10,0,2,2,2,2,3</e:elements>
          <e:points2f>1,1,2,1,2,1.5,1.5,2,1,2,0.5,2,0,1.5,0,1,0,0.5,0.5,0,1,0,1.5,0,2,0.5,2,1</e:points2f>
        </e:path>
      </e:group>
      <e:rectangle id="id21" shape="0" rounding="0">
        <e:rectangleBase x="0" y="0" width="2" height="1">
          <e:graphicEntity shouldFill="0" />
          <e:affineTransform m11="0" m12="-1" m21="1" m22="0" tx="5" ty="5" />
        </e:rectangleBase>
      </e:rectangle>`;
    const { doc } = importSketchUpLayout(layoutFile(page(entities, onLayer('id11', ['id20']) + onLayer('id10', ['id21']))));
    const [pageState] = [...doc.state.pages.values()];
    const imported = [...pageState!.entities.values()];
    const circle = imported.find((entity) => entity.handles)!, rectangle = imported.find((entity) => !entity.handles)!;
    expect(doc.state.layers.get(rectangle!.layerId)!.name).toBe('Base');
    expect(doc.state.layers.get(circle!.layerId)!.name).toBe('Notes');
    // Colors are stored with red in the low byte.
    expect(circle!.style).toEqual({ strokeColor: '#0000ff', strokeWeightPt: 2, fillColor: '#ff0000' });
    expect(circle!.closed).toBe(true);
    expect(circle!.points.map(inches)).toEqual([[2, 1], [1, 2], [0, 1], [1, 0]]);
    expect(inches(circle!.handles![0]!.out!)).toEqual([2, 1.5]);
    expect(inches(circle!.handles![0]!.in!)).toEqual([2, 0.5]);
    // x' = m11·x + m12·y + tx, y' = m21·x + m22·y + ty
    expect(rectangle!.points.map(inches)).toEqual([[5, 5], [5, 7], [4, 7], [4, 5]]);
    expect(rectangle!.style!.fillColor).toBeNull();
    expect(rectangle!.style!.strokeColor).toBe('#000000');
  });

  it('imports each run\'s size, font, and color, with the box taking the first run\'s, and line spacing', () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil Arial;}{\\f1\\fnil Helvetica;}}{\\colortbl ;\\red255\\green0\\blue0;\\red51\\green51\\blue51;}' +
      '\\pard\\sl192\\slmult1\\f0\\fs28\\cf1 KAMARIN DESIGN\\par\\f1\\fs12\\cf2 THESE DRAWINGS ARE LICENSED\\par REPRODUCTION PROHIBITED\\par &#x0A;}';
    const entities = `
      <e:rtfText id="id30" anchorType="5" growMode="1">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
        <e:rtfTextRep>${rtf}</e:rtfTextRep>
      </e:rtfText>`;
    const { doc } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id30']))));
    const text = [...doc.state.pages.get(doc.state.pageOrder[0]!)!.entities.values()][0]!.text!;
    expect(text).toMatchObject({ content: 'KAMARIN DESIGN\nTHESE DRAWINGS ARE LICENSED\nREPRODUCTION PROHIBITED',
      fontFamily: 'Arial', fontSizePt: 14, color: '#ff0000', lineSpacing: { mode: 'multiple', value: 0.8 } });
    expect(text.spans).toEqual([
      { start: 0, end: 15, bold: false, italic: false, underline: false },
      { start: 15, end: 66, bold: false, italic: false, underline: false, fontFamily: 'Helvetica', fontSizePt: 6, color: '#333333' },
    ]);
  });

  it('imports page-number auto-text as live page-number fields counted from their own start pages', () => {
    // As in forum-217965 PgNumTest: each tag counts from the page its definition refers to, and is blank before it.
    const tags = (id: number) => `
      <e:rtfText id="id${id}" anchorType="5" growMode="1">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
        <e:rtfTextRep>${RTF('A.&lt;PageNumA&gt; E.&lt;PageNumE&gt; R.&lt;PageNumR&gt;')}</e:rtfTextRep>
      </e:rtfText>`;
    const shared = `<e:rtfText id="id90" anchorType="5" growMode="1">
        <e:placedFileReference><e:rectangleBase x="1" y="5" width="2" height="1" /></e:placedFileReference>
        <e:rtfTextRep>${RTF('Sheet &lt;PageNumE&gt;')}</e:rtfTextRep>
      </e:rtfText>`;
    const definitions = '<ld:autoTextDefinition name="PageNumA" type="2" l:ref="id1" numberingType="0" startNumber="1" />' +
      '<ld:autoTextDefinition name="PageNumE" type="2" l:ref="id5" numberingType="0" startNumber="1" />' +
      '<ld:autoTextDefinition name="PageNumR" type="2" l:ref="id1" numberingType="4" startNumber="3" />';
    const files = unzipSync(layoutFile(page(tags(30), onLayer('id10', ['id30'])), shared, '1,1,1', ['id90'], definitions));
    // Three pages; the referenced page "E" is the second.
    files['document.xml'] = strToU8(strFromU8(files['document.xml']!).replace('</ld:pageManager>',
      '<ld:pageRef r:id="id5" name="E"><r:layerVisibility>1,1,1</r:layerVisibility></ld:pageRef>' +
      '<ld:pageRef r:id="id6" name="Third"><r:layerVisibility>1,1,1</r:layerVisibility></ld:pageRef></ld:pageManager>'));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:pageFileReference r:id="id5" internalTarget="pages/page5.xml" /><r:pageFileReference r:id="id6" internalTarget="pages/page6.xml" /></references>'));
    for (const [file, id] of [['pages/page5.xml', 31], ['pages/page6.xml', 32]] as const) {
      files[file] = strToU8(strFromU8(files['pages/page1.xml']!).replace('id30', `id${id}`).replace('l:ref="id30"', `l:ref="id${id}"`));
    }
    const { doc, warnings } = importSketchUpLayout(zipSync(files));
    const { state } = doc;
    const pages = state.pageOrder.map((pageId) => state.pages.get(pageId)!);
    // PageNumA numbers as PushForm's page number does, so it becomes <PageNumber>; the others keep their own fields.
    expect(pages.map((p) => [...p.entities.values()].map((entity) => entity.text?.content))).toEqual(Array(3).fill(['A.<PageNumber> E.<PageNumE> R.<PageNumR>']));
    expect([...state.pageNumberFields!]).toEqual([
      ['PageNumE', { startPageId: state.pageOrder[1], startNumber: 1, style: 'arabic' }],
      ['PageNumR', { startPageId: null, startNumber: 3, style: 'upper-roman' }],
    ]);
    // Each page shows what LayOut shows, shared-layer text included, which no fixed text could.
    expect(pages.map((p) => resolveLayoutText('A.<PageNumber> E.<PageNumE> R.<PageNumR>', p, state))).toEqual(['A.1 E. R.III', 'A.2 E.1 R.IV', 'A.3 E.2 R.V']);
    expect([...state.sharedEntities.values()].map((entity) => entity.text?.content)).toEqual(['Sheet <PageNumE>']);
    expect(pages.map((p) => resolveLayoutText('Sheet <PageNumE>', p, state))).toEqual(['Sheet ', 'Sheet 1', 'Sheet 2']);
    expect(warnings.some((warning) => warning.includes('page-number auto-text'))).toBe(false);
  });

  it('keeps another default-numbered name apart from a customized PageNumber', () => {
    // As in forum-22457: PageNumber itself starts on the second page, padded, so a plain field cannot be <PageNumber>.
    const text = `<e:rtfText id="id30" anchorType="5" growMode="1">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
        <e:rtfTextRep>${RTF('&lt;PageNumber&gt;/&lt;Plain&gt;')}</e:rtfTextRep>
      </e:rtfText>`;
    const definitions = '<ld:autoTextDefinition name="PageNumber" type="2" l:ref="id5" numberingType="1" startNumber="1" />' +
      '<ld:autoTextDefinition name="Plain" type="2" l:ref="id1" numberingType="0" startNumber="1" />';
    const files = unzipSync(layoutFile(page(text, onLayer('id10', ['id30'])), '', '1,1,1', [], definitions));
    files['document.xml'] = strToU8(strFromU8(files['document.xml']!).replace('</ld:pageManager>',
      '<ld:pageRef r:id="id5" name="Sheet"><r:layerVisibility>1,1,1</r:layerVisibility></ld:pageRef></ld:pageManager>'));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:pageFileReference r:id="id5" internalTarget="pages/page5.xml" /></references>'));
    files['pages/page5.xml'] = files['pages/page1.xml']!;
    const { state } = importSketchUpLayout(zipSync(files)).doc;
    expect([...state.pageNumberFields!.keys()]).toEqual(['PageNumber', 'Plain']);
    expect(state.pageOrder.map((id) => resolveLayoutText('<PageNumber>/<Plain>', state.pages.get(id)!, state))).toEqual(['/1', '01/2']);
  });

  it('imports rotated RTF text with auto-text fields and its first run\'s style', () => {
    const entities = `
      <e:rtfText id="id30" anchorType="48" growMode="1">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="0.5">
          <e:affineTransform m11="0" m12="1" m21="-1" m22="0" tx="4" ty="4" />
        </e:rectangleBase></e:placedFileReference>
        <e:rtfTextRep>${RTF('\\b Sheet\\b0  &lt;Sheet&gt;-&lt;PageNumber&gt; of &lt;Unknown&gt;')}</e:rtfTextRep>
      </e:rtfText>`;
    const { doc } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id30']))));
    const [pageState] = [...doc.state.pages.values()];
    const text = [...pageState!.entities.values()][0]!;
    expect(text.kind).toBe('text');
    expect(text.text).toMatchObject({
      content: 'Sheet <Sheet>-<PageNumber> of <Unknown>',
      fontFamily: 'Helvetica', fontSizePt: 10, color: '#ff0000', align: 'center', vertical: 'middle',
      bounded: true, rotationDeg: -90,
    });
    expect(text.text!.spans![0]).toMatchObject({ start: 0, end: 5, bold: true });
    expect(doc.state.customFields.get('Sheet')).toBe('A2');
    // The unrotated 2×0.5 in box stays centered on the transformed center (5.25, 2).
    expect(text.points.map(inches)).toEqual([[4.25, 1.75], [6.25, 2.25]]);
  });

  it('preserves nested groups across layers, arrowed lines, and save/reopen', () => {
    const line = (id: number, x: number) => `<e:path id="id${id}"><e:graphicEntity shouldFill="0" />
      <e:elements>0,1</e:elements><e:points2f>${x},0,${x + 1},0</e:points2f></e:path>`;
    const entities = `<e:group>
      <e:path id="id70"><e:graphicEntity shouldFill="0" /><e:elements>0,1</e:elements><e:points2f>0,0,1,0</e:points2f>
        <e:arrowData startArrowType="3" startArrowSize="4" endArrowType="0" /></e:path>
      <e:group>
        <e:rectangle id="id71"><e:rectangleBase x="3" y="0" width="1" height="1" /></e:rectangle>
        <e:rtfText id="id72"><e:placedFileReference><e:rectangleBase x="0" y="2" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('Grouped note')}</e:rtfTextRep></e:rtfText>
      </e:group>
    </e:group><e:group>${line(73, 5)}${line(74, 7)}</e:group>${line(75, 9)}`;
    const content = page(entities, onLayer('id10', ['id75', 'id72', 'id70', 'id74', 'id73']) + onLayer('id11', ['id71']));
    const { doc } = importSketchUpLayout(layoutFile(content));
    const imported = [...doc.state.pages.values()][0]!;
    const all = imported.entityOrder.map(id => imported.entities.get(id)!);
    expect(all).toHaveLength(6);
    const [outside, text, linePath, siblingB, siblingA, rectangle] = all;
    // The open 90° arrow is the line's own start arrow, not a separate shape.
    expect(linePath!.style!.startArrow).toEqual({ type: 'open-arrow-90', sizePt: 4 });
    expect(outside!.points.map(inches)).toEqual([[9, 0], [10, 0]]);
    expect(outside!.groupId).toBeUndefined();
    expect(text!.text!.content).toBe('Grouped note');
    const outer = linePath!.groupId, inner = text!.nestedGroupIds;
    expect(outer).toBeDefined(); expect(inner).toHaveLength(1);
    expect([text, rectangle].map(entity => entity!.groupId)).toEqual([outer, outer]);
    expect(rectangle!.nestedGroupIds).toEqual(inner);
    expect(linePath!.nestedGroupIds).toBeUndefined();
    expect(siblingA!.groupId).toBeDefined(); expect(siblingA!.groupId).not.toBe(outer);
    expect(siblingB!.groupId).toBe(siblingA!.groupId);
    expect(doc.state.layers.get(rectangle!.layerId)!.name).toBe('Notes');
    expect(all.slice(0, -1).every(entity => doc.state.layers.get(entity.layerId)!.name === 'Base')).toBe(true);
    const identities = new Set([...doc.state.layers.keys(), ...doc.state.pages.keys(), ...imported.entities.keys()]);
    expect(identities.has(outer!)).toBe(false); expect(identities.has(inner![0]!)).toBe(false);
    expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(imported.id)).toEqual(imported);
    const { doc: hidden } = importSketchUpLayout(layoutFile(content, '', '1,0,1'));
    const visible = [...hidden.state.pages.values()][0]!.entities;
    expect(visible.size).toBe(5);
    expect([...visible.values()].find(entity => entity.kind === 'text')!.nestedGroupIds).toHaveLength(1);
  });

  it('draws a placed CAD file from LayOut\'s converted paths as one group', () => {
    const cadPath = (id: number, points: string) => `<e:path id="id${id}"><e:graphicEntity shouldFill="0" strokeWidth="0.5" />
      <e:elements>0,1,1</e:elements><e:points2f>${points}</e:points2f></e:path>`;
    const reference = (id: number, data: string) => `<e:VectorEntityRef id="id${id}">
      <e:placedFileReference><e:rectangleBase x="3" y="1" width="2" height="2">
        <e:affineTransform m11="1" m12="0" m21="0" m22="1" tx="-2" ty="0" /></e:rectangleBase></e:placedFileReference>
      <e:origin x="0.5" y="-1" /><r:vectorFileReference r:id="id60" />${data}</e:VectorEntityRef>`;
    const drawing = `<vectordata name=""><e:group name="">${cadPath(81, '1,1,3,1,3,3')}</e:group>
      <e:group name="">${cadPath(82, '1,3,2,2,3,3')}</e:group><e:scaleContext name="(1:10)" scale="0.1" unitType="2" /></vectordata>`;
    const line = `<e:path id="id83"><e:graphicEntity shouldFill="0" /><e:elements>0,1</e:elements><e:points2f>5,0,6,0</e:points2f></e:path>`;
    const entities = `<e:group>${reference(80, drawing)}${line}</e:group>${reference(84, '')}`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id80', 'id83', 'id84']))));
    const imported = [...doc.state.pages.values()][0]!;
    const [first, second, outside] = imported.entityOrder.map(id => imported.entities.get(id)!);
    expect(imported.entities.size).toBe(3);
    expect(first!.points.map(inches)).toEqual([[1, 1], [3, 1], [3, 3]]);
    expect(second!.points.map(inches)).toEqual([[1, 3], [2, 2], [3, 3]]);
    expect(first!.style?.strokeWeightPt).toBe(0.5);
    // The drawing is its own group inside the page group that also holds the line.
    expect(first!.groupId).toBe(outside!.groupId); expect(second!.groupId).toBe(outside!.groupId);
    expect(first!.nestedGroupIds).toHaveLength(1); expect(second!.nestedGroupIds).toEqual(first!.nestedGroupIds);
    expect(outside!.nestedGroupIds).toBeUndefined();
    expect(warnings.some(warning => warning.includes('VectorEntityRef'))).toBe(false);
    expect(warnings.some(warning => warning.includes('placed CAD file'))).toBe(true);
  });

  it('preserves shared-layer group nesting independently of page-local groups', () => {
    const rectangle = (id: number) => `<e:rectangle id="id${id}"><e:rectangleBase x="0" y="0" width="1" height="1" /></e:rectangle>`;
    const master = `<e:group>${rectangle(90)}<e:group>${rectangle(91)}${rectangle(92)}</e:group></e:group>`;
    const local = `<e:group>${rectangle(93)}${rectangle(94)}</e:group>`;
    const { doc } = importSketchUpLayout(layoutFile(page(local, onLayer('id10', ['id93', 'id94'])), master, '1,1,1', ['id90', 'id91', 'id92']));
    const shared = [...doc.state.sharedEntities.values()], localEntities = [...doc.state.pages.values()][0]!.entities;
    expect(shared).toHaveLength(3);
    expect(new Set(shared.map(entity => entity.groupId)).size).toBe(1);
    expect(shared[0]!.groupId).toBeDefined(); expect(shared[0]!.nestedGroupIds).toBeUndefined();
    expect(shared[1]!.nestedGroupIds).toHaveLength(1); expect(shared[2]!.nestedGroupIds).toEqual(shared[1]!.nestedGroupIds);
    expect([...localEntities.values()][0]!.groupId).not.toBe(shared[0]!.groupId);
    expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.sharedEntities).toEqual(doc.state.sharedEntities);
  });

  it('retains embedded model bytes and original viewport records through sheet edits and native save/reopen', async () => {
    const viewport = (id: string, ref = 'idModel') => `<e:skpModelRef id="${id}" constantSize="${id === 'id40' ? '1' : '0'}" renderMode="2" unknownSetting="keep-me">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
      <e:camera projection="perspective" customCameraSetting="42" />
      <r:skpFileReference r:id="${ref}" />
      <r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(viewport('id40') + viewport('id41') + viewport('id42', 'idExternal'), onLayer('id10', ['id40', 'id41', 'id42']))));
    const modelBytes = new Uint8Array([0, 255, 42, 10, 0, 77]);
    files['ref/model.skp'] = modelBytes;
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" externalTarget="C:/missing/model.skp" />' +
      '<r:skpFileReference r:id="idExternal" externalTarget="https://never-fetch.invalid/model.skp" /></references>'));
    files['unknown/settings.bin'] = new Uint8Array([123, 0, 8]);
    const original = zipSync(files);
    const { doc } = importSketchUpLayout(original);
    const [archiveId, archive] = [...doc.state.modelArchives!][0]!;
    expect(doc.state.modelArchives!.size).toBe(1);
    expect(archive.models.size).toBe(2);
    expect(archive.viewports.size).toBe(3);
    expect(archive.viewports.get('id40')?.modelReferenceId).toBe('idModel');
    expect(archive.viewports.get('id41')?.modelReferenceId).toBe('idModel');
    expect(readPreservedSketchUpModel(doc.state, archiveId, 'idModel')).toEqual(modelBytes);
    expect(readPreservedSketchUpModel(doc.state, archiveId, 'idExternal')).toBeNull();
    doc.renamePage(doc.state.pageOrder[0]!, 'Edited sheet');
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
    expect(readOriginalLayoutArchive(reopened.state, archiveId)).toEqual(original);
    expect(readPreservedSketchUpModel(reopened.state, archiveId, 'idModel')).toEqual(modelBytes);
    expect(reopened.state.modelArchives).toEqual(doc.state.modelArchives);
    const resizeModes = (state: typeof doc.state) => [...state.pages.values()].flatMap(page => [...page.entities.values()]).map(entity => entity.image?.viewport?.preserveScaleOnResize);
    expect(resizeModes(reopened.state)).toEqual([true, false, false]);
    const recovered = unzipSync(readOriginalLayoutArchive(reopened.state, archiveId));
    expect(recovered['unknown/settings.bin']).toEqual(files['unknown/settings.bin']);
    expect(strFromU8(recovered['pages/page1.xml']!)).toContain('unknownSetting="keep-me"');
    expect(strFromU8(recovered['pages/page1.xml']!)).toContain('customCameraSetting="42"');
    const exported = await exportSketchUpLayout(reopened.state);
    expect(exported.warnings).toEqual([]);
    const outputFiles = unzipSync(exported.bytes);
    const outputPage = strFromU8(outputFiles['pages/page1.xml']!);
    expect(outputPage.match(/<e:skpModelRef\b/g)).toHaveLength(3);
    expect(outputPage).toContain('unknownSetting="keep-me"');
    expect(outputPage).toContain('customCameraSetting="42"');
    expect(outputFiles['preserved-layout/1/ref/model.skp']).toEqual(modelBytes);
    const reimported = importSketchUpLayout(exported.bytes);
    expect(resizeModes(reimported.doc.state)).toEqual([true, false, false]);
    expect([...reimported.doc.state.modelArchives!.values()][0]!.viewports.size).toBe(3);
  });

  it('preserves sources even when their viewports have no cached render', () => {
    const { doc } = importSketchUpLayout(layoutFile(page(`<e:skpModelRef id="id40">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
    </e:skpModelRef>`, onLayer('id10', ['id40']))));
    const [archiveId, archive] = [...doc.state.modelArchives!][0]!;
    expect(archive.viewports.get('id40')?.modelReferenceId).toBeNull();
    expect(readOriginalLayoutArchive(decodeLayoutDocument(encodeLayoutDocument(doc)).state, archiveId)).toEqual(readOriginalLayoutArchive(doc.state, archiveId));
  });

  it('preserves namespace bindings, dependent vector resources, and shared model references without id collisions', async () => {
    const model = `<e:skpModelRef id="id1" xmlns:custom="urn:custom" custom:id="do-not-remap" note="a &gt; b">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <r:skpFileReference r:id="idModel" /><r:vectorFileReference r:id="id3" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model, onLayer('id10', ['id1']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" externalTarget="" /></references>'));
    const { doc } = importSketchUpLayout(zipSync(files));
    // An unrelated sheet object intentionally adds more generated ids to the output package.
    doc.undoStack.transact('Paper note', draft => {
      const id = draft.meta.nextId++, target = draft.pages.get(draft.pageOrder[0]!)!;
      target.entities.set(id, { id, layerId: draft.layerOrder[0]!, kind: 'path', closed: false, points: [[5, 5], [10, 10]],
        style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null } });
      target.entityOrder.push(id);
    });
    const exported = await exportSketchUpLayout(doc.state), output = unzipSync(exported.bytes);
    expect(exported.warnings).toEqual([]);
    const pageText = strFromU8(output['pages/page1.xml']!);
    expect(pageText).toContain('xmlns:custom="urn:custom"');
    expect(pageText).toContain('custom:id="do-not-remap"');
    expect(pageText).toContain('note="a &gt; b"');
    expect(output['preserved-layout/1/vectordata/vectordata3.xml']).toBeDefined();
    const references = parseXml(strFromU8(output['references.xml']!));
    const modelReference = references.children.find(node => node.name === 'skpFileReference')!;
    expect(output[modelReference.attrs.internalTarget!]).toEqual(files['ref/model.skp']);
    const vector = strFromU8(output['preserved-layout/1/vectordata/vectordata3.xml']!);
    const viewportId = /\sid="([^"]+)"/.exec(/<e:skpModelRef\b[^>]*>/.exec(pageText)![0])![1]!;
    const pathId = /\bid="([^"]+)"/.exec(vector)![1]!;
    expect(viewportId).not.toBe(pathId);
    expect(importSketchUpLayout(exported.bytes).doc.state.modelArchives?.size).toBe(1);
  });

  it('lays a hybrid render\'s picture under its edges, and renders a model view whose saved picture is blank', () => {
    const model = `<e:skpModelRef id="id40">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" /><r:vectorFileReference r:id="id3" /><e:imageRect x="1" y="1" width="4" height="4" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model, onLayer('id10', ['id40']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const view = (bytes: Uint8Array) => { const state = importSketchUpLayout(bytes).doc.state, p = state.pages.get(state.pageOrder[0]!)!; return p.entities.get(p.entityOrder[0]!)!.image!; };
    const hybrid = view(zipSync(files));
    const svg = atob(hybrid.src.slice('data:image/svg+xml;base64,'.length));
    expect(svg).toMatch(/^<svg[^>]*><image href="data:image\/png;base64,[^"]+" x="1" y="1" width="4" height="4" preserveAspectRatio="none"\/><path /);
    expect(hybrid.viewport!.cache).not.toBeNull();
    // LayOut saved this view's picture fully transparent; the view renders from its model instead.
    files['ref/logo.png'] = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgIBkAAAAzAAHSQ7HjAAAAAElFTkSuQmCC'), c => c.charCodeAt(0));
    const blank = view(zipSync(files));
    expect(blank.src).toBe('');
    expect(blank.viewport!.cache).toBeNull();
  });

  it('leaves out the sky and background LayOut saved in a raster render when the view\'s Background is off', () => {
    // LayOut's colors are ABGR: sky rgb(198,205,208), background rgb(204,204,201).
    const model = (id: string, background: string) => `<e:skpModelRef id="${id}" displayBackground="${background}">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <e:renderingOptions><e:entry key="SkyColor" type="3" value="-3093050" /><e:entry key="BackgroundColor" type="3" value="-3552052" /></e:renderingOptions>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model('id40', '0') + model('id41', '1'), onLayer('id10', ['id40', 'id41']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    // sky, background, and a white face
    files['ref/logo.png'] = new Uint8Array(encodePng(3, 1, new Uint8Array([198, 205, 208, 204, 204, 201, 255, 255, 255]), 3));
    const state = importSketchUpLayout(zipSync(files)).doc.state, p = state.pages.get(state.pageOrder[0]!)!;
    const [off, on] = p.entityOrder.map(id => p.entities.get(id)!.image!);
    const pixels = (src: string) => [...decodePng(Uint8Array.from(atob(src.slice('data:image/png;base64,'.length)), c => c.charCodeAt(0)))!.pixels];
    expect(pixels(off!.src)).toEqual([198, 205, 208, 0, 204, 204, 201, 0, 255, 255, 255, 255]);
    expect(off!.viewport).toMatchObject({ background: null });
    expect(pixels(on!.src)).toEqual([198, 205, 208, 204, 204, 201, 255, 255, 255]);
    expect(on!.viewport).toMatchObject({ background: '#ccccc9' });
  });

  it('keeps a sky or background color the model draws in, or white paper, when Background is off', () => {
    // A white background (the default face color) and a black sky (the edge color) stay in the picture.
    const model = `<e:skpModelRef id="id40" displayBackground="0">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <e:renderingOptions><e:entry key="SkyColor" type="3" value="-16777216" /><e:entry key="BackgroundColor" type="3" value="-1" />
        <e:entry key="ForegroundColor" type="3" value="-16777216" /></e:renderingOptions>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model, onLayer('id10', ['id40']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const raster = new Uint8Array(encodePng(2, 1, new Uint8Array([0, 0, 0, 255, 255, 255]), 3));
    files['ref/logo.png'] = raster;
    const state = importSketchUpLayout(zipSync(files)).doc.state, p = state.pages.get(state.pageOrder[0]!)!;
    const src = p.entities.get(p.entityOrder[0]!)!.image!.src;
    expect([...decodePng(Uint8Array.from(atob(src.slice('data:image/png;base64,'.length)), c => c.charCodeAt(0)))!.pixels]).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('keeps each model view\'s face style, edges and X-ray from LayOut\'s rendering options', () => {
    const entry = (key: string, value: string) => `<e:entry key="${key}" type="3" value="${value}" />`;
    const model = (id: string, options: string) => `<e:skpModelRef id="${id}">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      ${options}<r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(
      model('id40', `<e:renderingOptions>${entry('RenderMode', '1')}${entry('DrawSilhouettes', '0')}${entry('EdgeDisplayMode', '1')}</e:renderingOptions>`) +
      model('id41', `<e:renderingOptions>${entry('RenderMode', '2')}${entry('Texture', '0')}${entry('ModelTransparency', '1')}${entry('DrawBackEdges', '1')}</e:renderingOptions>`) +
      model('id42', `<e:renderingOptions>${entry('RenderMode', '5')}${entry('EdgeDisplayMode', '0')}</e:renderingOptions>`) +
      model('id43', ''), onLayer('id10', ['id40', 'id41', 'id42', 'id43']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const { doc } = importSketchUpLayout(zipSync(files));
    const p = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const displays = p.entityOrder.map(id => p.entities.get(id)!.image!.viewport!.display);
    expect(displays).toEqual([
      { faceStyle: 'hiddenLine', edges: true, profiles: false, backEdges: false, xray: false, hiddenGeometry: false },
      { faceStyle: 'shaded', edges: true, profiles: true, backEdges: true, xray: true, hiddenGeometry: false },
      { faceStyle: 'monochrome', edges: false, profiles: true, backEdges: false, xray: false, hiddenGeometry: false },
      undefined,
    ]);
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(p.id)!;
    expect(p.entityOrder.map(id => reopened.entities.get(id)!.image!.viewport!.display)).toEqual(displays);
  });

  it('keeps each model view\'s sun and shadows from LayOut\'s shadow options, reading the local time as SketchUp stores it', () => {
    const entry = (key: string, value: string) => `<e:entry key="${key}" type="3" value="${value}" />`;
    // ShadowTime shows the saving computer's zone; ShadowTime_time_t's UTC reading (10:42) is the local time in TZOffset.
    const shadowOptions = `<e:shadowOptions>${entry('DisplayShadows', '1')}${entry('ShadowTime', '2015-06-29T13:42:11')}
      ${entry('ShadowTime_time_t', '1435574531')}${entry('TZOffset', '-7')}${entry('Latitude', '40.018309')}${entry('Longitude', '-105.242139')}
      ${entry('NorthAngle', '-30')}${entry('Light', '76')}${entry('Dark', '40')}${entry('UseSunForAllShading', '0')}
      ${entry('DisplayOnAllFaces', '1')}${entry('DisplayOnGroundPlane', '0')}${entry('EdgesCastShadows', '1')}</e:shadowOptions>`;
    const model = (id: string, shadows: string) => `<e:skpModelRef id="${id}">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <e:renderingOptions>${entry('RenderMode', '2')}</e:renderingOptions>${shadows}<r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model('id40', shadowOptions) + model('id41', ''), onLayer('id10', ['id40', 'id41']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const { doc } = importSketchUpLayout(zipSync(files));
    const p = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [shadowed, plain] = p.entityOrder.map(id => p.entities.get(id)!.image!.viewport!.display);
    expect(shadowed!.shadows).toEqual({ enabled: true, month: 6, day: 29, time: 10 * 60 + 42, utcOffsetHours: -7, latitude: 40.018309,
      longitude: -105.242139, northAngle: 330, light: 76, dark: 40, useSunForShading: false, onGround: false, onFaces: true, fromEdges: true });
    expect(plain!.shadows).toBeUndefined();
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(p.id)!;
    expect(reopened.entities.get(p.entityOrder[0]!)!.image!.viewport!.display).toEqual(shadowed);
  });

  it.each([false, true])('preserves unchanged model connections through native save and remaps every exported identity, model distance %s', async modelDistance => {
    const model = `<e:skpModelRef id="id40">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
      <e:camera projection="1" height="48" fov="35"><e:eye x="0" y="0" z="500" /><e:target x="0" y="0" z="0" /><e:up x="0" y="1" z="0" /></e:camera>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" /></e:skpModelRef>`;
    const dimension = `<e:linearDimension id="id50" autoScale="1" scale="0.1" useInModelDistance="${modelDistance ? 1 : 0}" unknown="retain">
      <e:dimensionText id="id51" anchorType="5" growMode="0">
        <e:placedFileReference><e:rectangleBase x="1" y="0.5" width="1" height="0.2" /></e:placedFileReference>
        <e:rtfTextRep>${RTF('&lt;&gt;')}</e:rtfTextRep></e:dimensionText>
      <ld:startConnectionPoint x="1" y="1" /><ld:endConnectionPoint x="2" y="1" />
      <e:dimensionLine id="id52"><e:elements>0,1</e:elements><e:points2f>1,0.5,2,0.5</e:points2f></e:dimensionLine></e:linearDimension>`;
    const label = `<e:label id="id60" connectionType="1"><e:skpAutoTextCache>
      <dicItem key="&lt;Coordinates(x)&gt;"><variant type="8">10 inches</variant></dicItem>
      <dicItem key="&lt;Ratio&gt;"><variant type="8">1:10</variant></dicItem></e:skpAutoTextCache>
      <e:labelText id="id61" anchorType="0" growMode="1"><e:placedFileReference><e:rectangleBase x="3" y="1" width="2" height="0.5" /></e:placedFileReference>
        <e:rtfTextRep>${RTF('At &lt;Coordinates(x)&gt; / &lt;Ratio&gt;')}</e:rtfTextRep></e:labelText>
      <e:leaderLine id="id62"><e:elements>0,1</e:elements><e:points2f>2,1,3,1</e:points2f></e:leaderLine></e:label>`;
    const connections = `<connectionManager>${[5, 6].map(end => `<connection>
      <sketchupConnectionPoint l:ref="id40" pointType="1"><paperPoint x="${end - 4}" y="1" />
        <modelPoint x="${(end - 5) * 10}" y="0" z="${(end - 5) * 10}" /><persistentIdPath>123.456</persistentIdPath></sketchupConnectionPoint>
      <dimensionConnectionPoint l:ref="id50" componentId="${end}" /></connection>`).join('')}
      <connection><sketchupConnectionPoint l:ref="id40" pointType="1" pid="66.13"><modelPoint x="10" y="0" z="10" /></sketchupConnectionPoint>
        <labelConnectionPoint l:ref="id60" componentIndex="4294967295" /></connection></connectionManager>`;
    const files = unzipSync(layoutFile(page(dimension + model + label, onLayer('id10', ['id50', 'id40', 'id60'])) + connections));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const imported = importSketchUpLayout(zipSync(files));
    const doc = decodeLayoutDocument(encodeLayoutDocument(imported.doc));
    const first = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const annotation = [...first.entities.values()].find(entity => entity.dimension)!;
    const view = [...first.entities.values()].find(entity => entity.image?.viewport)!;
    const modelLabel = [...first.entities.values()].find(entity => entity.kind === 'label')!;
    expect(modelLabel.text!.content).toBe('At <Coordinates(x)> / <Ratio>');
    expect(resolveLayoutText(modelLabel.text!.content, first, doc.state, layoutModelFields(modelLabel))).toBe('At 10 inches / 1:10');
    expect(annotation.preservedModelConnections?.viewports).toEqual([{ originalId: 'id40', entityId: view.id }]);
    expect(annotation.dimension!.cachedValueMm / (annotation.dimension!.scale ?? 1)).toBeCloseTo((modelDistance ? Math.sqrt(200) : 10) * 25.4);
    doc.undoStack.transact('Unrelated paper edit', state => { state.customFields.set('Notes', 'Updated'); refreshLayoutDimensions(state); });
    const exported = await exportSketchUpLayout(doc.state);
    expect(exported.warnings).toEqual([]);
    const output = unzipSync(exported.bytes), pageXml = strFromU8(output['pages/page1.xml']!), documentXml = strFromU8(output['document.xml']!);
    const ownerId = /<e:linearDimension\b[^>]*\sid="([^"]+)"/.exec(pageXml)![1];
    const viewId = /<e:skpModelRef\b[^>]*\sid="([^"]+)"/.exec(pageXml)![1];
    expect(pageXml).toContain(`autoScale="1" scale="0.1" useInModelDistance="${modelDistance ? 1 : 0}" unknown="retain"`);
    expect(documentXml.match(/<sketchupConnectionPoint /g)).toHaveLength(3);
    expect(pageXml).toContain('<e:skpAutoTextCache>');
    expect(documentXml).toContain('pid="66.13"');
    expect(documentXml).toContain(`<sketchupConnectionPoint l:ref="${viewId}"`);
    expect(documentXml).toContain(`<dimensionConnectionPoint l:ref="${ownerId}" componentId="5"`);
    expect(documentXml).toContain('<persistentIdPath>123.456</persistentIdPath>');
    expect(output['preserved-layout/1/ref/model.skp']).toEqual(files['ref/model.skp']);
    expect(importSketchUpLayout(exported.bytes).doc.state.pages.size).toBe(1);
    doc.undoStack.transact('Resize mode only', state => { state.pages.get(first.id)!.entities.get(view.id)!.image!.viewport!.preserveScaleOnResize = true; });
    const modeOnly = await exportSketchUpLayout(doc.state);
    expect(modeOnly.warnings).toEqual([]);
    expect(strFromU8(unzipSync(modeOnly.bytes)['document.xml']!).match(/<sketchupConnectionPoint /g)).toHaveLength(3);
    expect(strFromU8(unzipSync(modeOnly.bytes)['pages/page1.xml']!)).toContain('constantSize="1"');
    doc.undoStack.transact('Changed camera', state => { state.pages.get(first.id)!.entities.get(view.id)!.image!.viewport!.camera.scale *= 2; });
    const changed = await exportSketchUpLayout(doc.state);
    expect(changed.warnings.some(warning => warning.startsWith('An imported model annotation or its view changed; its appearance was exported without its original model connection'))).toBe(true);
    expect(strFromU8(unzipSync(changed.bytes)['document.xml']!)).not.toContain('sketchupConnectionPoint');
    const fallback = importSketchUpLayout(changed.bytes).doc.state;
    expect([...fallback.pages.values()].flatMap(page => [...page.entities.values()]).find(entity => entity.kind === 'label')!.text!.content)
      .toBe('At 10 inches / 1:10');
    doc.undoStack.transact('Legacy native document', state => {
      delete state.pages.get(first.id)!.entities.get(annotation.id)!.preservedModelConnections;
      for (const archive of state.modelArchives!.values()) delete archive.annotationConnectionsVersion;
    });
    const legacy = await exportSketchUpLayout(decodeLayoutDocument(encodeLayoutDocument(doc)).state);
    expect(legacy.warnings).toContain('This drawing was imported before model connections were preserved; original model annotation connections may be missing');
  });

  it('exports moved, copied, re-aimed and grouped viewports as LayOut viewports', async () => {
    const model = (id: string) => `<e:skpModelRef id="${id}" unknownSetting="keep-me" defaultPageName="Plan" cameraModified="0">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
      <e:camera projection="1" height="48" fov="35" twoDCamera="0" twoDScale="1" twoDxCenter="0" twoDyCenter="0" aspectRatio="0">
        <e:eye x="10" y="20" z="500" /><e:target x="10" y="20" z="0" /><e:up x="0" y="1" z="0" /><e:offset x="0" y="0" />
      </e:camera>
      <e:renderingOptions><e:entry key="HLRDrawingStyle" type="3" value="2" /><e:entry key="OutputFaces" type="11" value="1" /></e:renderingOptions>
      <e:skpStyleProperties><r:fileReference r:id="idStyle-${id}" type="2" internalTarget="ref/123_Style_8.style" externalTarget="" /></e:skpStyleProperties>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" /><e:imageRect x="1" y="1" width="2" height="1" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model('id40') + `<e:group id="idGroup">${model('id41')}</e:group>`, onLayer('id10', ['id40', 'idGroup']))));
    files['ref/123_Style_8.style'] = new Uint8Array([1, 2, 3]);
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      '<r:skpFileReference r:id="idModel" internalTarget="ref/model.skp" /></references>'));
    const { doc } = importSketchUpLayout(zipSync(files));
    const page0 = () => doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [moved, grouped] = page0().entityOrder.map(id => page0().entities.get(id)!);
    expect(moved!.image!.viewport).toMatchObject({ scene: 'Plan', originalId: 'id40', camera: { projection: 'parallel' } });
    expect(moved!.image!.viewport!.camera.scale).toBeCloseTo(1 / 48);
    doc.undoStack.transact('Edit viewports', draft => {
      const target = draft.pages.get(draft.pageOrder[0]!)!, entity = target.entities.get(moved!.id)!;
      entity.points = entity.points.map(([x, y]) => [x + 25.4, y]);
      const id = draft.meta.nextId++, copy = JSON.parse(JSON.stringify(entity)) as typeof entity;
      copy.id = id;
      copy.points = copy.points.map(([x, y]) => [x, y + 50.8]);
      copy.image!.viewport = { ...copy.image!.viewport!, originalId: null, scene: null, camera: { ...copy.image!.viewport!.camera, scale: 1 / 24 } };
      target.entities.set(id, copy);
      target.entityOrder.push(id);
    });
    const exported = await exportSketchUpLayout(doc.state);
    expect(exported.warnings).toEqual([]);
    const output = unzipSync(exported.bytes), pageText = strFromU8(output['pages/page1.xml']!);
    const refs = [...pageText.matchAll(/<e:skpModelRef\b[^>]*>/g)].map(match => match[0]);
    expect(refs).toHaveLength(3);
    const styles = [...pageText.matchAll(/<r:fileReference\b[^>]*r:id="id(\d+)"[^>]*internalTarget="([^"]+\.style)"/g)];
    expect(styles).toHaveLength(3);
    expect(new Set(styles.map(match => match[2])).size).toBe(3);
    for (const [, id, target] of styles) {
      expect(target).toBe(`ref/123_Style_${id}.style`);
      expect(output[target!]).toEqual(files['ref/123_Style_8.style']);
    }
    expect(new Set(refs.map(tag => /\sid="([^"]+)"/.exec(tag)![1])).size).toBe(3);
    expect(refs.every(tag => tag.includes('unknownSetting="keep-me"'))).toBe(true);
    expect(pageText).toContain('<e:rectangleBase x="2" y="1" width="2" height="1"');
    // The copy shows twice the scale: half the model height in the same frame, and no longer the "Plan" scene.
    expect(pageText).toMatch(/<e:skpModelRef[^>]*cameraModified="1"[\s\S]*?height="24"/);
    // The copy renders in Raster; the moved and the untouched imported views keep their Vector mode.
    const modes = [...pageText.matchAll(/<e:skpModelRef\b[\s\S]*?<\/e:skpModelRef>/g)].map(([view]) =>
      [/key="HLRDrawingStyle"[^>]*value="(\d)"/.exec(view)![1], /key="OutputFaces"[^>]*value="(\d)"/.exec(view)![1]].join());
    expect(modes.sort()).toEqual(['0,0', '2,1', '2,1']);
    expect(pageText).toMatch(/<e:skpModelRef[^>]*cameraModified="1"[\s\S]*?height="24"[\s\S]*?key="HLRDrawingStyle" type="3" value="0"/);
    const references = strFromU8(output['references.xml']!);
    expect(references.match(/<r:skpFileReference\b/g)).toHaveLength(1);
    const stale = [...references.matchAll(/<r:imageFileReference\b[^>]*>/g)].map(match => match[0]).filter(tag => tag.includes('type="3"'));
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every(tag => tag.includes('internalTarget=""'))).toBe(true);
    expect(grouped!.image!.viewport?.originalId).toBe('id41');
    const reimported = importSketchUpLayout(exported.bytes).doc.state;
    const cameras = [...reimported.pages.values()][0]!.entityOrder.map(id => [...reimported.pages.values()][0]!.entities.get(id)!.image!.viewport!.camera.scale);
    expect(cameras.map(scale => Math.round(1 / scale))).toEqual([48, 48, 24]);
  });

  it.each(['missing-model', 'unsafe-target'])('reports appearance-only fallback for a %s viewport', async reason => {
    const model = `<e:skpModelRef id="id40">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
      <r:skpFileReference r:id="idModel" /><r:imageFileReference r:id="id2" />
    </e:skpModelRef>`;
    const files = unzipSync(layoutFile(page(model, onLayer('id10', ['id40']))));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>',
      `<r:skpFileReference r:id="idModel" internalTarget="${reason === 'unsafe-target' ? '../model.skp' : 'ref/model.skp'}" /></references>`));
    if (reason === 'missing-model') delete files['ref/model.skp'];
    const { doc } = importSketchUpLayout(zipSync(files));
    const exported = await exportSketchUpLayout(doc.state);
    expect(exported.warnings.some(warning => warning.includes('cached appearance'))).toBe(true);
    const output = unzipSync(exported.bytes);
    expect(strFromU8(output['pages/page1.xml']!)).not.toContain('skpModelRef');
    expect(Object.keys(output).some(path => path.endsWith('.skp'))).toBe(false);
    expect(doc.state.modelArchives?.size).toBe(1);
  });

  it('does not retain complete source packages for imports without model viewports', () => {
    const { doc } = importSketchUpLayout(layoutFile(page('', '')));
    expect(doc.state.modelArchives).toBeUndefined();
  });

  it('places images and viewport renders in their frames with crops', () => {
    const entities = `
      <e:image id="id40">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference>
        <r:imageFileReference r:id="id2" />
      </e:image>
      <e:skpModelRef id="id41">
        <e:placedFileReference>
          <e:rectangleBase x="1" y="1" width="4" height="4" />
          <e:clipMask><e:path id="id42" rotationAngle="0"><e:graphicEntity isClipMask="1" />
            <e:elements>0,1,1,1</e:elements><e:points2f>1,1,3,1,3,3,1,3</e:points2f></e:path></e:clipMask>
        </e:placedFileReference>
        <r:imageFileReference r:id="id2" />
        <r:vectorFileReference r:id="id3" />
      </e:skpModelRef>
      <e:skpModelRef id="id43">
        <e:placedFileReference><e:rectangleBase x="6" y="1" width="1" height="1" /></e:placedFileReference>
      </e:skpModelRef>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id40', 'id41', 'id43']))));
    const [pageState] = [...doc.state.pages.values()];
    const [image, viewport, empty] = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    expect(image!.kind).toBe('image');
    expect(image!.image!.src).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(image!.points.map(inches)).toEqual([[1, 1], [3, 1], [3, 2], [1, 2]]);
    // Vector caches win over raster renders and become an SVG in page coordinates.
    const svg = atob(viewport!.image!.src.replace('data:image/svg+xml;base64,', ''));
    expect(svg).toContain('viewBox="1 1 4 4"');
    expect(svg).toContain('fill="#ff1848"');
    expect(viewport!.image!.clip!.points).toEqual([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]);
    expect(empty!.kind).toBe('path');
    expect(warnings).toContain('a SketchUp viewport without a cached render was shown as an empty frame');
  });

  it('converts placed TIFF pictures to PNG and gives placed SVGs a size to draw at', () => {
    const tiff = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/tiff/${name}`, import.meta.url)));
    const placed = (id: number, ref: string): string => `<e:image id="id${id}">
        <e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1.5" /></e:placedFileReference>
        <r:imageFileReference r:id="${ref}" />
      </e:image>`;
    const svg = '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg height="100%" viewBox="0 0 20 15" width="100%" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="15"/></svg>';
    const files = unzipSync(layoutFile(page([placed(40, 'id4'), placed(41, 'id5'), placed(42, 'id6')].join(''), onLayer('id10', ['id40', 'id41', 'id42'])), '', '1,1,1', ['id90'], '', {
      'ref/scan.tif': tiff('rgb-lzw-predictor.tif'), 'ref/logo.svg': strToU8(svg), 'ref/photo.tif': tiff('jpeg.tif'),
    }));
    files['references.xml'] = strToU8(strFromU8(files['references.xml']!).replace('</references>', '<r:imageFileReference r:id="id4" internalTarget="ref/scan.tif" />' +
      '<r:imageFileReference r:id="id5" internalTarget="ref/logo.svg" /><r:imageFileReference r:id="id6" internalTarget="ref/photo.tif" /></references>'));
    const { doc, warnings } = importSketchUpLayout(zipSync(files));
    const [pageState] = [...doc.state.pages.values()];
    const [scan, logo, photo] = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    const png = Uint8Array.from(atob(scan!.image!.src.replace('data:image/png;base64,', '')), (c) => c.charCodeAt(0));
    expect(new DataView(png.buffer).getUint32(16)).toBe(8);
    expect(scan!.points.map(inches)).toEqual([[1, 1], [3, 1], [3, 2.5], [1, 2.5]]);
    expect(atob(logo!.image!.src.replace('data:image/svg+xml;base64,', ''))).toContain('<svg height="15" viewBox="0 0 20 15" width="20" xmlns=');
    // JPEG-compressed TIFFs are not read: LayOut's missing-picture placeholder (a box and its diagonals) stands in, and the import says why.
    expect(photo!.kind).toBe('path');
    expect(pageState!.entityOrder).toHaveLength(5);
    expect(warnings).toContain('TIFF images compressed with JPEG are not supported');
    expect(warnings).toContain('an image that could not be read was shown as a placeholder');
    expect(warnings.some((warning) => /images of type/.test(warning))).toBe(false);
  });

  it('preserves dashed paths, keeps their arrows as line styles, and splits dimensions', () => {
    const entities = `
      <e:path id="id50" rotationAngle="0">
        <e:graphicEntity shouldFill="0" strokeWidth="1" strokeDashPattern="1" />
        <e:elements>0,1</e:elements><e:points2f>0,0,1,0</e:points2f>
        <e:arrowData startArrowType="3" startArrowSize="4" endArrowType="5" endArrowSize="4" />
      </e:path>
      <e:linearDimension id="id51">
        <e:dimensionText id="id52" anchorType="5" growMode="0">
          <e:placedFileReference><e:rectangleBase x="0" y="2" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('6\\\'27 0&quot;')}</e:rtfTextRep>
        </e:dimensionText>
        <e:dimensionLine id="id53" rotationAngle="0"><e:graphicEntity shouldFill="0" />
          <e:elements>0,1</e:elements><e:points2f>0,3,1,3</e:points2f>
          <e:arrowData startArrowType="13" startArrowSize="3" endArrowType="13" endArrowSize="3" /></e:dimensionLine>
      </e:linearDimension>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id50', 'id51']))));
    const [pageState] = [...doc.state.pages.values()];
    const all = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    const dashes = all.filter((entity) => entity.kind === 'path' && !entity.closed && entity.points[0]![1] === 0);
    expect(dashes).toHaveLength(1);
    expect(dashes[0]!.points.map(inches)).toEqual([[0, 0], [1, 0]]);
    // LayOut 2027 draws its dash 12 weights on, 6 off.
    expect(dashes[0]!.style!.strokeDashMm).toEqual([12, 6].map(length => length * 25.4 / 72));
    // Arrow code 3 is LayOut's open 90° arrow; code 5 is a filled circle. Both stay on the line.
    expect(dashes[0]!.style).toMatchObject({ startArrow: { type: 'open-arrow-90', sizePt: 4 }, endArrow: { type: 'filled-circle', sizePt: 4 } });
    const dot = layoutPathArrows(dashes[0]!.points, dashes[0]!.handles, false, dashes[0]!.style).shapes.find(shape => shape.filled)!;
    expect(dot.points.every(([x, y]) => Math.abs(Math.hypot(x - 25.4, y) - 4 / 72 * 25.4) < 1e-9)).toBe(true);
    expect(all.find((entity) => entity.kind === 'text')!.text!.content).toBe('6\' 0"');
    // The fallback dimension line keeps its two slash ticks as arrow styles.
    const dimensionLines = all.filter((entity) => entity.points[0]![1] !== 0 && entity.kind === 'path');
    expect(dimensionLines).toHaveLength(1);
    expect(dimensionLines[0]!.style).toMatchObject({ startArrow: { type: 'slash-right', sizePt: 3 }, endArrow: { type: 'slash-right', sizePt: 3 } });
    expect(warnings).toContain('dimensions were imported as lines and text');
  });

  it('draws square, diamond, star and T arrowheads as LayOut does and stops lines behind open ones', () => {
    // Arrow size 9 is 1/8 in per unit.
    const u = 0.125, path = (id: string, points: string, start: number, end: number) => `
      <e:path id="${id}" rotationAngle="0">
        <e:graphicEntity shouldFill="0" strokeWidth="1" />
        <e:elements>0,1</e:elements><e:points2f>${points}</e:points2f>
        <e:arrowData startArrowType="${start}" startArrowSize="9" endArrowType="${end}" endArrowSize="9" />
      </e:path>`;
    const entities = path('id60', '0,0,2,0', 8, 10) + path('id61', '0,1,2,1', 7, 9) + path('id62', '0,2,1,3', 12, 11);
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id60', 'id61', 'id62']))));
    const [pageState] = [...doc.state.pages.values()];
    // Each line keeps its arrows as styles; draw them as the painter does.
    const all = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!).flatMap(entity => {
      const arrows = layoutPathArrows(entity.points, entity.handles, entity.closed, entity.style);
      return [{ points: arrows.points, closed: entity.closed, filled: false }, ...arrows.shapes];
    });
    // Three lines; square, diamond, filled square, filled diamond, the T's bar and the star's three strokes.
    expect(all).toHaveLength(3 + 8);
    const at = (...points: [number, number][]) => all.find(entity =>
      entity.points.length === points.length && entity.points.every((point, i) => inches(point).every((v, k) => Math.abs(v - points[i]![k]!) < 1e-6)));
    expect(warnings.some(warning => warning.startsWith('arrowhead style'))).toBe(false);
    // Open square (centered on the start) and open diamond (point at the end, 3 units long): the line stops at their backs.
    expect(at([u, 0], [2 - 3 * u, 0])).toBeTruthy();
    expect(at([-u, -u], [-u, u], [u, u], [u, -u])).toMatchObject({ closed: true, filled: false });
    expect(at([2, 0], [2 - 1.5 * u, -u], [2 - 3 * u, 0], [2 - 1.5 * u, u])).toMatchObject({ closed: true, filled: false });
    // Filled ones keep the line's true ends.
    expect(at([0, 1], [2, 1])).toBeTruthy();
    expect(at([-u, 1 - u], [-u, 1 + u], [u, 1 + u], [u, 1 - u])).toMatchObject({ closed: true, filled: true });
    expect(at([2, 1], [2 - 1.5 * u, 1 - u], [2 - 3 * u, 1], [2 - 1.5 * u, 1 + u])).toMatchObject({ filled: true });
    // On a 45° line: the T's bar crosses the start, and the star keeps one arm horizontal.
    const d = u * Math.SQRT1_2, s = u * Math.sqrt(3) / 2;
    expect(at([0, 2], [1, 3])).toBeTruthy();
    expect(at([d, 2 - d], [-d, 2 + d])).toMatchObject({ closed: false });
    expect(at([1 - u, 3], [1 + u, 3])).toBeTruthy();
    expect(at([1 - u / 2, 3 - s], [1 + u / 2, 3 + s])).toBeTruthy();
    expect(at([1 + u / 2, 3 - s], [1 - u / 2, 3 + s])).toBeTruthy();
  });

  it('keeps a dimension whose line is at another angle as an editable rotated dimension', () => {
    // Measured points 2 x 1 in apart; the dimension line runs at 30 degrees, parallel to neither.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const entities = `
      <e:linearDimension id="id90">
        <ld:unitsInfo format="0" unit="0" />
        <e:dimensionText id="id91" anchorType="5" growMode="0">
          <e:placedFileReference><e:rectangleBase x="1" y="1" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('&lt;&gt;')}</e:rtfTextRep>
        </e:dimensionText>
        <ld:startConnectionPoint x="1" y="3" /><ld:endConnectionPoint x="3" y="4" />
        <e:dimensionLine id="id92"><e:graphicEntity shouldFill="0" />
          <e:elements>0,1</e:elements><e:points2f>1,2,${1 + 2 * c},${2 + 2 * s}</e:points2f></e:dimensionLine>
      </e:linearDimension>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id90']))));
    expect(warnings).not.toContain('dimensions were imported as lines and text');
    const [entity] = [...doc.state.pages.get(doc.state.pageOrder[0]!)!.entities.values()];
    expect(entity!.kind).toBe('dimension');
    expect(entity!.dimension!.alignment).toBe('rotated');
    expect(entity!.dimension!.angleDeg).toBeCloseTo(30, 6);
    // The value is the separation along the line: 2 cos 30° + 1 sin 30° inches.
    expect(entity!.dimension!.cachedValueMm / 25.4).toBeCloseTo(2 * c + s, 6);
    expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(doc.state.pageOrder[0]!)).toEqual(doc.state.pages.get(doc.state.pageOrder[0]!));
  });

  it('keeps dimension ends and label tips LayOut connects to path and rectangle vertices attached', () => {
    const dimension = (id: string, [ax, ay]: [number, number], [bx, by]: [number, number]) => `
      <e:linearDimension id="${id}">
        <e:dimensionText id="${id}t" anchorType="5" growMode="0">
          <e:placedFileReference><e:rectangleBase x="0" y="0" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('&lt;&gt;')}</e:rtfTextRep>
        </e:dimensionText>
        <ld:startConnectionPoint x="${ax}" y="${ay}" /><ld:endConnectionPoint x="${bx}" y="${by}" />
        <e:dimensionLine id="${id}l"><e:graphicEntity shouldFill="0" />
          <e:elements>0,1</e:elements><e:points2f>${ax},${ay - 0.5},${bx},${by - 0.5}</e:points2f></e:dimensionLine>
      </e:linearDimension>`;
    const entities = `
      <e:path id="id40"><e:elements>0,1,1</e:elements><e:points2f>1,1,4,1,4,3</e:points2f></e:path>
      <e:rectangle id="id41"><e:rectangleBase x="5" y="1" width="2" height="1" /></e:rectangle>
      ${dimension('id50', [1, 1], [4, 1])}${dimension('id51', [7, 1], [7, 2])}${dimension('id52', [2.5, 1], [4, 3])}
      <e:label id="id60" connectionType="1" extensionLineLength="0"><e:bodyOffset x="0" y="0" />
        <e:leaderLine id="id61" wantInternalPoints="0"><e:elements>0,1</e:elements><e:points2f>4,3,5,4</e:points2f></e:leaderLine>
        <e:labelText id="id62" anchorType="5" growMode="0"><e:placedFileReference><e:rectangleBase x="5" y="3.9" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('Tip')}</e:rtfTextRep></e:labelText></e:label>
      <e:label id="id65" connectionType="1" extensionLineLength="0"><e:bodyOffset x="0" y="0" />
        <e:leaderLine id="id66" wantInternalPoints="0"><e:elements>0,1</e:elements><e:points2f>2,2,3,4</e:points2f></e:leaderLine>
        <e:labelText id="id67" anchorType="5" growMode="0"><e:placedFileReference><e:rectangleBase x="3" y="3.9" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF('Moved off')}</e:rtfTextRep></e:labelText></e:label>`;
    const point = (type: number, x: number, y: number, ref: string, index = 0) =>
      `<connectionPoint ver="2" type="${type}" x="${x}" y="${y}" dirx="0" diry="0" param1="${index}" param2="0" l:ref="${ref}" />`;
    const connection = (target: string, end: string) => `<connection>${target}${end}</connection>`;
    // LayOut 3 and 2014 keep each page's connections at the end of the page.
    const connections = `<connectionManager>
      ${connection(point(1, 1, 1, 'id40'), '<dimensionConnectionPoint l:ref="id50" componentId="5" />')}
      ${connection(point(1, 4, 1, 'id40', 1), '<dimensionConnectionPoint l:ref="id50" componentId="6" />')}
      ${connection(point(1, 7, 1, 'id41', 1), '<dimensionConnectionPoint l:ref="id51" componentId="5" />')}
      ${connection(point(1, 7, 2, 'id41', 2), '<dimensionConnectionPoint l:ref="id51" componentId="6" />')}
      ${connection(point(8, 2.5, 1, 'id40', 0.5), '<dimensionConnectionPoint l:ref="id52" componentId="5" />')}
      ${connection('<sketchupConnectionPoint l:ref="id99" pointType="2"><paperPoint x="4" y="3" /><modelPoint x="0" y="0" z="0" /></sketchupConnectionPoint>', '<dimensionConnectionPoint l:ref="id52" componentId="6" />')}
      ${connection(point(1, 4, 3, 'id40', 2), '<labelConnectionPoint l:ref="id60" componentIndex="4294967295" />')}
      ${connection(point(16, 4, 3, 'id62'), point(1, 4, 3, 'id61'))}
      ${connection(point(1, 1, 1, 'id40'), '<labelConnectionPoint l:ref="id65" componentIndex="4294967295" />')}
    </connectionManager>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id40', 'id41', 'id50', 'id51', 'id52', 'id60', 'id65'])) + connections));
    const pageState = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = pageState.entityOrder.map((id) => pageState.entities.get(id)!);
    // A path without a style is filled, so the open polyline imports as its fill and its stroke.
    const [, polyline, rectangle] = all.filter((entity) => entity.kind === 'path');
    const [sides, corner, loose] = all.filter((entity) => entity.kind === 'dimension');
    expect(sides!.dimension!.anchors).toEqual([{ entityId: polyline!.id, pointIndex: 0, pointCount: 3 }, { entityId: polyline!.id, pointIndex: 1, pointCount: 3 }]);
    // Found by position: the rectangle's second and third corners.
    const at = (index: number | undefined) => index === undefined ? null : rectangle!.points[index]!.map((v) => Math.round(v / 25.4 * 1e6) / 1e6);
    expect(corner!.dimension!.anchors.map((anchor) => anchor && at(anchor.pointIndex))).toEqual([[7, 1], [7, 2]]);
    expect(corner!.dimension!.anchors.every((anchor) => anchor?.entityId === rectangle!.id && anchor.pointCount === 4)).toBe(true);
    // A point along a segment attaches there; a model-space point stays where it is.
    expect(loose!.dimension!.anchors[0]).toMatchObject({ entityId: polyline!.id, pointIndex: 0, pointCount: 3 });
    expect(loose!.dimension!.anchors[0]!.t).toBeCloseTo(0.5, 9);
    expect(loose!.dimension!.anchors[1]).toBeNull();
    const [tip, movedOff] = all.filter((entity) => entity.kind === 'label');
    expect(tip!.labelAnchor).toEqual({ entityId: polyline!.id, pointIndex: 2, pointCount: 3 });
    // LayOut keeps this connection but draws the arrow away from its vertex, so it stays where it is.
    expect(movedOff!.labelAnchor).toBeUndefined();
    expect(warnings).toContain('dimensions and labels LayOut shows away from the vertex they are connected to keep their points but are no longer attached');
    expect(warnings).toContain('dimensions and labels attached to model views keep their points but are no longer attached');
    // Moving the polyline's first vertex takes the attached dimension end with it.
    const moved = structuredClone(doc.state);
    const page2 = moved.pages.get(moved.pageOrder[0]!)!;
    page2.entities.get(polyline!.id)!.points[0] = [0, 25.4];
    refreshLayoutDimensions(moved);
    expect(page2.entities.get(sides!.id)!.points[0]).toEqual([0, 25.4]);
  });

  it('keeps drawing scale, feet-and-inch formats, and custom text of native dimensions', () => {
    // A horizontal dimension measuring `paper` inches, with LayOut's attributes and the text it last showed.
    const dimension = (id: string, paper: number, attrs: string, units: string, shown: string): string => `
      <e:linearDimension id="${id}" ${attrs}>
        <ld:unitsInfo ${units} />
        <e:dimensionText id="${id}t" anchorType="5" growMode="0">
          <e:placedFileReference><e:rectangleBase x="0" y="2" width="1" height="0.2" /></e:placedFileReference>
          <e:rtfTextRep>${RTF(shown.replace(/'/g, "\\'27").replace(/"/g, '&quot;'))}</e:rtfTextRep>
        </e:dimensionText>
        <ld:startConnectionPoint x="1" y="3" /><ld:endConnectionPoint x="${1 + paper}" y="3" />
        <e:dimensionLine id="${id}l" rotationAngle="0"><e:graphicEntity shouldFill="0" />
          <e:elements>0,1</e:elements><e:points2f>1,2.5,${1 + paper},2.5</e:points2f></e:dimensionLine>
      </e:linearDimension>`;
    const cases = [
      dimension('id60', 3.0625, 'autoScale="1" scale="0.020833333333333332" useInModelDistance="0" dimensionString="&lt;&gt;"',
        'format="1" unit="0" precision="4" suppressUnitDisplay="0" suppressDashesDisplay="1"', '&lt;&gt;'),
      dimension('id61', 1.5, 'autoScale="0" scale="1" dimensionString="&lt;&gt; RO"', 'format="3" unit="0" precision="2" suppressUnitDisplay="1" suppressDashesDisplay="0"', '1-1/2 RO'),
      dimension('id62', 36, 'scale="1" dimensionString="&lt;&gt;"', 'format="2" unit="1" precision="2"', "3'"),
      dimension('id63', 1, 'scale="1" dimensionString="&lt;&gt;"', 'format="0" unit="5" precision="0"', '72 pt'),
      dimension('id64', 2, 'scale="0.5" autoText="1"', 'format="1" unit="0" precision="6"', `4"`),
      dimension('id65', 2, 'scale="1" autoText="0"', 'format="1" unit="0" precision="6"', `51'-0" (OUT TO OUT)`),
      dimension('id66', 2, 'scale="1"', 'format="0" unit="1" precision="2"', `45.00'PL`),
      // Measured through a model viewport: `scale` is not used, the shown value implies 1:48.
      dimension('id67', 3, 'autoScale="1" scale="1" useInModelDistance="1" autoText="1"', 'format="1" unit="0" precision="4" suppressDashesDisplay="0"', `12'-0"`),
      dimension('id68', 0.5, 'autoScale="1" scale="1" useInModelDistance="1" dimensionString="&lt;&gt; CLR"', 'format="0" unit="2" precision="0"', '1270,0 CLR'),
      dimension('id69', 2, 'autoScale="1" scale="0.5" useInModelDistance="1" dimensionString="&lt;&gt;"', 'format="0" unit="0" precision="1"', '&lt;&gt;'),
      // Custom text never shows the measurement, so its scale is not needed; line breaks match across template and body.
      dimension('id70', 2, 'scale="1" useInModelDistance="1" autoText="0"', 'format="1" unit="0" precision="4"', `20'-1"`),
      dimension('id71', 1, 'scale="1" useInModelDistance="1" dimensionString="&lt;&gt;&#x0D;&#x0A;RAFTER"', 'format="1" unit="0" precision="4"', '4 1/2"\\par RAFTER'),
      dimension('id72', 2, 'scale="1" autoText="0"', 'format="1" unit="0" precision="4"', ' '),
      // LayOut 3 wrote no suppressDashesDisplay and shows feet and inches without a dash.
      dimension('id73', 0.25, 'scale="0.020833333333333332" autoText="1"', 'format="1" unit="0" precision="2"', `1' 0"`),
    ];
    const ids = cases.map((_, index) => `id${60 + index}`);
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(cases.join(''), onLayer('id10', ids))));
    const pageState = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const dims = pageState.entityOrder.map(id => pageState.entities.get(id)!).filter(entity => entity.dimension).map(entity => entity.dimension!);
    expect(dims).toHaveLength(14);
    expect(dims[0]).toMatchObject({ format: 'architectural', units: 'inch', precision: 4, showDashes: false, scale: 0.020833333333333332, text: '<>' });
    expect(dims.map(formatLinearDimension)).toEqual([
      `12' 3"`, '1-1/2 RO', `3'`, '72 pt', '4"', `51'-0" (OUT TO OUT)`, `45.00'PL`, `12'-0"`, '1270 mm CLR', '4.0"',
      `20'-1"`, '4 1/2"\nRAFTER', '', `1' 0"`,
    ]);
    expect(dims[11]!.scale).toBeCloseTo(1 / 4.5, 12);
    expect(dims[2]).toMatchObject({ format: 'engineering', units: 'ft' });
    expect(dims[3]).not.toHaveProperty('format');
    expect(dims[4]!.text).toBe('<>');
    expect(dims[7]!.scale).toBeCloseTo(1 / 48, 12);
    expect(dims[8]!.scale).toBeCloseTo(0.5 / (1270 / 25.4), 12);
    expect(warnings).toContain('dimensions measured in a model viewport without a saved value show their stored scale');
    expect(warnings.some(warning => warning.includes('imported as decimal'))).toBe(false);
  });

  it('imports native dimensions and labels from a file LayOut 2027 wrote', () => {
    const { doc, warnings } = importSketchUpLayout(fixture('layout2027-annotations.layout'));
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = page.entityOrder.map((id) => page.entities.get(id)!);
    const dimensions = all.filter((entity) => entity.kind === 'dimension');
    expect(dimensions).toHaveLength(8);
    const [diagonal, , custom] = dimensions;
    expect(diagonal!.points[0]![0]).toBeCloseTo(25.4, 9);
    expect(diagonal!.points[1]![0]).toBeCloseTo(76.2, 9);
    expect(diagonal!.points[1]![1]).toBeCloseTo(50.8, 9);
    expect(diagonal!.dimension).toMatchObject({ alignment: 'aligned', units: 'inch', precision: 2, endpoint: 'tick', text: '<>' });
    expect(diagonal!.dimension!.cachedValueMm).toBeCloseTo(Math.sqrt(5) * 25.4, 6);
    expect(custom!.dimension!.text).toBe('2.00"');
    const labels = all.filter((entity) => entity.kind === 'label');
    expect(labels.map((label) => [label.text!.content, label.text!.leader])).toEqual([['Straight', 'straight'], ['Elbow', 'elbow'], ['Bounded right', 'elbow']]);
    expect(labels[0]!.points[2]![0]).toBeCloseTo(25.4, 9);
    expect(labels[0]!.points[2]![1]).toBeCloseTo(152.4, 9);
    // This angular dimension's first measured point is its own vertex, so it cannot be rebuilt.
    expect(warnings).toContain('dimensions were imported as lines and text');
  });

  it('attaches dimension ends and label tips LayOut connected along straight and curved segments', () => {
    // LayOut 2027 connected these through its Ruby API: a polyline (1,1)-(5,1)-(5,4), a rectangle from (7,4) 2 × 1 in,
    // a half circle about (3,6), and text at (7,1).
    const { doc, warnings } = importSketchUpLayout(fixture('layout2027-connections.layout'));
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = page.entityOrder.map((id) => page.entities.get(id)!);
    const lookup = (id: number) => page.entities.get(id);
    const pathAt = (first: [number, number]) => all.findLast((entity) => entity.kind === 'path' &&
      entity.points.some((point) => inches(point)[0] === first[0] && inches(point)[1] === first[1]))!;
    const line = pathAt([5, 4]), rect = pathAt([9, 5]);
    const [seg, toText] = all.filter((entity) => entity.kind === 'dimension');
    // Along the polyline's first segment (type 2) and second (type 8).
    expect(seg!.dimension!.anchors[0]).toMatchObject({ entityId: line!.id, pointIndex: 0 });
    expect(seg!.dimension!.anchors[0]!.t).toBeCloseTo(0.25, 6);
    expect(seg!.dimension!.anchors[1]).toMatchObject({ entityId: line!.id, pointIndex: 1 });
    expect(seg!.dimension!.anchors[1]!.t).toBeCloseTo(0.5, 6);
    expect(resolveLayoutDimension(seg!, lookup)!.points.map(inches)).toEqual([[2, 1], [5, 2.5]]);
    // A vertex stays a vertex; a text corner is not attached.
    expect(toText!.dimension!.anchors[0]).toEqual({ entityId: line!.id, pointIndex: 0, pointCount: 3 });
    expect(toText!.dimension!.anchors[1]).toBeNull();
    expect(warnings).toContain('dimensions and labels attached to text, pictures or view frames keep their points but are no longer attached');
    const tips = all.filter((entity) => entity.kind === 'label').map((label) => label.labelAnchor);
    // Along the polyline, and along the rectangle's bottom and top edges.
    expect(tips[0]).toMatchObject({ entityId: line!.id, pointIndex: 0 });
    expect(tips.filter((tip) => tip?.entityId === rect!.id && tip.t !== undefined)).toHaveLength(2);
    for (const label of all.filter((entity) => entity.labelAnchor))
      expect(inches(resolveLayoutLabelAnchor(label, lookup)!)).toEqual(inches(label.points[2]!));

    // A cubic: the curve parameter (type 4). Points inside text or a rectangle (type 32) are not attached.
    const curved = importSketchUpLayout(fixture('layout2027-connections-curve.layout'));
    const curvePage = curved.doc.state.pages.get(curved.doc.state.pageOrder[0]!)!;
    const curve = [...curvePage.entities.values()].findLast((entity) => entity.kind === 'path' && entity.handles)!;
    const along = [...curvePage.entities.values()].filter((entity) => entity.labelAnchor?.entityId === curve.id);
    expect(along.map((label) => label.labelAnchor!.pointIndex)).toEqual([1, 1, 1]);
    along.map((label) => label.labelAnchor!.t!).forEach((t, i) => expect(t).toBeCloseTo([0.2, 0.3, 0.7][i]!, 5));
    expect(curved.warnings.some((w) => w.startsWith('dimensions and labels attached to points inside text or shapes keep their points'))).toBe(true);
  });

  it('sets label text against its leader as LayOut does, moving a stale box', () => {
    const label = (id: number, connection: number, anchor: number, rect: string, points: string, rtf: string) =>
      `<e:label id="id${id}" connectionType="${connection}" extensionLineLength="0"><e:bodyOffset x="0" y="0" />
        <e:leaderLine id="id${id + 1}" wantInternalPoints="0"><e:elements>0,1,1</e:elements><e:points2f>${points}</e:points2f>
          <e:arrowData startArrowType="5" startArrowSize="5" endArrowType="0" endArrowSize="5" /></e:leaderLine>
        <e:labelText id="id${id + 2}" anchorType="${anchor}" growMode="0"><e:placedFileReference><e:rectangleBase ${rect} /></e:placedFileReference>
          <e:rtfTextRep>{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil Arial;}}\\f0\\fs20 ${rtf}\\par}</e:rtfTextRep></e:labelText></e:label>`;
    // forum-204780: the box ends 0.385 in below the leader, but LayOut draws the last line's middle on it.
    const stale = label(60, 10, 10, 'x="1.0360858" y="2.2169719" width="1.6638889" height="1.8520833"',
      '3.705927,0.6757834,3.111473,3.683638,2.703447,3.683638', 'WAND 1\\par\\par 4.2m x 16\\par 67.2 x 15.6W');
    // A consistent first-line connection: the box's top is half a line above the leader.
    const top = label(70, 9, 5, 'x="5" y="5" width="1" height="0.3"', '4,4,4.5,5.08,5,5.08', 'First\\par Second');
    const { doc } = importSketchUpLayout(layoutFile(page(stale + top, onLayer('id10', ['id60', 'id70']))));
    const pageState = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const [moved, kept] = pageState.entityOrder.map((id) => pageState.entities.get(id)!);
    const halfLine = 10 * 1.15 / 2 * 25.4 / 72, end = 3.683638 * 25.4;
    expect(moved!.points[1]![1]).toBeCloseTo(end + halfLine, 6);
    expect(moved!.points[1]![1] - moved!.points[0]![1]).toBeCloseTo(1.8520833 * 25.4, 6);
    expect(moved!.text!.vertical).toBe('bottom');
    // No bend where LayOut has none: the leader meets the text at its own end.
    const leader = layoutLabelLeader(moved!)!;
    expect(leader.start[1]).toBeCloseTo(end, 6);
    expect(leader.bend[1]).toBeCloseTo(end, 6);
    expect(kept!.points[0]![1]).toBeCloseTo(5 * 25.4, 9);
    expect(kept!.text!.leaderOffsetMm).toBeCloseTo((5.08 - 5.15) * 25.4, 6);
    expect(layoutLabelLeader(kept!)!.start[1]).toBeCloseTo(5.08 * 25.4, 6);
  });

  it('imports images, styled and rotated text, arrows, a dimension, and a label LayOut 2027 wrote', () => {
    const { doc } = importSketchUpLayout(fixture('layout2027-content.layout'));
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    const all = page.entityOrder.map((id) => page.entities.get(id)!);
    expect(all.filter((entity) => entity.kind === 'image')).toHaveLength(2);
    // The crop LayOut wrote is an ellipse (x 4.25–5.75, y 1.1–1.9 in) inside a 2 × 1 in frame at (4, 1).
    const cropped = all.find((entity) => entity.kind === 'image' && entity.image!.clip)!;
    const xs = cropped.image!.clip!.points.map(([u]) => u), ys = cropped.image!.clip!.points.map(([, v]) => v);
    expect(Math.min(...xs)).toBeCloseTo(0.125, 6);
    expect(Math.max(...xs)).toBeCloseTo(0.875, 6);
    expect(Math.min(...ys)).toBeCloseTo(0.1, 6);
    expect(Math.max(...ys)).toBeCloseTo(0.9, 6);
    const styled = all.find((entity) => entity.text?.content === 'Bold italic red Times')!;
    expect(styled.text!.spans!.find((span) => span.bold)).toMatchObject({ start: 0, end: 4 });
    expect(all.find((entity) => entity.text?.content === 'Rotated 90')!.text!.rotationDeg).toBe(90);
    const dimension = all.find((entity) => entity.kind === 'dimension')!;
    expect(dimension.dimension!.cachedValueMm).toBeCloseTo(50.8, 6);
    const label = all.find((entity) => entity.kind === 'label')!;
    expect(label.text).toMatchObject({ content: 'Label text', leader: 'straight' });
    expect(label.points[2]![0]).toBeCloseTo(203.2, 9);
    expect(label.points[2]![1]).toBeCloseTo(25.4, 9);
    // The arrowed line starts with a filled circle (code 5) and ends in a filled triangle (code 1).
    expect(all.find((entity) => entity.style?.endArrow)!.style).toMatchObject({ startArrow: { type: 'filled-circle' }, endArrow: { type: 'filled-triangle' } });
  });

  it('draws rounded, lozenge, and bulged rectangles and fills open filled paths as LayOut does', () => {
    const rect = (shape: number, rounding: number, x: number) =>
      `<e:rectangle id="id${70 + shape}" shape="${shape}" rounding="${rounding}"><e:rectangleBase x="${x}" y="1" width="1.6" height="1.2" /></e:rectangle>`;
    const openFilled = `<e:path id="id80" rotationAngle="0"><e:graphicEntity fillColor="4278190335" />
      <e:elements>0,1,1</e:elements><e:points2f>0,5,2,5,1,6</e:points2f></e:path>`;
    const scale = `<e:group><e:scaleContext name="1:96" scale="0.0104" unitType="0"><ld:unitsInfo format="3" unit="0" /></e:scaleContext></e:group>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(rect(1, 0.3, 0) + rect(2, 0, 2) + rect(3, 0.3, 4) + openFilled + scale,
      onLayer('id10', ['id71', 'id72', 'id73', 'id80']))));
    expect(warnings.join()).not.toMatch(/scaleContext|rectangle variant/);
    const [pageState] = [...doc.state.pages.values()];
    const [rounded, lozenge, bulged, fill, stroke] = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    const bounds = (e: { points: [number, number][] }) => [Math.min(...e.points.map((p) => p[0])), Math.max(...e.points.map((p) => p[0]))].map((v) => Math.round(v / 25.4 * 1000) / 1000);
    expect(rounded!.points).toHaveLength(8);
    // The lozenge's ends are semicircles on the short (1.2 in) sides, so its straight edges start 0.6 in in.
    expect(lozenge!.points[0]![0] / 25.4).toBeCloseTo(2.6, 6);
    // The bulged rectangle's arcs reach its bounds (4–5.6 in) at their apexes; the straight edges are
    // shortened by the 0.3 in bulge, so the top edge runs from x 5.3 back to 4.3.
    expect(bounds(bulged!)).toEqual([4, 5.6]);
    expect(bulged!.points[0]![0] / 25.4).toBeCloseTo(5.3, 6);
    expect(bulged!.points.at(-1)![0] / 25.4).toBeCloseTo(4.3, 6);
    expect(fill).toMatchObject({ closed: true, style: { fillColor: '#ff0000', strokeColor: '#00000000' } });
    expect(stroke).toMatchObject({ closed: false, style: { fillColor: null, strokeColor: '#000000' } });
  });

  it('imports LayOut 2015 and earlier documents, whose layer instances hold their entities inline', () => {
    const path = (id: string, x: number) => `<e:path id="${id}" rotationAngle="0"><e:graphicEntity shouldFill="0" />
      <e:elements>0,1</e:elements><e:points2f>${x},1,${x + 1},1</e:points2f></e:path>`;
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<layoutDocument xmlns="http://sketchup.google.com/schemas/layout/1.0/layoutdocument" ${NS}>
  <ld:pageInfo width="11" height="8.5" leftMargin="0.5" rightMargin="0.5" topMargin="0.5" bottomMargin="0.5" paperColor="4294967295" />
  <ld:layerManager id="id3">
    <ld:layerDefinition ver="2" id="id4" name="On Every Page" visible="1" locked="0" shared="1">
      <ld:layerInstance id="id5"><ld:layerDefinition ver="2" l:ref="id4" /><ld:entityList>${path('id40', 5)}</ld:entityList></ld:layerInstance>
    </ld:layerDefinition>
    <ld:layerDefinition ver="2" id="id6" name="Default" visible="1" locked="0" shared="0" />
    <ld:currentLayerDefinition ver="2" l:ref="id6" />
  </ld:layerManager>
  <ld:pageManager id="id7"><ld:pageRef r:id="id8" id="id9" name="Page 1" showMasterLayers="1" /></ld:pageManager>
</layoutDocument>`;
    const pageXml = `<?xml version="1.0" ?><page xmlns="http://sketchup.google.com/schemas/layout/1.0/page" ${NS}>
  <layerInstanceManager ver="1" id="id25" currentLayer="id6">
    <ld:layerInstance ver="1" l:ref="id5" />
    <ld:layerInstance id="id10"><ld:layerDefinition ver="2" l:ref="id6" /><ld:entityList>${path('id26', 1)}${path('id27', 3)}</ld:entityList></ld:layerInstance>
  </layerInstanceManager>
</page>`;
    const references = `<?xml version="1.0" ?><references xmlns="http://sketchup.google.com/schemas/layout/1.0/references" xmlns:r="http://sketchup.google.com/schemas/layout/1.0/references">
  <r:pageFileReference r:id="id8" internalTarget="pages/page8.xml" /></references>`;
    const { doc, warnings } = importSketchUpLayout(zipSync({
      'document.xml': strToU8(document), 'references.xml': strToU8(references), 'pages/page8.xml': strToU8(pageXml),
    }));
    expect(warnings).toEqual([]);
    const [pageState] = [...doc.state.pages.values()];
    const inches = (mm: number) => Math.round(mm / 25.4 * 1e6) / 1e6;
    expect(pageState!.entityOrder.map((id) => inches(pageState!.entities.get(id)!.points[0]![0]))).toEqual([1, 3]);
    expect([...doc.state.sharedEntities.values()].map((entity) => inches(entity.points[0]![0]))).toEqual([5]);
  });

  it('paints a viewport\'s model background behind its cached render when Background is on', () => {
    const viewport = (id: string, display: string) => `<e:skpModelRef id="${id}" displayBackground="${display}">
      <e:placedFileReference><e:rectangleBase x="1" y="1" width="4" height="4" /></e:placedFileReference>
      <e:renderingOptions><e:entry key="BackgroundColor" type="3" value="-3552052" /></e:renderingOptions>
      <r:imageFileReference r:id="id2" /></e:skpModelRef>`;
    const { doc } = importSketchUpLayout(layoutFile(page(viewport('id60', '1') + viewport('id61', '0'), onLayer('id10', ['id60', 'id61']))));
    const [pageState] = [...doc.state.pages.values()];
    const all = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    // The first viewport gets its gray background (−3552052 = 0xFFC9CCCC, #ccccc9) under the picture; the second has none.
    expect(all.map((e) => e.kind)).toEqual(['path', 'image', 'image']);
    expect(all[0]).toMatchObject({ closed: true, style: { fillColor: '#ccccc9', strokeColor: '#00000000' } });
  });

  it('draws a filled or stroked text box as a rectangle behind its text', () => {
    const text = (id: string, graphic: string) => `<e:rtfText id="${id}" anchorType="48" growMode="1"><e:placedFileReference>
      <e:rectangleBase x="1" y="1" width="2" height="0.5">${graphic}</e:rectangleBase></e:placedFileReference>
      <e:rtfTextRep>{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil Arial;}}\\pard\\qc\\f0\\fs20 Header\\par}</e:rtfTextRep></e:rtfText>`;
    const { doc } = importSketchUpLayout(layoutFile(page(
      text('id70', '<e:graphicEntity fillColor="4293313966" />') + text('id71', '<e:graphicEntity shouldFill="0" shouldStroke="0" />'),
      onLayer('id10', ['id70', 'id71']))));
    const [pageState] = [...doc.state.pages.values()];
    const all = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    // The first box is filled light blue and stroked with LayOut's default 1 pt black; the second has no box.
    expect(all.map((e) => e.kind)).toEqual(['path', 'text', 'text']);
    expect(all[0]).toMatchObject({ closed: true, style: { fillColor: '#aec5e6', strokeColor: '#000000', strokeWeightPt: 1 } });
  });

  it('maps macOS PostScript font names to families and styles', () => {
    const text = (font: string, id: number) => `<e:rtfText id="id${id}" anchorType="5" growMode="0"><e:placedFileReference><e:rectangleBase x="0" y="${id - 80}" width="1" height="0.2" /></e:placedFileReference>
      <e:rtfTextRep>{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 ${font};}}\\pard\\f0\\fs20 Text\\par}</e:rtfTextRep></e:rtfText>`;
    const fonts = ['ArialMT', 'Verdana-Bold', 'Georgia-Italic', 'Arial-BoldMT', 'TimesNewRomanPSMT', 'Arial-Black', 'GillSans', 'Comic Sans MS'];
    const { doc } = importSketchUpLayout(layoutFile(page(fonts.map((font, i) => text(font, 81 + i)).join(''), onLayer('id10', fonts.map((_, i) => `id${81 + i}`)))));
    const [pageState] = [...doc.state.pages.values()];
    expect(pageState!.entityOrder.map((id) => pageState!.entities.get(id)!.text!).map((t) => [t.fontFamily, t.bold, t.italic])).toEqual([
      ['Arial', false, false], ['Verdana', true, false], ['Georgia', false, true], ['Arial', true, false],
      ['Times New Roman', false, false], ['Arial Black', false, false], ['Gill Sans', false, false], ['Comic Sans MS', false, false],
    ]);
  });

  it('imports tables as native tables with sizes, cell fills, per-line strokes, and auto-text', () => {
    const cell = (index: number, x: number, y: number, fill: string, body: string, sequence = '') =>
      `<e:cell_${index}><e:rtfText id="id${200 + index}" anchorType="48" growMode="1" ${sequence}><e:placedFileReference>
        <e:rectangleBase x="${x}" y="${y}" width="1" height="0.25"><e:graphicEntity ${fill} shouldStroke="0" /></e:rectangleBase>
      </e:placedFileReference><e:rtfTextRep>{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Verdana;}}\\pard\\qc\\f0\\fs20 ${body}\\par}</e:rtfTextRep></e:rtfText></e:cell_${index}>`;
    const edge = (kind: string, index: number, points: string, style: string) =>
      `<e:${kind}_edge_${index}><e:path id="id${210 + index}" rotationAngle="0"><e:graphicEntity shouldFill="0" ${style} />
        <e:elements>0,1</e:elements><e:points2f>${points}</e:points2f></e:path></e:${kind}_edge_${index}>`;
    const table = `<e:table id="id199" rowCount="2" columnCount="2" height_0="0.25" height_1="0.75" width_0="1.5" width_1="0.5">
      <e:rectangleBase x="0" y="0" width="2" height="1"><e:graphicEntity shouldFill="0" strokeWidth="0.6" /></e:rectangleBase>
      ${cell(0, 0, 0, 'fillColor="4278190080"', 'Sheet #')}${cell(1, 1.5, 0, 'fillColor="4278190080"', 'Sheet Name')}
      ${cell(2, 0, 0.25, 'shouldFill="0"', '&lt;Seq&gt;', 'sequenceIndex="1" sequenceAutoTextDef="Seq"')}${cell(3, 1.5, 0.25, '', '&lt;PageName(1)&gt; / &lt;Seq(4)&gt;')}
      ${edge('row', 0, '0,0.25,2,0.25', 'strokeWidth="0.5"')}${edge('column', 0, '1.5,0,1.5,1', 'strokeColor="4278190335"')}
    </e:table>`;
    const sequence = '<ld:autoTextDefinition name="Seq" type="26" numberingType="2" startNumber="1" sequenceFormat="Sheet ###" />';
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(table, onLayer('id10', ['id199'])), '', '1,1,1', ['id90'], sequence));
    expect(warnings.filter(warning => warning.includes('table'))).toEqual([]);
    const [pageState] = [...doc.state.pages.values()];
    const all = pageState!.entityOrder.map((id) => pageState!.entities.get(id)!);
    expect(all.map((e) => e.kind)).toEqual(['table']);
    const [entity] = all, grid = entity!.table!;
    expect(entity!.points.map(inches)).toEqual([[0, 0], [2, 0], [2, 1], [0, 1]]);
    expect(grid.rows).toEqual([0.25, 0.75]); expect(grid.columns).toEqual([1.5, 0.5]);
    expect(entity!.style).toMatchObject({ strokeColor: '#000000', strokeWeightPt: 0.6 });
    // Black headers, an unfilled cell, and a cell filled with LayOut's default white.
    expect(tableCells(entity!).map(cell => cell.fillColor)).toEqual(['#000000', '#000000', null, '#ffffff']);
    expect(grid.rowEdges).toEqual([{ strokeColor: '#000000', strokeWeightPt: 0.5 }]);
    expect(grid.columnEdges).toEqual([{ strokeColor: '#ff0000', strokeWeightPt: 1 }]);
    // Sequence item 2 in upper-case letters, then page 1's name and sequence item 4.
    expect(grid.cells.map((c) => c.text.content)).toEqual(['Sheet #', 'Sheet Name', 'Sheet B', 'Plan & Notes / Sheet D']);
    expect(grid.cells[0]!.text).toMatchObject({ fontFamily: 'Verdana', fontSizePt: 10, align: 'center', vertical: 'middle', bounded: true });
    expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageState!.id)).toEqual(pageState);
  });

  it('keeps merges, turned cells, blank filled cells, and spreadsheet contents of imported tables', () => {
    const cell = (index: number, body: string, extra = '') =>
      `<e:cell_${index}><e:rtfText id="id${300 + index}" anchorType="5"><e:placedFileReference>
        <e:rectangleBase x="0" y="0" width="1" height="1"><e:graphicEntity fillColor="4286545791" shouldStroke="0" />${extra}</e:rectangleBase>
      </e:placedFileReference><e:rtfTextRep>{\\rtf1\\ansi{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\\f0\\fs24 ${body}}</e:rtfTextRep></e:rtfText></e:cell_${index}>`;
    // Row 0 spans both columns; the frame is turned a quarter, so a cell turned a quarter more reads 90°.
    const table = `<e:table id="id299" rowCount="2" columnCount="2" columnSpan_0="2" height_0="1" height_1="1" width_0="1" width_1="1">
      <e:rectangleBase x="1" y="1" width="2" height="2"><e:graphicEntity shouldFill="0" />
        <e:affineTransform m11="0" m12="-1" m21="1" m22="0" tx="0" ty="4" /></e:rectangleBase>
      ${cell(0, 'Heading', '<e:affineTransform m11="0" m12="-1" m21="1" m22="0" tx="0" ty="0" />')}${cell(2, '  ', '<e:affineTransform m11="0" m12="-1" m21="1" m22="0" tx="0" ty="0" />')}
      ${cell(3, 'Up', '<e:affineTransform m11="-1" m12="0" m21="0" m22="-1" tx="0" ty="0" />')}
      <r:tableFileReference r:id="id60" /></e:table>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(table, onLayer('id10', ['id299']))));
    const entity = [...[...doc.state.pages.values()][0]!.entities.values()][0]!, grid = entity.table!;
    expect(entity.kind).toBe('table');
    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }]);
    expect(tableCellEntities(entity).map(cell => cell.text!.content)).toEqual(['Heading', '', 'Up']);
    // The blank cell keeps its gray background and font for later typing.
    expect(grid.cells[2]!.text).toMatchObject({ content: '', fontFamily: 'Arial', fontSizePt: 12 });
    expect(tableCells(entity).every(cell => cell.fillColor === '#7f7f7f')).toBe(true);
    expect(grid.cells.map(cell => cell.rotationDeg)).toEqual([undefined, undefined, undefined, 90]);
    expect(warnings).toContain('tables linked to a spreadsheet keep their contents but no longer update from it');
    const { doc: odd, warnings: oddWarnings } = importSketchUpLayout(layoutFile(page(table.replace('rowCount="2"', 'rowCount="0"'), onLayer('id10', ['id299']))));
    expect([...[...odd.state.pages.values()][0]!.entities.values()].some(e => e.kind === 'table')).toBe(false);
    expect(oddWarnings).toContain('tables were imported as lines and text');
  });

  it('keeps shared-layer content once for every page and skips content hidden for its page', () => {
    const master = `<e:rectangle id="id90" shape="0" rounding="0"><e:rectangleBase x="0" y="0" width="1" height="1" /></e:rectangle>`;
    const content = page('<e:path id="id60" rotationAngle="0"><e:elements>0,1</e:elements><e:points2f>0,0,1,1</e:points2f></e:path>', onLayer('id11', ['id60']));
    const { doc } = importSketchUpLayout(layoutFile(content, master));
    expect(doc.state.sharedEntityOrder).toHaveLength(1);
    expect(doc.state.layers.get(doc.state.sharedEntities.values().next().value!.layerId)!.shared).toBe(true);
    expect([...doc.state.pages.values()][0]!.entityOrder).toHaveLength(1);

    const { doc: hidden, warnings } = importSketchUpLayout(layoutFile(content, master, '1,0,1'));
    expect([...hidden.state.pages.values()][0]!.entityOrder).toHaveLength(0);
    expect(warnings).toContain('content on layers hidden for its page was skipped');
  });

  it('keeps scaled dash-dot curves and filled outlines as whole paths through save/reopen', () => {
    const entities = `<e:path id="id70" rotationAngle="0">
      <e:graphicEntity shouldFill="0" strokeWidth="2" strokeDashPattern="3" stroke.patternscale="1.5" />
      <e:elements>0,2</e:elements><e:points2f>0,0,1,0,1,1,2,1</e:points2f>
    </e:path>
    <e:rectangle id="id71" shape="0" rounding="0"><e:rectangleBase x="3" y="1" width="2" height="1">
      <e:graphicEntity fillColor="4278190335" strokeDashPattern="1" />
    </e:rectangleBase></e:rectangle>`;
    const { doc } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id70', 'id71']))));
    const paths = [...doc.state.pages.values()][0]!.entities;
    expect(paths.size).toBe(2);
    const [curve, rectangle] = [...paths.values()];
    expect(curve!.points.map(inches)).toEqual([[0, 0], [2, 1]]);
    expect(inches(curve!.handles![0]!.out!)).toEqual([1, 0]);
    expect(inches(curve!.handles![1]!.in!)).toEqual([1, 1]);
    // Dashes and gaps follow the pattern scale; the dot stays one weight long.
    const weightMm = 2 * 25.4 / 72;
    expect(curve!.style!.strokeDashMm).toEqual([12 * weightMm * 1.5, 6 * weightMm * 1.5, weightMm, 6 * weightMm * 1.5]);
    expect(rectangle).toMatchObject({ closed: true, style: { fillColor: '#ff0000' } });
    expect(rectangle!.points).toHaveLength(4);
    expect(rectangle!.style!.strokeDashMm).toHaveLength(2);
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
    expect([...reopened.state.pages.values()][0]!.entities).toEqual(paths);
  });

  it('round-trips the converted document through .pfl', () => {
    const entities = `<e:image id="id40"><e:placedFileReference><e:rectangleBase x="1" y="1" width="2" height="1" /></e:placedFileReference><r:imageFileReference r:id="id2" /></e:image>`;
    const { doc } = importSketchUpLayout(layoutFile(page(entities, onLayer('id10', ['id40']))));
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
    const [pageState] = [...reopened.state.pages.values()];
    expect([...pageState!.entities.values()][0]!.image!.src).toMatch(/^data:image\/png/);
  });

  it('retains per-page shared-layer visibility without duplicating or dropping shared content', () => {
    const master = '<e:rectangle id="id90"><e:rectangleBase x="0" y="0" width="1" height="1" /></e:rectangle>';
    const { doc, warnings } = importSketchUpLayout(layoutFile(page('', ''), master, '1,1,0'));
    const sharedId = doc.state.layerOrder[2]!, hidden = [...doc.state.pages.values()][0]!;
    expect(doc.state.sharedEntities.size).toBe(1);
    expect(isLayoutLayerVisible(hidden, doc.state, sharedId)).toBe(false);
    expect(entitiesForLayer(hidden, doc.state, sharedId)).toEqual([]);
    const visibleId = doc.addPage('Visible');
    expect(entitiesForLayer(doc.state.pages.get(visibleId)!, doc.state, sharedId)).toHaveLength(1);
    expect(warnings.some(warning => warning.includes('per-page visibility'))).toBe(false);
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
    expect(reopened.state.pages.get(hidden.id)!.layerVisibility?.get(sharedId)).toBe(false);
    expect(reopened.state.sharedEntities.size).toBe(1);
  });

  it('imports holes and nested islands as one compound path with original curve controls', () => {
    const entity = `<e:path id="id80"><e:graphicEntity fillColor="4278190335" strokeDashPattern="3" />
      <e:elements>0,2,1,1,3,0,1,1,1,3,0,1,1,1,3</e:elements>
      <e:points2f>0,0,1,0,3,0,4,0,4,4,0,4,1,1,3,1,3,3,1,3,1.5,1.5,2.5,1.5,2.5,2.5,1.5,2.5</e:points2f></e:path>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entity, onLayer('id10', ['id80']))));
    const imported = [...doc.state.pages.values()][0]!.entities;
    expect(imported.size).toBe(1);
    const path = [...imported.values()][0]!;
    expect(path.contourStarts).toEqual([0, 4, 8]); expect(path.closed).toBe(true);
    expect(path.points.map(inches)).toEqual([[0, 0], [4, 0], [4, 4], [0, 4], [1, 1], [3, 1], [3, 3], [1, 3],
      [1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]]);
    expect(inches(path.handles![0]!.out!)).toEqual([1, 0]); expect(inches(path.handles![1]!.in!)).toEqual([3, 0]);
    expect(path.style).toMatchObject({ fillColor: '#ff0000', strokeDashMm: expect.any(Array) });
    expect(warnings).toEqual([]);
    expect([...decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.values()][0]!.entities).toEqual(imported);
  });

  it('keeps a filled path with open and closed subpaths as one compound path', () => {
    // A closed square, a stray two-point line and a lone point, as in the corpus's section and elevation fills.
    const entity = `<e:path id="id80"><e:graphicEntity fillColor="4278190335" />
      <e:elements>0,1,1,1,3,0,1,0</e:elements>
      <e:points2f>0,0,4,0,4,4,0,4,1,1,3,3,5,5</e:points2f></e:path>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entity, onLayer('id10', ['id80']))));
    const imported = [...doc.state.pages.values()][0]!.entities;
    expect(imported.size).toBe(1);
    const path = [...imported.values()][0]!;
    expect(path.closed).toBe(true); expect(path.contourStarts).toEqual([0, 4]); expect(path.openContours).toEqual([1]);
    expect(path.points.map(inches)).toEqual([[0, 0], [4, 0], [4, 4], [0, 4], [1, 1], [3, 3]]);
    expect(path.style?.fillColor).toBe('#ff0000');
    expect(warnings).toEqual([]);
    expect([...decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.values()][0]!.entities).toEqual(imported);
  });

  it('still splits a filled path whose open subpath ends in an arrow, and says so', () => {
    const entity = `<e:path id="id80"><e:graphicEntity fillColor="4278190335" />
      <e:elements>0,1,1,1,3,0,1</e:elements>
      <e:points2f>0,0,4,0,4,4,0,4,1,1,3,3</e:points2f>
      <e:arrowData startArrowType="0" endArrowType="5" endArrowSize="4" /></e:path>`;
    const { doc, warnings } = importSketchUpLayout(layoutFile(page(entity, onLayer('id10', ['id80']))));
    const imported = [...[...doc.state.pages.values()][0]!.entities.values()];
    expect(imported).toHaveLength(2);
    expect(imported.every(entity => !entity.contourStarts)).toBe(true);
    expect(imported[1]!.style?.endArrow).toBeDefined();
    expect(warnings.some(warning => warning.includes('filled paths with arrows were split'))).toBe(true);
  });

  it('rejects archives that are not LayOut documents', () => {
    expect(() => importSketchUpLayout(new Uint8Array([1, 2, 3]))).toThrow('Invalid .layout archive');
    expect(() => importSketchUpLayout(zipSync({ 'x.txt': strToU8('x') }))).toThrow('missing document.xml');
  });
});

describe('parseXml', () => {
  it('normalizes attribute prefixes by namespace and decodes entities', () => {
    const root = parseXml('<a xmlns:q="urn:refs"><b q:id="x" id="y">1 &lt; 2 &#x41;</b><!-- c --><c/></a>', { 'urn:refs': 'r' });
    expect(root.children.map((child) => child.name)).toEqual(['b', 'c']);
    expect(root.children[0]!.attrs).toEqual({ 'r:id': 'x', id: 'y' });
    expect(root.children[0]!.text).toBe('1 < 2 A');
  });

  it('rejects mismatched tags', () => {
    expect(() => parseXml('<a><b></a>')).toThrow('Malformed XML');
  });
});
