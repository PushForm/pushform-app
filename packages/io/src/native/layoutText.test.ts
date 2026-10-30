// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { LayoutText } from '@pushform/layout';
import { decodeNativeLayoutText, encodeNativeLayoutText } from './layoutText';
const root = protobuf.parse(readFileSync(new URL('./layoutText.proto', import.meta.url), 'utf8')).root;
const schema = root.lookupType('pushform.native.LayoutText');
function fixture(): LayoutText {
  return { content: 'Hello\t房子\r\nSecond line', fontFamily: 'Noto Sans', fontSizePt: 12.5, color: '#123456', bold: false, italic: true, underline: false,
    align: 'center', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'dot', rotationDeg: -0, leaderOffsetMm: -2.75,
    list: 'bullet', lineSpacing: { mode: 'atLeast', value: 15.125 }, tabStopsPt: [-0, 36, 72.25],
    spans: [{ start: 0, end: 5, bold: true, italic: false, underline: true, fontFamily: 'Arial', fontSizePt: 18, color: '#abcdef' },
      { start: 6, end: 8, bold: false, italic: true, underline: false, fontFamily: undefined, color: '' }] };
}
it('round trips complete rich text and matches the published Protobuf field layout', () => {
  const value = fixture(), bytes = encodeNativeLayoutText(value), decoded = decodeNativeLayoutText(bytes);
  expect(decoded.value).toEqual(value);
  expect(Object.is(decoded.value.rotationDeg, -0)).toBe(true); expect(Object.is(decoded.value.tabStopsPt![0], -0)).toBe(true);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
});
it('preserves absent, explicit undefined and empty optional collections', () => {
  const names = ['spans', 'list', 'lineSpacing', 'tabStopsPt', 'rotationDeg', 'leaderOffsetMm'] as const;
  for (const state of ['absent', 'undefined', 'empty']) {
    const value = fixture();
    for (const key of names) {
      Reflect.deleteProperty(value, key);
      if (state === 'undefined') Object.defineProperty(value, key, { value: undefined, enumerable: true });
    }
    if (state === 'empty') { value.spans = []; value.tabStopsPt = []; }
    const decoded = decodeNativeLayoutText(encodeNativeLayoutText(value)).value;
    expect(decoded).toEqual(value);
    for (const key of names) expect(Object.hasOwn(decoded, key)).toBe(Object.hasOwn(value, key));
  }
});
it('round trips every supported text enum and line-spacing mode', () => {
  for (const align of ['left', 'center', 'right'] as const) for (const vertical of ['top', 'middle', 'bottom'] as const)
    for (const leader of ['straight', 'elbow', 'none'] as const) for (const endpoint of ['arrow', 'dot', 'none'] as const) {
      const value = { ...fixture(), align, vertical, leader, endpoint };
      expect(decodeNativeLayoutText(encodeNativeLayoutText(value)).value).toEqual(value);
    }
  for (const list of ['none', 'bullet', 'number'] as const) for (const mode of ['multiple', 'exactly', 'atLeast'] as const) {
    const value = { ...fixture(), list, lineSpacing: { mode, value: 1.15 } };
    expect(decodeNativeLayoutText(encodeNativeLayoutText(value)).value).toEqual(value);
  }
});
it('retains independently owned future fields at text, span and optional-wrapper scopes', () => {
  const keys = ['', 'spans', 'spans/0', 'spans/0/fontSizePt', 'spans/1/fontFamily', 'lineSpacing', 'lineSpacing.value', 'tabStopsPt', 'rotationDeg'];
  const extensions = new Map(keys.map(key => [key, [new Uint8Array([0x98, 6, 7])]]));
  const bytes = encodeNativeLayoutText(fixture(), extensions), decoded = decodeNativeLayoutText(bytes); bytes.fill(0);
  decoded.value.spans![0]!.fontSizePt = 24; decoded.value.fontFamily = 'Updated font';
  const next = decodeNativeLayoutText(encodeNativeLayoutText(decoded.value, decoded.extensions));
  expect(next.extensions).toEqual(extensions); expect(next.value.spans![0]!.fontSizePt).toBe(24);
});
it('rejects unknown enums, ambiguous presence, reversed spans and nonfinite numbers', () => {
  const plain = schema.toObject(schema.decode(encodeNativeLayoutText(fixture())));
  for (const patch of [{ align: 3 }, { list: 4 }, { fontSizePt: Infinity }, { rotationDeg: { state: 0, value: 1 } },
    { rotationDeg: { state: 1 } }, { spans: { state: 0, entries: [{ start: 0, end: 1, bold: false, italic: false, underline: false }] } },
    { spans: { state: 1, entries: [{ start: 9, end: 1, bold: false, italic: false, underline: false }] } },
    { tabStopsPt: { state: 1, value: new Uint8Array(3) } }]) {
    expect(() => decodeNativeLayoutText(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
  expect(() => encodeNativeLayoutText({ ...fixture(), tabStopsPt: [NaN] })).toThrow();
  expect(() => encodeNativeLayoutText({ ...fixture(), tabStopsPt: new Array<number>(1) })).toThrow();
});
