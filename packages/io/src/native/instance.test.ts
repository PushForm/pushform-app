// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { Id, DefId, MaterialId } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { encodeNativeInstance, decodeNativeInstance } from './instance';
import type { NativeInstanceRecord } from './instance';
const schema = protobuf.loadSync(fileURLToPath(new URL('./instance.proto', import.meta.url))).resolveAll().lookupType('pushform.native.Instance');
const fixture = (): NativeInstanceRecord => ({ properties: 1, value: { id: 1 as Id, definitionId: 2 as DefId, name: 'Mirrored', materialId: null,
  transform: [-2, -0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1e12, -100, 0.25, 1] } });
describe('native instance records', () => {
  it('preserves transforms, inheritance and all glued-plane presence states', () => {
    for (const plane of ['absent', undefined, { n: [0, 0, 1] as const, d: -3 }] as const) for (const materialId of [null, 0 as MaterialId, 7 as MaterialId]) {
      const record = fixture(); record.value.materialId = materialId; if (plane !== 'absent') record.value.gluedPlane = plane;
      const bytes = encodeNativeInstance(record), decoded = decodeNativeInstance(bytes);
      expect(decoded.value).toEqual(record); expect(Object.hasOwn(decoded.value.value, 'gluedPlane')).toBe(plane !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves wrapper extensions and rejects bad shared-property references and tuple lengths', () => {
    const record = fixture(); record.value.gluedPlane = undefined;
    const extensions = new Map([['gluedPlane.undefined', [new Uint8Array([0x98, 6, 7])]]]);
    expect(decodeNativeInstance(encodeNativeInstance(record, extensions)).extensions).toEqual(extensions);
    record.properties = 0; expect(() => encodeNativeInstance(record)).toThrow(); record.properties = 1;
    const wire = schema.decode(encodeNativeInstance(record)) as unknown as Record<string, unknown>;
    expect(() => decodeNativeInstance(schema.encode({ ...wire, transform: new Uint8Array(127) }).finish())).toThrow();
    expect(() => decodeNativeInstance(schema.encode({ ...wire, gluedPlane: { undefinedValue: {}, value: new Uint8Array(32) } }).finish())).toThrow();
  });
});
