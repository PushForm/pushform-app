// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TagId, Id, DefId } from '@pushform/core';
import type { CommonAttrs, DocumentState } from '@pushform/model';
import { createDocumentState, createEntityContainer, Document, UndoStack } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { NativeCommonPropertyWriter, NativeCommonPropertyReader, encodeNativeCommonProperty } from './commonProperty';
import { resolveNativeInstance } from './instance';
const value = (): CommonAttrs => ({ tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: { extension: { data: [1, 'name', false] } } });
describe('shared common-property catalog', () => {
  it('includes outer metadata in pooling equality and its retained-byte budget', () => {
    const fields = [new Uint8Array([0xa0, 6, 7])], pool = new NativeCommonPropertyWriter({}, () => 0);
    const a = { ...value(), nativePropertyUnknownFields: { required: false, envelopeUnknown: fields, unknownFields: fields, fields } };
    expect(pool.intern(a).id).toBe(1); expect(pool.intern(a).added).toBe(false);
    expect(pool.intern({ ...a, nativePropertyUnknownFields: { ...a.nativePropertyUnknownFields, required: true } }).id).toBe(2);
    expect(pool.intern({ ...a, nativePropertyUnknownFields: { ...a.nativePropertyUnknownFields, envelopeUnknown: [new Uint8Array([0xa0, 6, 8])] } }).id).toBe(3);
    const retained = new NativeCommonPropertyWriter(); retained.intern(a);
    expect(() => new NativeCommonPropertyWriter({ maxEncodedBytes: retained.encodedBytes - 1 }).intern(a)).toThrow();
    fields[0]!.fill(0);
    expect(pool.envelope(1)!.envelopeUnknown).toEqual([new Uint8Array([0xa0, 6, 7])]);
    const reader = new NativeCommonPropertyReader(); reader.add(pool.encodeRecord(1), pool.envelope(1));
    expect(() => new NativeCommonPropertyReader({ maxEncodedBytes: reader.encodedBytes - 1 }).add(pool.encodeRecord(1), pool.envelope(1))).toThrow();
    expect(reader.get(1).value.nativePropertyUnknownFields).toEqual({ required: false,
      envelopeUnknown: [new Uint8Array([0xa0, 6, 7])], unknownFields: [new Uint8Array([0xa0, 6, 7])], fields: [new Uint8Array([0xa0, 6, 7])] });
  });
  it('shares immutable attributes while isolating transactional edits, undo and redo', () => {
    const state = createDocumentState(), root = state.definitions.get(state.rootDefinitionId)!, target = 20 as DefId;
    state.definitions.set(target, { ...root, id: target, entities: createEntityContainer() }); state.meta.nextId = 100;
    const writer = new NativeCommonPropertyWriter(), reader = new NativeCommonPropertyReader();
    const scope = '/"extension"/object/"data"/list', fields = [new Uint8Array([0xa0, 6, 7])];
    writer.intern({ ...value(), tagId: state.defaultTagId, nativePropertyUnknownFields: { attributes: new Map([[scope, fields]]) } });
    reader.add(writer.encodeRecord(1), {});
    for (const n of [10, 11]) {
      const id = n as Id;
      root.entities.instances.set(id, resolveNativeInstance({ properties: 1, value: { id, definitionId: target, name: '', materialId: null,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } }, reader));
      root.entities.order.push(id);
    }
    const doc = new Document(state), undo = new UndoStack(doc), instance = (id: number) => doc.state.definitions.get(state.rootDefinitionId)!.entities.instances.get(id as Id)!;
    expect(instance(10).attributes).toBe(instance(11).attributes);
    expect(instance(10).nativePropertyUnknownFields).toBe(instance(11).nativePropertyUnknownFields);
    undo.transact('Edit shared attribute', draft => {
      // Avoid expanding Immer's recursive AttrValue mapped type; this remains the live draft.
      const edit = draft as unknown as DocumentState;
      edit.definitions.get(state.rootDefinitionId)!.entities.instances.get(10 as Id)!.attributes.extension!.data = 'changed';
    });
    expect(instance(10).attributes.extension!.data).toBe('changed'); expect(instance(11).attributes).toEqual(value().attributes);
    expect(reader.get(1).value.attributes).toEqual(value().attributes);
    expect(instance(10).nativePropertyUnknownFields).toBeUndefined();
    expect(instance(11).nativePropertyUnknownFields!.attributes!.get(scope)).toEqual(fields);
    undo.undo(); expect(instance(10).attributes).toEqual(value().attributes);
    expect(instance(10).nativePropertyUnknownFields!.attributes!.get(scope)).toEqual(fields);
    undo.redo(); expect(instance(10).attributes.extension!.data).toBe('changed'); expect(instance(11).attributes).toEqual(value().attributes);
  });
  it('deduplicates repeated values and resolves deliberate hash collisions by exact bytes', () => {
    const pool = new NativeCommonPropertyWriter({}, () => 0), a = value();
    expect(pool.intern(a)).toEqual({ id: 1, added: true });
    for (let i = 0; i < 10_000; i++) expect(pool.intern(value())).toEqual({ id: 1, added: false });
    expect(pool.intern({ ...a, hidden: true })).toEqual({ id: 2, added: true });
    expect(pool.intern(a)).toEqual({ id: 1, added: false }); expect(pool.size).toBe(2);
    const wire = pool.encodeRecord(1); wire.fill(0);
    const reader = new NativeCommonPropertyReader(); reader.add(pool.encodeRecord(1)); expect(reader.get(1).value).toEqual(a);
  });
  it('includes unknown fields in equality and preserves owned values across source mutation', () => {
    const pool = new NativeCommonPropertyWriter(), a = value(), ext = { fields: [new Uint8Array([0x98, 6, 7])], attributes: new Map() };
    pool.intern(a); expect(pool.intern(a, ext).id).toBe(2);
    a.attributes.extension!.data = null; ext.fields[0]!.fill(0);
    const reader = new NativeCommonPropertyReader(); reader.add(pool.encodeRecord(2));
    expect(reader.get(2).value).toEqual(value()); expect(reader.get(2).extensions.fields).toEqual([new Uint8Array([0x98, 6, 7])]);
    expect(Object.isFrozen(reader.get(2).value.attributes.extension)).toBe(true);
    expect(reader.get(2).value).toBe(reader.get(2).value);
  });
  it('rejects duplicate or missing IDs and enforces limits without partial insertion', () => {
    const pool = new NativeCommonPropertyWriter({ maxRecords: 1 }); pool.intern(value());
    expect(() => pool.intern({ ...value(), hidden: true })).toThrow(); expect(pool.size).toBe(1);
    expect(pool.intern(value()).added).toBe(false);
    expect(() => new NativeCommonPropertyWriter({ maxEncodedBytes: 0 }).intern(value())).toThrow();
    const reader = new NativeCommonPropertyReader(), bytes = pool.encodeRecord(1); reader.add(bytes);
    expect(() => reader.add(bytes)).toThrow(); expect(reader.size).toBe(1); expect(() => reader.get(99)).toThrow();
    expect(() => new NativeCommonPropertyReader({ maxEncodedBytes: bytes.length - 1 }).add(bytes)).toThrow();
    const record = reader.get(1); record.unknownFields.push(new Uint8Array([0x98, 6, 9]));
    const restored = new NativeCommonPropertyReader(); restored.add(encodeNativeCommonProperty(record));
    expect(restored.get(1).unknownFields).toEqual(record.unknownFields);
    const rewritten = new NativeCommonPropertyWriter(); rewritten.intern(record.value, record.extensions);
    const next = rewritten.intern(record.value, record.extensions, record.unknownFields); expect(next.id).toBe(2);
    const final = new NativeCommonPropertyReader(); final.add(rewritten.encodeRecord(next.id));
    expect(final.get(2).unknownFields).toEqual(record.unknownFields);
  });
});
