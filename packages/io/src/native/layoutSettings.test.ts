// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutDocumentState } from '@pushform/layout';
import { decodeNativeLayoutSettings, encodeNativeLayoutSettings } from './layoutSettings';
const schema = protobuf.parse(readFileSync(new URL('./layoutSettings.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutSettings');

it('round trips actual Layout settings and interoperates with the schema', () => {
  const value = createLayoutDocumentState().settings, bytes = encodeNativeLayoutSettings(value);
  expect(decodeNativeLayoutSettings(bytes).value).toEqual(value);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
});
it('preserves absent, undefined, false, null and exact numeric values', () => {
  for (const state of ['absent', 'undefined', 'value']) {
    const value = createLayoutDocumentState().settings;
    for (const [object, key, content] of [[value, 'objectSnap', false], [value, 'paperUnits', 'in'], [value.grid, 'units', 'mm']] as const) {
      Reflect.deleteProperty(object, key);
      if (state !== 'absent') Object.defineProperty(object, key, { value: state === 'undefined' ? undefined : content, enumerable: true });
    }
    value.grid.angleSnapDeg = state === 'absent' ? null : -0; value.precision = -0;
    const decoded = decodeNativeLayoutSettings(encodeNativeLayoutSettings(value)).value;
    expect(decoded).toEqual(value);
    for (const key of ['objectSnap', 'paperUnits'] as const) expect(Object.hasOwn(decoded, key)).toBe(state !== 'absent');
    expect(Object.hasOwn(decoded.grid, 'units')).toBe(state !== 'absent');
    expect(Object.is(decoded.precision, -0)).toBe(true);
  }
});
it('retains owned future fields in document and grid settings after a known edit', () => {
  const future = new Uint8Array([0x98, 6, 7]), extensions = new Map<'' | 'grid', Uint8Array[]>([['', [future]], ['grid', [future]]]);
  const bytes = encodeNativeLayoutSettings(createLayoutDocumentState().settings, extensions);
  const decoded = decodeNativeLayoutSettings(bytes); bytes.fill(0); decoded.value.grid.snap = false;
  const next = decodeNativeLayoutSettings(encodeNativeLayoutSettings(decoded.value, decoded.extensions));
  expect(next.value.grid.snap).toBe(false); expect(next.extensions).toEqual(extensions);
});
it('rejects unsupported enums and nonfinite numeric settings', () => {
  const bytes = encodeNativeLayoutSettings(createLayoutDocumentState().settings);
  const value = schema.toObject(schema.decode(bytes));
  for (const patch of [{ units: 8 }, { objectSnap: 3 }, { paperUnits: 3 }, { precision: Infinity }]) {
    expect(() => decodeNativeLayoutSettings(schema.encode({ ...value, ...patch }).finish())).toThrow();
  }
  expect(() => encodeNativeLayoutSettings({ ...createLayoutDocumentState().settings, precision: NaN })).toThrow();
});
