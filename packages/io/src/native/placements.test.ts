// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import type { DefId, Id, ImageId } from '@pushform/core';
import { encodeNativeGuide, decodeNativeGuide, encodeNativeImagePlacement, decodeNativeImagePlacement, encodeNativeSectionPlane, decodeNativeSectionPlane } from './placements';
import type { NativeGuide, NativePlacement } from './placements';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
const root = protobuf.parse(readFileSync(new URL('./placements.proto', import.meta.url), 'utf8')).root;
const unknownFields = [new Uint8Array([0x98, 6, 7])];
describe('native placement records', () => {
  it('preserves every guide variant and requires its matching vector shape', () => {
    const origin = [1e10, -0, 1.123456789] as const;
    const values: NativeGuide[] = [{ id: 0 as Id, kind: 'point', origin }, { id: 1 as Id, kind: 'line', origin, dir: [0, 2, 3] }, { id: 2 as Id, kind: 'segment', origin, end: [-1, 4, 9] }];
    for (const value of values) {
      const record: NativePlacement<NativeGuide> = { value, properties: 1, unknownFields }, bytes = encodeNativeGuide(record);
      const decoded = decodeNativeGuide(bytes); bytes.fill(0); expect(decoded).toEqual(record);
      const envelope = encodeNativeModelRecord({ kind: 'guide', value: record, ownerDefinitionId: 3 as DefId });
      expect(encodeNativeModelRecord(decodeNativeModelRecord(envelope))).toEqual(envelope);
      const known = encodeNativeGuide({ ...record, unknownFields: [] }), schema = root.lookupType('pushform.native.Guide');
      expect(Array.from(schema.encode(schema.decode(known)).finish())).toEqual(Array.from(known));
    }
    const schema = root.lookupType('pushform.native.Guide'), originBytes = new Uint8Array(24);
    for (const value of [{kind: 3}, {kind: 1}, {kind: 0, vector: originBytes}]) {
      expect(() => decodeNativeGuide(schema.encode({id: 1, properties: 1, origin: originBytes, ...value}).finish())).toThrow();
    }
  });
  it('preserves image transforms and section plane metadata through the model stream', () => {
    const image = { value: { id: 9 as Id, imageId: 0 as ImageId, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e10, -0, 0, 1] as const, widthM: 1.123456789, heightM: 2 }, properties: 4, unknownFields };
    expect(decodeNativeImagePlacement(encodeNativeImagePlacement(image))).toEqual(image);
    const section = { value: { id: 10 as Id, name: 'Section α', symbol: '', plane: { n: [0, 0, 1] as const, d: -0 }, origin: [1, 2, 3] as const }, properties: 4, unknownFields };
    expect(decodeNativeSectionPlane(encodeNativeSectionPlane(section))).toEqual(section);
    for (const [name, bytes] of [['ImagePlacement', encodeNativeImagePlacement({ ...image, unknownFields: [] })], ['SectionPlane', encodeNativeSectionPlane({ ...section, unknownFields: [] })]] as const) {
      const schema = root.lookupType(`pushform.native.${name}`);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
    const schema = root.lookupType('pushform.native.ImagePlacement');
    expect(() => decodeNativeImagePlacement(schema.encode({ id: 1, properties: 1, imageId: 1, transform: new Uint8Array(128), widthM: Infinity, heightM: 1 }).finish())).toThrow();
    for (const record of [{ kind: 'imagePlacement', value: image, ownerDefinitionId: 2 as DefId }, { kind: 'sectionPlane', value: section, ownerDefinitionId: 2 as DefId }] as const) {
      const bytes = encodeNativeModelRecord(record); expect(encodeNativeModelRecord(decodeNativeModelRecord(bytes))).toEqual(bytes);
    }
    expect(() => encodeNativeImagePlacement({ ...image, properties: 0 })).toThrow();
    expect(() => encodeNativeImagePlacement({ ...image, value: { ...image.value, widthM: NaN } })).toThrow();
    expect(() => encodeNativeSectionPlane({ ...section, value: { ...section.value, origin: [0, Infinity, 0] } })).toThrow();
  });
});
