// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { createDocumentState } from '@pushform/model';
import type { Id } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { encodeNativeDefinition, decodeNativeDefinition } from './definition';
import type { NativeDefinitionRecord } from './definition';
const root = protobuf.loadSync(fileURLToPath(new URL('./definition.proto', import.meta.url))).resolveAll();
const schema = root.lookupType('pushform.native.Definition');
function fixture(): NativeDefinitionRecord {
  const state = createDocumentState(), { entities: _e, bounds: _b, ...metadata } = state.definitions.get(state.rootDefinitionId)!;
  return { metadata, entityOrder: { count: 0, chunks: [] }, activeSectionPlaneId: null };
}
describe('native definition records', () => {
  it('round trips factory metadata, behavior variants and large order references', () => {
    for (const glueTo of ['none', 'any', 'horizontal', 'vertical', 'sloped'] as const) {
      const value = fixture(); value.metadata.behaviors = { glueTo, cutsOpening: true, alwaysFaceCamera: true, shadowsFaceSun: false };
      value.metadata.axes = { ...value.metadata.axes, origin: [1e10, -0, -3] };
      value.entityOrder = { count: 1_000_000, chunks: [1, 2, 3] }; value.activeSectionPlaneId = 42 as Id;
      const bytes = encodeNativeDefinition(value);
      expect(bytes.length).toBeLessThan(300); expect(decodeNativeDefinition(bytes).value).toEqual(value);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
    const value = fixture(); expect(decodeNativeDefinition(encodeNativeDefinition(value)).value).toEqual(value);
  });
  it('preserves nested behavior extensions after editing the definition', () => {
    const value = fixture(), extension = new Uint8Array([0x98, 6, 7]), extensions = new Map([['behaviors', [extension]]]);
    const bytes = encodeNativeDefinition(value, extensions), decoded = decodeNativeDefinition(bytes); bytes.fill(0);
    decoded.value.metadata.name = 'Edited';
    const restored = decodeNativeDefinition(encodeNativeDefinition(decoded.value, decoded.extensions));
    expect(restored.value.metadata.name).toBe('Edited'); expect(restored.extensions).toEqual(extensions);
  });
  it('rejects malformed tuple sizes, nonfinite axes, duplicate chunks and unsupported behavior codes', () => {
    const value = fixture(); value.entityOrder = { count: 2, chunks: [1, 1] };
    expect(() => encodeNativeDefinition(value)).toThrow(); value.entityOrder = { count: 0, chunks: [] };
    const wire = schema.decode(encodeNativeDefinition(value)) as unknown as Record<string, unknown>;
    expect(() => decodeNativeDefinition(schema.encode({ ...wire, axes: new Uint8Array(95) }).finish())).toThrow();
    expect(() => decodeNativeDefinition(schema.encode({ ...wire, behaviors: { glueTo: 99 } }).finish())).toThrow();
    value.metadata.axes = { ...value.metadata.axes, origin: [Infinity, 0, 0] }; expect(() => encodeNativeDefinition(value)).toThrow();
  });
});
