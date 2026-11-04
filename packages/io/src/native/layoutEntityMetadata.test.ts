// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { encodeNativeLayoutEntityMetadata, decodeNativeLayoutEntityMetadata } from './layoutEntityMetadata';
import type { NativeLayoutEntityMetadata, LayoutEntityMetadataExtensions } from './layoutEntityMetadata';
const schema = protobuf.parse(readFileSync(new URL('./layoutEntityMetadata.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutEntityMetadata');
function fixture(): NativeLayoutEntityMetadata {
  const value: NativeLayoutEntityMetadata = { id: 123, kind: 'path', layerId: 7, name: 'Compound outline', locked: false, hidden: true, groupId: 99, nestedGroupIds: [100, 101],
    style: { strokeColor: '#123456', strokeWeightPt: 1.25, fillColor: null, strokeDashMm: [1.5, 2.75], startArrow: { type: 'open-arrow-90', sizePt: 7.5 } } };
  Object.defineProperty(value.style, 'endArrow', { value: undefined, enumerable: true }); return value;
}
it('preserves all entity kinds, grouping, visibility and exact styles with Protobuf interoperability', () => {
  for (const kind of ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'table'] as const) {
    const value = { ...fixture(), kind }, bytes = encodeNativeLayoutEntityMetadata(value);
    expect(decodeNativeLayoutEntityMetadata(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('retains absent, undefined, false and empty optional values distinctly', () => {
  for (const state of ['absent', 'undefined', 'present']) {
    const value: NativeLayoutEntityMetadata = { id: 1, kind: 'path', layerId: 2 };
    const keys = ['name', 'locked', 'hidden', 'groupId', 'nestedGroupIds', 'style'] as const;
    if (state === 'undefined') for (const key of keys) Object.defineProperty(value, key, { value: undefined, enumerable: true });
    if (state === 'present') Object.assign(value, fixture(), { name: '', hidden: false, style: { strokeColor: '', strokeWeightPt: -0, fillColor: '', strokeDashMm: [] } });
    const next = decodeNativeLayoutEntityMetadata(encodeNativeLayoutEntityMetadata(value)).value;
    expect(next).toEqual(value); for (const key of keys) expect(Object.hasOwn(next, key)).toBe(state !== 'absent');
  }
  const value = fixture(); Object.defineProperty(value.style!, 'strokeDashMm', { value: undefined, enumerable: true });
  expect(decodeNativeLayoutEntityMetadata(encodeNativeLayoutEntityMetadata(value)).value).toEqual(value);
});
it('owns unknown fields at metadata, wrappers and nested base-style/arrow scopes', () => {
  const fields = [new Uint8Array([0x98, 6, 7])], ext: LayoutEntityMetadataExtensions = {
    records: new Map(['', 'name', 'nestedGroupIds', 'style', 'style/value', 'style/dash'].map(key => [key, fields])), style: new Map([['', fields], ['startArrow', fields], ['endArrow', fields]]) };
  const bytes = encodeNativeLayoutEntityMetadata(fixture(), ext), next = decodeNativeLayoutEntityMetadata(bytes); bytes.fill(0); next.value.name = 'Renamed';
  expect(decodeNativeLayoutEntityMetadata(encodeNativeLayoutEntityMetadata(next.value, next.extensions)).extensions).toEqual(ext);
});
it('rejects invalid groups, dash patterns, identities, kind codes and optional wrappers', () => {
  for (const patch of [{ id: 0 }, { layerId: 0 }, { groupId: 0 }, { nestedGroupIds: [] }, { nestedGroupIds: [100, 100] }, { nestedGroupIds: [99] },
    { name: 'x'.repeat(101) }, { style: { ...fixture().style!, strokeDashMm: [1] } }, { style: { ...fixture().style!, strokeDashMm: [1, 0] } }]) {
    expect(() => encodeNativeLayoutEntityMetadata({ ...fixture(), ...patch })).toThrow();
  }
  const plain = schema.toObject(schema.decode(encodeNativeLayoutEntityMetadata(fixture())));
  for (const patch of [{ kind: 7 }, { hidden: 3 }, { locked: 3 }, { name: { state: 0, value: '' } }, { style: { state: 1 } }]) {
    expect(() => decodeNativeLayoutEntityMetadata(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
});
it('stores a pattern fill with its picture as a document asset, and keeps an explicitly undefined one', () => {
  const fillPattern = { src: 'data:image/png;base64,AAAA', tileMm: [10.16, 5.08] as [number, number], originMm: [25.4, -3] as [number, number], scale: 0.5, rotationDeg: 45 };
  const value: NativeLayoutEntityMetadata = { ...fixture(), style: { ...fixture().style!, fillPattern } };
  const sources: string[] = [];
  const bytes = encodeNativeLayoutEntityMetadata(value, undefined, src => sources.push(src) + 6);
  expect(sources).toEqual([fillPattern.src]);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const decoded = decodeNativeLayoutEntityMetadata(bytes);
  // The picture comes back from the document's assets.
  expect(decoded.extensions.fillPatternAsset).toBe(7);
  expect(decoded.value.style!.fillPattern).toEqual({ ...fillPattern, src: '' });
  expect(() => encodeNativeLayoutEntityMetadata(value)).toThrow();
  for (const invalid of [{ scale: 0 }, { tileMm: [0, 1] }, { rotationDeg: NaN }, { src: 'data:image/gif;base64,AAAA' }])
    expect(() => encodeNativeLayoutEntityMetadata({ ...value, style: { ...value.style!, fillPattern: { ...fillPattern, ...invalid } as typeof fillPattern } }, undefined, () => 1)).toThrow();
  const empty: NativeLayoutEntityMetadata = { ...fixture() };
  Object.defineProperty(empty.style!, 'fillPattern', { value: undefined, enumerable: true });
  const next = decodeNativeLayoutEntityMetadata(encodeNativeLayoutEntityMetadata(empty)).value;
  expect(Object.hasOwn(next.style!, 'fillPattern')).toBe(true); expect(next).toEqual(empty);
});
