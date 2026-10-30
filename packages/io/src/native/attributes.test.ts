// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { AttrValue, AttributeDictionaries } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeAttributes, encodeNativeAttributes } from './attributes';
const root = protobuf.loadSync(fileURLToPath(new URL('./attributes.proto', import.meta.url))).resolveAll();
const schema = root.lookupType('pushform.native.AttributeDictionaries');

describe('typed native attribute dictionaries', () => {
  it('round trips every value type, signed zero, empty names and prototype-like names', () => {
    const value: AttributeDictionaries = JSON.parse('{"__proto__":{"constructor":null,"__proto__":"safe"},"":{}}') as AttributeDictionaries;
    value.data = { all: [null, true, false, '', '日本語', -0, 1e100, [], {}, { nested: [1, 2] }] };
    const bytes = encodeNativeAttributes(value), restored = decodeNativeAttributes(bytes);
    expect(restored.value).toEqual(value); expect(Object.hasOwn(restored.value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(restored.value)).toBe(Object.prototype);
    expect(Object.is((restored.value.data!.all as AttrValue[])[5], -0)).toBe(true);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    expect(decodeNativeAttributes(encodeNativeAttributes({})).value).toEqual({});
  });

  it('owns unknown nested fields and preserves them after editing a known value', () => {
    const future = protobuf.Root.fromJSON(root.toJSON());
    future.lookupType('pushform.native.AttributeValue').add(new protobuf.Field('extra', 90, 'bytes'));
    const type = future.lookupType('pushform.native.AttributeDictionaries');
    const wire = type.decode(encodeNativeAttributes({ data: { value: 'before' } })) as unknown as {
      dictionaries: { value: { entries: { value: { extra?: Uint8Array; stringValue: string } }[] } }[];
    };
    wire.dictionaries[0]!.value.entries[0]!.value.extra = new Uint8Array([7, 8]);
    const bytes = type.encode(wire).finish(), decoded = decodeNativeAttributes(bytes); bytes.fill(0);
    decoded.value.data!.value = 'after';
    const restored = type.decode(encodeNativeAttributes(decoded.value, decoded.extensions)) as unknown as typeof wire;
    expect(restored.dictionaries[0]!.value.entries[0]!.value.stringValue).toBe('after');
    expect(Array.from(restored.dictionaries[0]!.value.entries[0]!.value.extra!)).toEqual([7, 8]);
  });

  it('accepts reordered entry fields without normalizing duplicate keys or oneof states', () => {
    const val = protobuf.Writer.create().uint32(18).string('ok').finish();
    const entry = protobuf.Writer.create().uint32(18).bytes(val).uint32(10).string('key').finish();
    const object = protobuf.Writer.create().uint32(10).bytes(entry).finish();
    const dictionary = protobuf.Writer.create().uint32(18).bytes(object).uint32(10).string('dict').finish();
    expect(decodeNativeAttributes(protobuf.Writer.create().uint32(10).bytes(dictionary).finish()).value).toEqual({ dict: { key: 'ok' } });
    const duplicate = protobuf.Writer.create().uint32(10).bytes(dictionary).uint32(10).bytes(dictionary).finish();
    expect(() => decodeNativeAttributes(duplicate)).toThrow();
    const bad = schema.encode({ dictionaries: [{ name: 'd', value: { entries: [{ key: 'x', value: { stringValue: 's', boolValue: false } }] } }] }).finish();
    expect(() => decodeNativeAttributes(bad)).toThrow();
    const emptyUnion = schema.encode({ dictionaries: [{ name: 'd', value: { entries: [{ key: 'x', value: {} }] } }] }).finish();
    expect(() => decodeNativeAttributes(emptyUnion)).toThrow();
  });

  it('rejects cycles, excessive nesting, nonfinite numbers and oversized records', () => {
    const list: AttrValue[] = []; list.push(list);
    expect(() => encodeNativeAttributes({ d: { list } })).toThrow();
    let nested: AttrValue = null; for (let i = 0; i < 70; i++) nested = [nested];
    expect(() => encodeNativeAttributes({ d: { nested } })).toThrow();
    for (const n of [NaN, Infinity, -Infinity]) expect(() => encodeNativeAttributes({ d: { n } })).toThrow();
    expect(() => encodeNativeAttributes({ d: { s: 'x'.repeat(1024 * 1024) } })).toThrow();
    expect(() => decodeNativeAttributes(new Uint8Array(1024 * 1024 + 1))).toThrow();
    for (const s of ['\ud800', '\udc00']) expect(() => encodeNativeAttributes({ d: { s } })).toThrow();
    expect(decodeNativeAttributes(encodeNativeAttributes({ d: { s: '😀' } })).value).toEqual({ d: { s: '😀' } });
  });

  it('uses the same field budget for writing and reading wide dictionaries', () => {
    const d: Record<string, AttrValue> = {}; for (let i = 0; i < 24_999; i++) d[String(i)] = null;
    expect(Object.keys(decodeNativeAttributes(encodeNativeAttributes({ d })).value.d!)).toHaveLength(24_999);
    d.extra = null; expect(() => encodeNativeAttributes({ d })).toThrow();
  });

  it('rejects truncated scopes, invalid tags, UTF-8 and injected known extension fields', () => {
    const good = encodeNativeAttributes({ d: { n: 42, s: 'value' } });
    for (let i = 1; i < good.length; i++) expect(() => decodeNativeAttributes(good.subarray(0, i))).toThrow();
    for (const bad of [[0], [11], [10, 2, 10, 1], [10, 4, 10, 2, 255, 255], [0x80, 0x80, 0x80, 0x80, 0x10]])
      expect(() => decodeNativeAttributes(new Uint8Array(bad))).toThrow();
    expect(() => encodeNativeAttributes({}, new Map([['', [new Uint8Array([10, 0])]]]))).toThrow();
  });
});
