// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { LayoutAngularDimension } from '@pushform/layout';
import { encodeNativeLayoutAngularDimension, decodeNativeLayoutAngularDimension } from './layoutDimension';
const schema = protobuf.parse(readFileSync(new URL('./layoutDimension.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutAngularDimension');
function fixture(): LayoutAngularDimension {
  return { anchors: [null, null, null], units: 'degrees', precision: 3, showUnits: true, text: '<>', fontFamily: 'Arial', fontSizePt: 12.5,
    endpoint: 'arrow', arrowSizeMm: 3, extensionGapMm: -0, extensionOverrunMm: 1.25, cachedAngleDeg: 123.456789012, detached: false, reflex: true, angleDeg: -0 };
}
function rays(): NonNullable<LayoutAngularDimension['rayDefinition']> {
  return { points: [[-0, 0], [12, 0], [0, 0], [0, 18.125]], anchors: [null, { entityId: 99, pointIndex: 1, pointCount: 2 }, null, { entityId: 99, pointIndex: 0, pointCount: 2, t: 0.25 }] };
}
function edges(): NonNullable<LayoutAngularDimension['edgeAnchors']> {
  return [{ entityId: 7, segmentIndex: 1, pointCount: 3, direction: 1 }, { entityId: 9, segmentIndex: 0, pointCount: 2, direction: -1 }];
}
it('preserves three-point, directed-edge and four-point-ray angular dimensions in both units', () => {
  for (const units of ['degrees', 'radians'] as const) for (const mode of ['points', 'edges', 'rays']) {
    const value = fixture(); value.units = units;
    if (mode === 'rays') value.rayDefinition = rays();
    else if (mode === 'edges') value.edgeAnchors = edges();
    else value.anchors[0] = { entityId: 8, pointIndex: 1, pointCount: 2, t: 0.5 };
    const bytes = encodeNativeLayoutAngularDimension(value), next = decodeNativeLayoutAngularDimension(bytes).value;
    expect(next).toEqual(value); expect(Object.is(next.extensionGapMm, -0)).toBe(true);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('preserves optional undefined versus absent ray, edge and angle properties', () => {
  for (const state of ['absent', 'undefined']) {
    const value = fixture(); delete value.angleDeg;
    if (state === 'undefined') for (const key of ['angleDeg', 'edgeAnchors', 'rayDefinition']) Object.defineProperty(value, key, { value: undefined, enumerable: true });
    const next = decodeNativeLayoutAngularDimension(encodeNativeLayoutAngularDimension(value)).value;
    expect(next).toEqual(value);
    for (const key of ['angleDeg', 'edgeAnchors', 'rayDefinition']) expect(Object.hasOwn(next, key)).toBe(state !== 'absent');
  }
});
it('retains owned future fields on directed edges and nested ray anchors', () => {
  for (const mode of ['edges', 'rays']) {
    const value = fixture(); if (mode === 'edges') value.edgeAnchors = edges(); else value.rayDefinition = rays();
    const scopes = mode === 'edges' ? ['', 'edgeAnchors', 'edgeAnchors/0', 'edgeAnchors/1'] : ['', 'rayDefinition', 'rayDefinition/value', 'rayDefinition/anchors', 'rayDefinition/anchors/1/value', 'rayDefinition/anchors/3/value/t'];
    const extensions = new Map(scopes.map(key => [key, [new Uint8Array([0x98, 6, 7])]]));
    const bytes = encodeNativeLayoutAngularDimension(value, extensions), next = decodeNativeLayoutAngularDimension(bytes); bytes.fill(0); next.value.text = 'Changed';
    expect(decodeNativeLayoutAngularDimension(encodeNativeLayoutAngularDimension(next.value, next.extensions)).extensions).toEqual(extensions);
  }
});
it('rejects conflicting ray associations, invalid directions, bad ranges and unsupported units', () => {
  expect(() => encodeNativeLayoutAngularDimension({ ...fixture(), edgeAnchors: edges(), rayDefinition: rays() })).toThrow();
  const value = fixture(); value.rayDefinition = rays(); value.anchors[0] = { entityId: 1, pointIndex: 0, pointCount: 2 };
  expect(() => encodeNativeLayoutAngularDimension(value)).toThrow();
  const base = schema.toObject(schema.decode(encodeNativeLayoutAngularDimension({ ...fixture(), edgeAnchors: edges() })));
  for (const patch of [{ units: 2 }, { cachedAngleDeg: 361 }, { cachedAngleDeg: NaN }, { precision: 7 },
    { edgeAnchors: { state: 1, entries: [base.edgeAnchors.entries[0]] } },
    { edgeAnchors: { state: 1, entries: [{ ...base.edgeAnchors.entries[0], direction: 2 }, base.edgeAnchors.entries[1]] } },
    { rayDefinition: { state: 1 } }, { rayDefinition: { state: 0, value: {} } }]) {
    expect(() => decodeNativeLayoutAngularDimension(schema.encode({ ...base, ...patch }).finish())).toThrow();
  }
});
