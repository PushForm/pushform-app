// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { DEFAULT_UNITS } from '@pushform/core';
import type { Guid } from '@pushform/core';
import { FORMAT_VERSION } from '@pushform/model';
import type { DocumentMeta } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeModelMeta, encodeNativeModelMeta } from './modelMeta';
const fixture = (): DocumentMeta => ({ guid: 'test-guid' as Guid, formatVersion: FORMAT_VERSION, nextId: 0x1_0000_0000, units: { ...DEFAULT_UNITS } });
const source = readFileSync(new URL('./modelMeta.proto', import.meta.url), 'utf8');
const schema = protobuf.parse(source).root.lookupType('pushform.native.ModelMeta');
describe('native document metadata adapter', () => {
  it('round trips actual model fields, nullable snaps and optional dimension presence', () => {
    for (const dimensions of ['absent', undefined, { fontSizePt: 12, arrow: 'none', align: 'outside' }] as const) {
      const value = fixture(); value.units.angleSnap = -0;
      if (dimensions !== 'absent') value.dimensions = dimensions;
      const bytes = encodeNativeModelMeta(value), decoded = decodeNativeModelMeta(bytes);
      expect(decoded.value).toEqual(value); expect(Object.is(decoded.value.units.angleSnap, -0)).toBe(true);
      expect(Object.hasOwn(decoded.value, 'dimensions')).toBe(dimensions !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves nested unknowns after known settings change without keeping duplicate known fields', () => {
    const future = protobuf.parse(source.replace('required uint32 format = 1;', 'optional bytes future_data = 90; required uint32 format = 1;')).root.lookupType('pushform.native.ModelMeta');
    const wire = future.decode(encodeNativeModelMeta(fixture())) as unknown as { units: { futureData: Uint8Array } };
    wire.units.futureData = new Uint8Array([7, 8]);
    const bytes = future.encode(wire).finish(), decoded = decodeNativeModelMeta(bytes); bytes.fill(0);
    decoded.value.units.lengthPrecision = 3;
    const restored = future.decode(encodeNativeModelMeta(decoded.value, decoded.extensions)) as unknown as { units: { futureData: Uint8Array; lengthPrecision: number } };
    expect(restored.units.lengthPrecision).toBe(3); expect(Array.from(restored.units.futureData)).toEqual([7, 8]);
    expect([...decoded.extensions.keys()]).toEqual(['units']);
  });
  it('rejects empty or ambiguous optional wrappers and unsupported enum codes', () => {
    const wire = schema.decode(encodeNativeModelMeta(fixture())) as unknown as Record<string, unknown>;
    for (const dimensions of [{}, { undefinedValue: {}, value: { fontSizePt: 12, arrow: 0, align: 0 } }])
      expect(() => decodeNativeModelMeta(schema.encode({ ...wire, dimensions }).finish())).toThrow();
    const units = wire.units as Record<string, unknown>; units.format = 99;
    expect(() => decodeNativeModelMeta(schema.encode(wire).finish())).toThrow();
  });
});
