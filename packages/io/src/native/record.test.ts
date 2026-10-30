// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { NativeRecordCodec } from './record';
const codec = new NativeRecordCodec({ id: { id: 1, kind: 'uint53', required: true },
  name: { id: 2, kind: 'string', required: true }, number: { id: 3, kind: 'double', required: false },
  flag: { id: 4, kind: 'bool', required: false }, data: { id: 5, kind: 'bytes', required: false } });
describe('static native metadata records', () => {
  it('preserves ordered repeated messages, owns their bytes, and rejects extension injection', () => {
    const repeated = new NativeRecordCodec({ items: { id: 1, kind: 'bytes', required: false, repeated: true } });
    const type = protobuf.parse('syntax="proto2"; message R { repeated bytes items=1; }').root.lookupType('R');
    const fields = { items: [new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3])] };
    const bytes = repeated.encode({ fields, unknownFields: [] }); expect(Array.from(bytes)).toEqual(Array.from(type.encode(fields).finish()));
    const decoded = repeated.decode(bytes); bytes.fill(0); expect(decoded.fields.items).toEqual(fields.items);
    expect(repeated.encode({ fields: { items: [] }, unknownFields: [] }).length).toBe(0);
    expect(() => repeated.encode({ fields, unknownFields: [new Uint8Array([0x98, 6, 7, 10, 0])] })).toThrow();
  });
  it('interoperates with Protobuf including exhausted uint32 allocators and exact safe integers', () => {
    const schema = protobuf.parse('syntax="proto2"; message R {required uint64 id=1;required string name=2;optional double number=3;optional bool flag=4;optional bytes data=5;}').root.lookupType('R');
    for (const id of [0, 0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
      const fields = { id, name: '模型', number: -0, flag: false, data: new Uint8Array([1, 2]) };
      const bytes = codec.encode({ fields, unknownFields: [] });
      expect(Array.from(bytes)).toEqual(Array.from(schema.encode(fields).finish()));
      expect({ ...codec.decode(bytes).fields }).toEqual(fields);
    }
  });
  it('owns known and unknown bytes and retains optional absence', () => {
    const bytes = codec.encode({ fields: { id: 1, name: '' }, unknownFields: [new Uint8Array([0x98, 6, 7])] });
    const value = codec.decode(bytes); bytes.fill(0); expect(Object.hasOwn(value.fields, 'number')).toBe(false);
    value.fields.name = 'edited'; expect(codec.decode(codec.encode(value))).toEqual(value);
  });
  it('rejects bad UTF-8, duplicate fields, missing required fields and unsafe integers', () => {
    for (const bytes of [[8, 1, 18, 1, 255], [8, 1, 8, 2, 18, 0], [8, 1]]) expect(() => codec.decode(new Uint8Array(bytes))).toThrow();
    expect(() => codec.encode({ fields: { id: Number.MAX_SAFE_INTEGER + 1, name: '' }, unknownFields: [] })).toThrow();
    expect(() => codec.encode({ fields: { id: 1, name: '', typo: 1 }, unknownFields: [] })).toThrow();
  });
});
