// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { CurveId, DefId, FaceLocalId, Id } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { encodeNativeDimension, decodeNativeDimension } from './dimension';
import type { NativeDimension, DimensionExtensions } from './dimension';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
const schema = protobuf.parse(readFileSync(new URL('./dimension.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.Dimension');
const base: NativeDimension = { id: 0 as Id, kind: 'linear', start: [1e10, -0, 1.123456789], end: [1, 2, 3], offset: [4, 5, 6], normal: [0, 0, 1], text: null, fontSizePt: 12.25 };
const attached: Partial<NativeDimension> = { anchors: [{ kind: 'sketchVertex', path: [9, 2] as Id[], id: 0 as Id },
  { kind: 'bodyVertex', path: [] as Id[], bodyId: 3 as Id, faceIds: [2, 1, 2] as FaceLocalId[] }], curve: { path: [8] as Id[], bodyId: null, curveId: 0 as CurveId } };
describe('native dimensions', () => {
  it('preserves variants, attachments, explicit undefined, null and empty text', () => {
    const options: Partial<NativeDimension>[] = [{}, { anchors: undefined, curve: undefined, arrow: undefined, align: undefined }, attached,
      { anchors: [null, null], curve: { path: [], bodyId: 0 as Id, curveId: 4 as CurveId } }];
    for (const kind of ['linear', 'radial', 'diametric'] as const) for (const extra of options) for (const text of [null, '', '長さ <>']) {
      const value = { ...base, kind, text, ...extra }, record = { value, properties: 1 }, bytes = encodeNativeDimension(record);
      expect(decodeNativeDimension(bytes).value).toEqual(record);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
      const envelope = encodeNativeModelRecord({ kind: 'dimension', ownerDefinitionId: 0 as DefId, value: record });
      expect(encodeNativeModelRecord(decodeNativeModelRecord(envelope))).toEqual(envelope);
    }
    for (const arrow of ['none', 'slash', 'dot', 'closed', 'open'] as const) for (const align of ['screen', 'above', 'centered', 'outside'] as const) {
      const record = { value: { ...base, arrow, align }, properties: 1 };
      expect(decodeNativeDimension(encodeNativeDimension(record)).value).toEqual(record);
    }
  });
  it('preserves independently owned extension fields at every nested attachment scope', () => {
    const ext: DimensionExtensions = new Map(['', 'anchors', 'anchors.start', 'anchors.end', 'curve'].map(scope => [scope, [new Uint8Array([0x98, 6, 7])]]));
    const record = { value: { ...base, ...attached }, properties: 1 }, bytes = encodeNativeDimension(record, ext), decoded = decodeNativeDimension(bytes);
    bytes.fill(0); expect(decoded).toEqual({ value: record, extensions: ext });
    expect(decodeNativeDimension(encodeNativeDimension(decoded.value, decoded.extensions))).toEqual(decoded);
  });
  it('rejects incomplete or contradictory anchor unions and malformed values', () => {
    const good = schema.decode(encodeNativeDimension({ value: base, properties: 1 }));
    const overrides = [{ kind: 3 }, { fontSizePt: NaN }, { properties: 0 }, { arrow: 6 }, { align: 5 },
      { anchors: { state: 0, start: { kind: 0 } } }, { anchors: { state: 1, start: { kind: 0 } } },
      { anchors: { state: 1, start: { kind: 1, path: new Uint8Array() }, end: { kind: 0 } } },
      { anchors: { state: 1, start: { kind: 0, id: 2 }, end: { kind: 0 } } },
      { curve: { state: 0, curveId: 0 } }, { curve: { state: 1, path: new Uint8Array() } }];
    for (const extra of overrides) expect(() => decodeNativeDimension(schema.encode({ ...good, ...extra }).finish())).toThrow();
    expect(() => encodeNativeDimension({ value: { ...base, start: [Infinity, 0, 0] }, properties: 1 })).toThrow();
  });
});
