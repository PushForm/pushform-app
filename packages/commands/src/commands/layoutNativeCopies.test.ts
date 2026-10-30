// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function fixture() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const fields = [new Uint8Array([0xa0, 6, 7])], id = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [10, 0]] }) as number;
  doc.transact('native fields', draft => {
    const page = draft.pages.get(pageId)!, entity = page.entities.get(id)!;
    page.nativeUnknownFields = { envelopeUnknown: fields, extensions: new Map([['', fields]]) };
    entity.nativeUnknownFields = { header: fields, metadata: new Map([['', fields]]) };
    Reflect.set(entity, 'name', undefined); Reflect.set(page, 'layerVisibility', undefined);
  });
  return { doc, commands, pageId, id, fields };
}

it('duplicates page and entity native owners through registry undo and redo', () => {
  const { doc, commands, pageId, id } = fixture(), source = doc.state.pages.get(pageId)!;
  const copyId = commands.execute('layout.page.duplicate', { pageId }) as number, copy = doc.state.pages.get(copyId)!, entity = copy.entities.get(copy.entityOrder[0]!)!;
  expect(copy.nativeUnknownFields).toEqual(source.nativeUnknownFields);
  expect(Object.hasOwn(copy, 'layerVisibility')).toBe(true);
  expect(entity.nativeUnknownFields).toEqual(source.entities.get(id)!.nativeUnknownFields);
  expect(Object.hasOwn(entity, 'name')).toBe(true);
  commands.execute('edit.undo'); expect(doc.state.pages.has(copyId)).toBe(false);
  commands.execute('edit.redo'); expect(doc.state.pages.get(copyId)).toEqual(copy);
  doc.transact('edit copy fields', draft => { draft.pages.get(copyId)!.entities.get(entity.id)!.nativeUnknownFields!.metadata!.delete(''); });
  expect(doc.state.pages.get(pageId)!.entities.get(id)!.nativeUnknownFields!.metadata!.has('')).toBe(true);
});

it('keeps prototype-like annotation keys through duplicate, replacement, undo and redo', () => {
  const { doc, commands, pageId, id } = fixture();
  doc.transact('annotation fields', draft => {
    const fields = Object.assign(Object.create(null) as Record<string, string>, { constructor: 'authored constructor' });
    fields['__proto__'] = 'authored prototype';
    draft.pages.get(pageId)!.entities.get(id)!.modelAnnotation = { attachments: [], status: 'unavailable', fields };
  });
  const copyId = commands.execute('layout.page.duplicate', { pageId }) as number;
  const entityId = doc.state.pages.get(copyId)!.entityOrder[0]!;
  const fields = () => doc.state.pages.get(copyId)!.entities.get(entityId)!.modelAnnotation!.fields!;
  expect(Object.hasOwn(fields(), '__proto__')).toBe(true);
  doc.undoStack.transact('refresh annotation fields', draft => {
    draft.pages.get(copyId)!.entities.get(entityId)!.modelAnnotation!.fields = { refreshed: 'value' };
  });
  commands.execute('edit.undo');
  expect(Object.hasOwn(fields(), '__proto__')).toBe(true);
  expect(fields()['__proto__']).toBe('authored prototype');
  commands.execute('edit.redo'); expect(fields()).toEqual({ refreshed: 'value' });
  commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(doc.state.pages.has(copyId)).toBe(false);
  commands.execute('edit.redo');
  expect(Object.hasOwn(fields(), '__proto__')).toBe(true);
  expect(fields()['constructor']).toBe('authored constructor');
});

it('keeps native metadata through shared-layer conversion and requires a choice for differing fields', () => {
  const { doc, commands, pageId, id, fields } = fixture(), layerId = doc.state.activeLayerId;
  const second = commands.execute('layout.page.duplicate', { pageId }) as number;
  doc.transact('different native fields', draft => {
    const page = draft.pages.get(second)!;
    page.entities.get(page.entityOrder[0]!)!.nativeUnknownFields!.metadata!.set('', [new Uint8Array([0xa0, 6, 8])]);
  });
  expect(() => commands.execute('layout.layer.setShared', { pageId, layerId, shared: true })).toThrow('Choose');
  commands.execute('layout.layer.setShared', { pageId, layerId, shared: true, source: 'current' });
  expect(doc.state.sharedEntities.get(id)!.nativeUnknownFields!.metadata!.get('')).toEqual(fields);
  commands.execute('layout.layer.setShared', { pageId, layerId, shared: false });
  for (const page of doc.state.pages.values()) {
    const entity = page.entities.get(page.entityOrder[0]!)!;
    expect(entity.nativeUnknownFields!.metadata!.get('')).toEqual(fields);
    expect(Object.hasOwn(entity, 'name')).toBe(true);
  }
  commands.execute('edit.undo'); expect(doc.state.sharedEntities.get(id)!.nativeUnknownFields!.metadata!.get('')).toEqual(fields);
});
