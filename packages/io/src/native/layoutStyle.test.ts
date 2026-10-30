// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutDocumentState, LAYOUT_ARROW_TYPES } from '@pushform/layout';
import { decodeNativeLayoutStyle, encodeNativeLayoutStyle } from './layoutStyle';
const schema = protobuf.parse(readFileSync(new URL('./layoutStyle.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutDefaultStyle');
it('round trips every Layout arrow and default style through the static and Protobuf codecs', () => {
  for (const type of LAYOUT_ARROW_TYPES) {
    const value = { ...createLayoutDocumentState().defaultStyle, startArrow: { type, sizePt: -0 }, endArrow: { type, sizePt: 7.5 } };
    const bytes = encodeNativeLayoutStyle(value);
    expect(decodeNativeLayoutStyle(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('preserves null versus empty fill and explicit undefined versus absent arrows', () => {
  for (const fillColor of [null, '']) {
    const value = { ...createLayoutDocumentState().defaultStyle, fillColor };
    delete value.startArrow; Object.defineProperty(value, 'endArrow', { value: undefined, enumerable: true });
    const decoded = decodeNativeLayoutStyle(encodeNativeLayoutStyle(value)).value;
    expect(decoded).toEqual(value); expect(Object.hasOwn(decoded, 'startArrow')).toBe(false); expect(Object.hasOwn(decoded, 'endArrow')).toBe(true);
  }
});
it('retains nested future fields and rejects unsupported or ambiguous arrows', () => {
  const value = { ...createLayoutDocumentState().defaultStyle, startArrow: { type: 'star' as const, sizePt: 4 } };
  const extensions = new Map<'' | 'startArrow', Uint8Array[]>([['', [new Uint8Array([0x98, 6, 7])]], ['startArrow', [new Uint8Array([0x98, 6, 8])]]]);
  const decoded = decodeNativeLayoutStyle(encodeNativeLayoutStyle(value, extensions)); decoded.value.strokeColor = '#123456';
  expect(decodeNativeLayoutStyle(encodeNativeLayoutStyle(decoded.value, decoded.extensions)).extensions).toEqual(extensions);
  const plain = schema.toObject(schema.decode(encodeNativeLayoutStyle(value)));
  for (const startArrow of [{ type: 17, sizePt: 4 }, { type: 0, sizePt: 4 }, { type: 1 }, { type: 1, sizePt: Infinity }]) {
    expect(() => decodeNativeLayoutStyle(schema.encode({ ...plain, startArrow }).finish())).toThrow();
  }
});
