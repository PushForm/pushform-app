// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { LayoutLinearDimension } from '@pushform/layout';
import { encodeNativeLayoutLinearDimension, decodeNativeLayoutLinearDimension, encodeNativeLayoutDimensionAnchor, decodeNativeLayoutDimensionAnchor } from './layoutDimension';
const schema = protobuf.parse(readFileSync(new URL('./layoutDimension.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutLinearDimension');
function fixture(): LayoutLinearDimension {
  return { anchors: [{ entityId: 999, pointIndex: 1, pointCount: 4, t: 0.375 }, null], alignment: 'rotated', angleDeg: 33.25, units: 'mm', format: 'decimal', precision: 3,
    showUnits: true, scale: 0.02, showDashes: false, text: 'Length <>', fontFamily: 'Arial', fontSizePt: 12.5, endpoint: 'tick', arrowSizeMm: 2.75,
    extensionGapMm: -0, extensionOverrunMm: 0.125, cachedValueMm: 123456.789012345, detached: true };
}
it('preserves exact measured values, detached identities, segment anchors and Protobuf interoperability', () => {
  const value = fixture(), bytes = encodeNativeLayoutLinearDimension(value), next = decodeNativeLayoutLinearDimension(bytes).value;
  expect(next).toEqual(value); expect(Object.is(next.extensionGapMm, -0)).toBe(true);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
});
it('covers every linear measurement format, unit, alignment and endpoint', () => {
  for (const units of ['mm', 'cm', 'm', 'inch', 'ft', 'pt'] as const) for (const format of ['decimal', 'architectural', 'engineering', 'fractional'] as const)
    for (const alignment of ['aligned', 'horizontal', 'vertical', 'rotated'] as const) for (const endpoint of ['arrow', 'tick', 'dot', 'none'] as const) {
      const value = { ...fixture(), units, format, alignment, endpoint };
      expect(decodeNativeLayoutLinearDimension(encodeNativeLayoutLinearDimension(value)).value).toEqual(value);
    }
});
it('distinguishes absent and explicit undefined optional fields, including segment fractions', () => {
  for (const state of ['absent', 'undefined']) {
    const value = fixture(); value.alignment = 'aligned';
    for (const key of ['angleDeg', 'scale', 'format', 'showDashes'] as const) {
      Reflect.deleteProperty(value, key); if (state === 'undefined') Object.defineProperty(value, key, { value: undefined, enumerable: true });
    }
    delete value.anchors[0]!.t; if (state === 'undefined') value.anchors[0]!.t = undefined;
    const next = decodeNativeLayoutLinearDimension(encodeNativeLayoutLinearDimension(value)).value;
    expect(next).toEqual(value); expect(Object.hasOwn(next, 'angleDeg')).toBe(state !== 'absent'); expect(Object.hasOwn(next.anchors[0]!, 't')).toBe(state !== 'absent');
  }
});
it('retains owned extensions at dimension, optional-value, anchor-list and null-anchor scopes', () => {
  const fields = [new Uint8Array([0x98, 6, 7])], extensions = new Map(['', 'angleDeg', 'scale', 'anchors', 'anchors/0', 'anchors/0/value', 'anchors/0/value/t', 'anchors/1'].map(key => [key, fields]));
  const bytes = encodeNativeLayoutLinearDimension(fixture(), extensions), next = decodeNativeLayoutLinearDimension(bytes); bytes.fill(0);
  next.value.text = 'Updated'; next.value.anchors[0]!.t = 0.5;
  expect(decodeNativeLayoutLinearDimension(encodeNativeLayoutLinearDimension(next.value, next.extensions)).extensions).toEqual(extensions);
});
it('rejects invalid anchor indices, measurement settings and ambiguous optional states', () => {
  for (const patch of [{ entityId: 0 }, { pointIndex: 4 }, { pointCount: 1 }, { t: 0 }, { t: 1 }, { t: NaN }]) {
    expect(() => encodeNativeLayoutDimensionAnchor({ entityId: 1, pointIndex: 0, pointCount: 4, ...patch })).toThrow();
  }
  const anchor = { entityId: 5, pointIndex: 1, pointCount: 3 }; expect(decodeNativeLayoutDimensionAnchor(encodeNativeLayoutDimensionAnchor(anchor))).toEqual(anchor);
  for (const patch of [{ precision: 7 }, { fontSizePt: 0 }, { extensionGapMm: -1 }, { angleDeg: NaN }, { scale: 0 }, { cachedValueMm: -1 }, { cachedValueMm: Infinity }]) {
    expect(() => encodeNativeLayoutLinearDimension({ ...fixture(), ...patch })).toThrow();
  }
  const plain = schema.toObject(schema.decode(encodeNativeLayoutLinearDimension(fixture())));
  for (const patch of [{ units: 6 }, { alignment: 4 }, { endpoint: 4 }, { showDashes: 3 }, { format: 5 }, { anchors: { entries: [{}] } },
    { angleDeg: { state: 1 } }, { scale: { state: 0, value: 1 } }]) {
    expect(() => decodeNativeLayoutLinearDimension(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
});
it('retains finite authored angles and missing rotated angles accepted by existing Layout persistence', () => {
  for (const angle of [-90, 180, 360, undefined]) {
    const value = fixture(); Object.defineProperty(value, 'angleDeg', { value: angle, enumerable: true });
    expect(decodeNativeLayoutLinearDimension(encodeNativeLayoutLinearDimension(value)).value).toEqual(value);
  }
});
