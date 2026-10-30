// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { DefId, Id } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { encodeNativeText, decodeNativeText } from './text';
import type { NativeText } from './text';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
const schema = protobuf.parse(readFileSync(new URL('./text.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.Text');
const base: NativeText = { id: 0 as Id, text: '日本語 α\nsecond line', kind: 'screen', position: [1e10, -0, 1.123456789], offset: null,
  leader: 'none', fontFamily: 'Example Font', fontSizePt: 12.125, color: [0, 0.25, 1] };
describe('native text annotations', () => {
  it('preserves all kinds/leaders/arrows and optional presence states through the owned model record', () => {
    const optional: Partial<NativeText>[] = [{}, { viewOffset: undefined, bold: undefined, italic: undefined, arrow: undefined },
      { viewOffset: [-0, 3.123456789], bold: false, italic: true }, { viewOffset: [2, 3], bold: true, italic: false }];
    for (const kind of ['screen', 'leader'] as const) for (const leader of ['none', 'view', 'pushpin'] as const) for (const extra of optional) {
      const value = { ...base, kind, leader, ...extra }, record = { value, properties: 1, unknownFields: [] };
      const bytes = encodeNativeText(record); expect(decodeNativeText(bytes)).toEqual(record);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
      const envelope = encodeNativeModelRecord({ kind: 'text', ownerDefinitionId: 0 as DefId, value: record });
      expect(encodeNativeModelRecord(decodeNativeModelRecord(envelope))).toEqual(envelope);
    }
    for (const arrow of ['none', 'slash', 'dot', 'closed', 'open'] as const) {
      const record = { value: { ...base, arrow, offset: [1, -0, 2] as const }, properties: 1, unknownFields: [] };
      expect(decodeNativeText(encodeNativeText(record))).toEqual(record);
    }
  });
  it('owns and preserves future wire fields without retaining the input buffer', () => {
    const record = { value: base, properties: 1, unknownFields: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeNativeText(record), decoded = decodeNativeText(bytes); bytes.fill(0);
    expect(decoded).toEqual(record); expect(decodeNativeText(encodeNativeText(decoded))).toEqual(record);
  });
  it('rejects malformed enums, tuples, nonfinite font size and property references', () => {
    const good = schema.decode(encodeNativeText({ value: base, properties: 1, unknownFields: [] }));
    for (const overrides of [{ kind: 2 }, { leader: 3 }, { bold: 3 }, { italic: 3 }, { arrow: 6 }, { position: new Uint8Array(16) },
      { viewOffset: new Uint8Array(8) }, { offset: new Uint8Array(0) }, { fontSizePt: Infinity }, { properties: 0 }]) {
      expect(() => decodeNativeText(schema.encode({ ...good, ...overrides }).finish())).toThrow();
    }
    expect(() => encodeNativeText({ value: { ...base, fontSizePt: NaN }, properties: 1, unknownFields: [] })).toThrow();
    expect(() => encodeNativeText({ value: { ...base, color: [0, 1, Infinity] }, properties: 1, unknownFields: [] })).toThrow();
  });
});
