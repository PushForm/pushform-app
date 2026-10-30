// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, resolveLayoutText } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('updates fields, text bounds, and anchors with undo and layer protection', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  const entityId = commands.execute('layout.text.add', { pageId, kind: 'label',
    points: [[10, 10], [60, 30], [0, 0]],
    text: { content: '<project>', fontFamily: 'Arial', fontSizePt: 12, color: '#000000',
      bold: false, italic: false, underline: false, align: 'left', vertical: 'top', bounded: true,
      leader: 'elbow', endpoint: 'arrow' },
  }) as number;
  const page = () => doc.state.pages.get(pageId)!;
  const entity = () => page().entities.get(entityId)!;
  commands.execute('layout.document.setField', { name: 'project', value: 'House' });
  expect(resolveLayoutText(entity().text!.content, page(), doc.state)).toBe('House');
  commands.execute('layout.text.setBounds', { pageId, entityId, widthMm: 80, anchor: [5, 6] });
  expect(entity().points).toEqual([[10, 10], [90, 30], [5, 6]]);
  commands.execute('layout.text.update', { pageId, entityId, text: { bold: true, leader: 'straight' } });
  commands.execute('edit.undo');
  expect(entity().text).toMatchObject({ bold: false, leader: 'elbow' });
  commands.execute('edit.undo');
  expect(entity().points).toEqual([[10, 10], [60, 30], [0, 0]]);
  commands.execute('layout.layer.add', { name: 'Other' });
  commands.execute('layout.layer.setLocked', { layerId: 1, locked: true });
  expect(() => commands.execute('layout.text.update', { pageId, entityId, text: { content: 'blocked' } })).toThrow('unavailable');
  expect(() => commands.execute('layout.text.setBounds', { pageId, entityId, widthMm: 20 })).toThrow('unavailable');
});

it('numbers pages with page-number fields from their start page, start number and style', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const first = doc.state.pageOrder[0]!;
  const second = commands.execute('layout.page.add', {}) as number;
  commands.execute('layout.page.add', {});
  const show = (content: string) => doc.state.pageOrder.map((id) => resolveLayoutText(content, doc.state.pages.get(id)!, doc.state));
  expect(show('<PageNumber>')).toEqual(['1', '2', '3']);

  // A cover page left unnumbered, sheets counted from 1 on the second page.
  commands.execute('layout.document.setPageNumbering', { name: 'PageNumber', numbering: { startPageId: second, startNumber: 1, style: 'two-digit' } });
  expect(show('Sheet <PageNumber>')).toEqual(['Sheet ', 'Sheet 01', 'Sheet 02']);
  commands.execute('layout.document.setPageNumbering', { name: 'Folio', numbering: { startPageId: null, startNumber: 1, style: 'lower-roman' } });
  expect(show('<Folio>')).toEqual(['i', 'ii', 'iii']);
  commands.execute('edit.undo');
  expect(show('<Folio>')).toEqual(['<Folio>', '<Folio>', '<Folio>']);
  commands.execute('edit.redo');

  // A name is one kind of field: a text value replaces its numbering, and numbering replaces a text value.
  commands.execute('layout.document.setField', { name: 'Folio', value: 'F' });
  expect(show('<Folio>')).toEqual(['F', 'F', 'F']);
  commands.execute('layout.document.setPageNumbering', { name: 'Folio', numbering: { startPageId: null, startNumber: 26, style: 'upper-letter' } });
  expect(doc.state.customFields.has('Folio')).toBe(false);
  expect(show('<Folio>')).toEqual(['Z', 'AA', 'AB']);
  expect(() => commands.execute('layout.document.setPageNumbering', { name: 'PageCount', numbering: { startPageId: null, startNumber: 1, style: 'arabic' } })).toThrow('cannot number pages');
  expect(() => commands.execute('layout.document.setPageNumbering', { name: 'X', numbering: { startPageId: 9999, startNumber: 1, style: 'arabic' } })).toThrow('Start page not found');

  // Deleting the start page counts from the first page; reset returns <PageNumber> to its default.
  commands.execute('layout.page.delete', { pageId: second });
  expect(show('<PageNumber>')).toEqual(['01', '02']);
  commands.execute('layout.document.setPageNumbering', { name: 'PageNumber', numbering: null });
  expect(show('<PageNumber>')).toEqual(['1', '2']);
  expect(doc.state.pageOrder[0]).toBe(first);
});

it('keeps explicit leader bends and horizontal text attachment through edits, copies, and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const id = commands.execute('layout.text.add', { pageId, kind: 'label', points: [[10, 20], [60, 40], [100, 10], [80, 30]],
    text: { content: 'Left label', fontFamily: 'Arial', fontSizePt: 12, color: '#000000', bold: false, italic: false, underline: false,
      align: 'right', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  commands.execute('layout.text.setBounds', { pageId, entityId: id, widthMm: 40, heightMm: 30 });
  expect(entity().points).toEqual([[20, 15], [60, 45], [100, 10], [80, 30]]);
  const copy = commands.execute('layout.shape.move', { pageId, entityId: id, delta: [5, 10], copy: true }) as number;
  expect(doc.state.pages.get(pageId)!.entities.get(copy)!.points).toEqual([[25, 25], [65, 55], [105, 20], [85, 40]]);
  commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.has(copy)).toBe(false);
  commands.execute('edit.undo'); expect(entity().points).toEqual([[10, 20], [60, 40], [100, 10], [80, 30]]);
});
