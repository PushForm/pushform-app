// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, expect, it } from 'vitest';
import { createLayoutDocumentState, setLayoutAccountFields, type LayoutEntity, type LayoutText } from '@pushform/layout';
import { exportSketchUpLayout } from './sketchupLayoutExport';
import { importSketchUpLayout } from './sketchupLayout';
import { child, parseXml } from './xml';

// Account auto-text exports to LayOut as custom auto-text holding the account's current values.
afterEach(() => setLayoutAccountFields(null));
const text = (content: string): LayoutText => ({ content, fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false, italic: false,
  underline: false, align: 'left', vertical: 'top', bounded: false, leader: 'none', endpoint: 'none' });
function withText(content: string) {
  const state = createLayoutDocumentState();
  const page = state.pages.get(state.pageOrder[0]!)!;
  const id = state.meta.nextId++;
  page.entities.set(id, { id, layerId: state.activeLayerId, kind: 'text', points: [[10, 10], [90, 20]], closed: false, text: text(content) } as LayoutEntity);
  page.entityOrder.push(id);
  return state;
}
async function definitions(content: string) {
  const exported = await exportSketchUpLayout(withText(content), { now: new Date('2026-10-26T12:00:00Z') });
  const files = unzipSync(exported.bytes);
  const document = parseXml(strFromU8(files['document.xml']!), { 'http://sketchup.google.com/schemas/layout/1.0/layout': 'l' });
  return { exported, list: child(child(document, 'autoTextManager')!, 'entityList')!.children.map(d => d.attrs) };
}

it('writes the account tags a document uses as custom auto-text with their current values', async () => {
  setLayoutAccountFields({ firstName: 'Ada', lastName: 'Lovelace', companyName: 'Analytical Ltd' });
  const { exported, list } = await definitions('Drawn by <FullName>, <CompanyName>');
  expect(list.find(d => d.name === 'FullName')).toMatchObject({ type: '3', textValue: 'Ada Lovelace' });
  expect(list.find(d => d.name === 'CompanyName')).toMatchObject({ type: '3', textValue: 'Analytical Ltd' });
  expect(list.find(d => d.name === 'FirstName')).toBeUndefined();
  expect(exported.warnings).toEqual([]);
  const { doc } = importSketchUpLayout(exported.bytes, 'Export.layout');
  expect(doc.state.customFields.get('FullName')).toBe('Ada Lovelace');
});

it('leaves account tags as typed when no account is signed in', async () => {
  const { exported, list } = await definitions('Drawn by <FullName>');
  expect(list.find(d => d.name === 'FullName')).toBeUndefined();
  expect(exported.warnings).toEqual(['unknown text fields were exported as typed']);
});
