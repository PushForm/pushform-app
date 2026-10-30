// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { Id, FaceLocalId } from '@pushform/core';
import type { LayoutEntity, LayoutModelAttachment } from '@pushform/layout';
import { encodeNativeLayoutModelAnnotation, decodeNativeLayoutModelAnnotation, encodeNativeLayoutModelAttachment, decodeNativeLayoutModelAttachment,
  encodeNativeLayoutAnnotationFields, decodeNativeLayoutAnnotationFields } from './layoutModelAnnotation';
import { encodeNativeModelAnchor } from './dimension';
const root = protobuf.parse(readFileSync(new URL('./layoutModelAnnotation.proto', import.meta.url), 'utf8')).root;
const schema = root.lookupType('pushform.native.LayoutModelAnnotation'), attachmentSchema = root.lookupType('pushform.native.LayoutModelAttachment');
function attachment(): LayoutModelAttachment {
  return { viewportId: 42, source: { referenceId: 9 }, modelGuid: 'model-guid', anchor: { kind: 'bodyVertex', path: [1 as Id, 2 as Id], bodyId: 3 as Id, faceIds: [0 as FaceLocalId, 4 as FaceLocalId] } };
}
it('preserves model-local sketch/body identities, source kinds and every resolution status', () => {
  for (const status of ['resolved', 'unavailable', 'detached'] as const) for (const cloud of [true, false]) for (const body of [true, false]) {
    const a = attachment(); if (!cloud) a.source = { archiveId: 'archive', modelReferenceId: 'model' };
    if (!body) a.anchor = { kind: 'sketchVertex', path: [], id: 5 as Id };
    const value = { attachments: [a], status, fields: { Volume: '1.25', 'Component Name': 'Shelf' } };
    const bytes = encodeNativeLayoutModelAnnotation(value); expect(decodeNativeLayoutModelAnnotation(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('keeps two model-dimension anchors and stale identities without querying source models', () => {
  const value = { attachments: [attachment(), attachment()], status: 'unavailable' as const };
  value.attachments[1]!.viewportId = 42;
  expect(decodeNativeLayoutModelAnnotation(encodeNativeLayoutModelAnnotation(value)).value).toEqual(value);
});
it('preserves field dictionary absence, undefined, empty values and prototype-like authored keys', () => {
  for (const state of ['absent', 'undefined', 'empty', 'values']) {
    const value: NonNullable<LayoutEntity['modelAnnotation']> = { attachments: [attachment()], status: 'resolved' };
    if (state === 'undefined') Object.defineProperty(value, 'fields', { value: undefined, enumerable: true });
    else if (state !== 'absent') {
      value.fields = {}; if (state === 'values') for (const key of ['__proto__', 'constructor', 'toString', '']) Object.defineProperty(value.fields, key, { value: key, enumerable: true });
    }
    const next = decodeNativeLayoutModelAnnotation(encodeNativeLayoutModelAnnotation(value)).value;
    expect(next).toEqual(value); expect(Object.hasOwn(next, 'fields')).toBe(state !== 'absent');
    if (state === 'values') { expect(Object.getPrototypeOf(next.fields)).toBe(Object.prototype); expect(Object.hasOwn(next.fields!, '__proto__')).toBe(true); }
  }
});
it('retains owned extension fields across model anchor, source and named-field edits', () => {
  const value = { attachments: [attachment()], status: 'resolved' as const, fields: { Name: 'Old' } };
  const extensions = new Map(['', 'attachments/0', 'attachments/0/source', 'attachments/0/anchor', 'fields', 'fields/Name'].map(key => [key, [new Uint8Array([0x98, 6, 7])]]));
  const bytes = encodeNativeLayoutModelAnnotation(value, extensions), next = decodeNativeLayoutModelAnnotation(bytes); bytes.fill(0);
  next.value.fields!.Name = 'New'; next.value.status = 'detached';
  expect(decodeNativeLayoutModelAnnotation(encodeNativeLayoutModelAnnotation(next.value, next.extensions)).extensions).toEqual(extensions);
});
it('rejects invalid associations, null model anchors, duplicate fields and unsupported status', () => {
  const a = attachment(); a.viewportId = 0; expect(() => encodeNativeLayoutModelAttachment(a)).toThrow();
  const base = attachmentSchema.toObject(attachmentSchema.decode(encodeNativeLayoutModelAttachment(attachment())));
  expect(() => decodeNativeLayoutModelAttachment(attachmentSchema.encode({ ...base, anchor: encodeNativeModelAnchor(null) }).finish())).toThrow();
  const plain = schema.toObject(schema.decode(encodeNativeLayoutModelAnnotation({ attachments: [attachment()], status: 'resolved' })));
  for (const patch of [{ status: 3 }, { attachments: [] }, { attachments: [...plain.attachments, ...plain.attachments, ...plain.attachments] }]) {
    expect(() => decodeNativeLayoutModelAnnotation(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
  const f = root.lookupType('pushform.native.LayoutAnnotationFields');
  expect(() => decodeNativeLayoutAnnotationFields(f.encode({ state: 1, entries: [{ key: 'Name', value: 'one' }, { key: 'Name', value: 'two' }] }).finish())).toThrow();
  expect(() => decodeNativeLayoutAnnotationFields(f.encode({ state: 0, entries: [{ key: 'Name', value: '' }] }).finish())).toThrow();
  expect(decodeNativeLayoutAnnotationFields(encodeNativeLayoutAnnotationFields(undefined))).toBeUndefined();
});
