// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { LayoutEntity } from '@pushform/layout';
import type { NativeLayoutAsset } from './layoutAsset';
import { referenceNativeLayoutConnections, encodeNativeLayoutConnections, decodeNativeLayoutConnections, resolveNativeLayoutConnections, materializeNativeLayoutConnections } from './layoutConnections';
const schema = protobuf.parse(readFileSync(new URL('./layoutConnections.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutConnections');
function fixture(): NonNullable<LayoutEntity['preservedModelConnections']> {
  return { archiveId: 'archive', originalId: 'annotation', snapshot: '{"opaque":"unchanged"}', viewports: [{ originalId: 'view', entityId: 900 }, { originalId: 'view', entityId: 901 }], fields: { Name: 'Beam' } };
}
it('references an opaque snapshot asset without putting snapshot text into metadata', () => {
  const source = fixture(), reference = referenceNativeLayoutConnections(source, 7), bytes = encodeNativeLayoutConnections(reference);
  expect(Object.hasOwn(reference, 'snapshot')).toBe(false);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const next = decodeNativeLayoutConnections(bytes).value;
  expect(materializeNativeLayoutConnections(next, new Map([[7, source.snapshot]]))).toEqual(source);
  const large = { ...source, snapshot: 'x'.repeat(2 * 1024 * 1024) };
  expect(encodeNativeLayoutConnections(referenceNativeLayoutConnections(large, 7))).toEqual(bytes);
});
it('preserves field presence and nested unknown fields across known edits', () => {
  for (const state of ['absent', 'undefined', 'empty']) {
    const source = fixture(); delete source.fields;
    if (state !== 'absent') Object.defineProperty(source, 'fields', { value: state === 'empty' ? {} : undefined, enumerable: true });
    const ref = referenceNativeLayoutConnections(source, 7), next = decodeNativeLayoutConnections(encodeNativeLayoutConnections(ref)).value;
    expect(materializeNativeLayoutConnections(next, new Map([[7, source.snapshot]]))).toEqual(source);
    expect(Object.hasOwn(next, 'fields')).toBe(state !== 'absent');
  }
  const fields = [new Uint8Array([0x98, 6, 7])], ext = new Map(['', 'viewports/0', 'viewports/1', 'fields', 'fields/Name'].map(key => [key, fields]));
  const bytes = encodeNativeLayoutConnections(referenceNativeLayoutConnections(fixture(), 7), ext), next = decodeNativeLayoutConnections(bytes); bytes.fill(0);
  next.value.fields!.Name = 'Column'; expect(decodeNativeLayoutConnections(encodeNativeLayoutConnections(next.value, next.extensions)).extensions).toEqual(ext);
});
it('resolves one shared text asset without requiring live paper entities', () => {
  const ref = referenceNativeLayoutConnections(fixture(), 7), asset: NativeLayoutAsset = { reference: { encoding: 0, prefix: '', byteLength: 2, chunks: [1], unknownFields: [] }, bytes: new Uint8Array([120, 0]) };
  expect(resolveNativeLayoutConnections(ref, new Map([[7, asset]]))).toBe(asset);
  expect(() => resolveNativeLayoutConnections(ref, new Map())).toThrow();
  expect(() => resolveNativeLayoutConnections(ref, new Map([[7, { ...asset, reference: { ...asset.reference, encoding: 1 } }]]))).toThrow();
  expect(() => materializeNativeLayoutConnections(ref, new Map())).toThrow();
});
it('rejects invalid identities and empty viewport associations', () => {
  const ref = referenceNativeLayoutConnections(fixture(), 7), plain = schema.toObject(schema.decode(encodeNativeLayoutConnections(ref)));
  for (const patch of [{ archiveId: '' }, { originalId: '' }, { snapshotAssetId: 0 }, { viewports: [] }, { viewports: [{ originalId: 'view', entityId: 0 }] }]) {
    expect(() => decodeNativeLayoutConnections(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
});
