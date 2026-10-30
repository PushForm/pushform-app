// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { TagId } from '@pushform/core';
import type { CommonAttrs } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { encodeNativeCommonAttrs, decodeNativeCommonAttrs } from './commonAttrs';
const schema = protobuf.loadSync(fileURLToPath(new URL('./commonAttrs.proto', import.meta.url))).resolveAll().lookupType('pushform.native.CommonAttrs');

describe('native common entity attributes', () => {
  it('preserves every flag combination, tag identity and typed dictionary values', () => {
    for (let mask = 0; mask < 16; mask++) {
      const value: CommonAttrs = { tagId: 0xffff_ffff as TagId, hidden: !!(mask & 1), locked: !!(mask & 2), castShadows: !!(mask & 4), receiveShadows: !!(mask & 8),
        attributes: { extension: { name: 'Value', nested: [null, -0, { visible: false }] } } };
      const bytes = encodeNativeCommonAttrs(value);
      expect(decodeNativeCommonAttrs(bytes).value).toEqual(value);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves owner extensions after edits and rejects omitted required flags', () => {
    const value: CommonAttrs = { tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    const extension = new Uint8Array([0x98, 6, 7]);
    const decoded = decodeNativeCommonAttrs(encodeNativeCommonAttrs(value, { fields: [extension], attributes: new Map() }));
    decoded.value.hidden = true;
    expect(decodeNativeCommonAttrs(encodeNativeCommonAttrs(decoded.value, decoded.extensions)).extensions.fields).toEqual([extension]);
    expect(() => decodeNativeCommonAttrs(new Uint8Array([8, 1, 50, 0]))).toThrow();
  });
});
