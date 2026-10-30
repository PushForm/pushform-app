// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, Guid, Id, Vec3 } from '@pushform/core';
import type { Axes, ComponentDefinition, ComponentBehaviors } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { encodeNativeIds, decodeNativeIds } from './idList';

export type NativeDefinitionMetadata = Omit<ComponentDefinition, 'entities' | 'bounds' | 'nativeUnknownFields'>;
export interface NativeDefinitionRecord {
  metadata: NativeDefinitionMetadata;
  entityOrder: { count: number; chunks: number[] };
  activeSectionPlaneId: Id | null;
}
export type DefinitionExtensions = Map<string, Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const metadataFields = { id: f(1, 'uint32'), guid: f(2, 'string'), name: f(3, 'string'), description: f(4, 'string'), isGroup: f(5, 'bool'), axes: f(6, 'bytes'), behaviors: f(7, 'bytes') } satisfies Record<keyof NativeDefinitionMetadata, NativeField>;
const definition = new NativeRecordCodec({ ...metadataFields, entityOrder: f(8, 'bytes'), activeSectionPlaneId: f(9, 'uint32', false) });
const behaviors = new NativeRecordCodec({ glueTo: f(1, 'uint32'), cutsOpening: f(2, 'bool'), alwaysFaceCamera: f(3, 'bool'), shadowsFaceSun: f(4, 'bool') } satisfies Record<keyof ComponentBehaviors, NativeField>);
const order = new NativeRecordCodec({ count: f(1, 'uint32'), chunks: f(2, 'bytes', false) });
const glueTypes = ['none', 'any', 'horizontal', 'vertical', 'sloped'] as const;
const axisOrder = { origin: 0, x: 3, y: 6, z: 9 } satisfies Record<keyof Axes, number>;
const fail = (): never => { throw new NativeChunkError('Invalid native definition'); };
export function validateNativeDefinitionOrder(value: NativeDefinitionRecord['entityOrder']): void {
  if (!Number.isInteger(value.count) || value.count < 0 || value.count * 4 > NATIVE_MAX_DECODED_BYTES ||
      value.chunks.length > NATIVE_MAX_CHUNKS || new Set(value.chunks).size !== value.chunks.length || !!value.count !== !!value.chunks.length) fail();
  for (const id of value.chunks) if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff) fail();
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: DefinitionExtensions): Uint8Array {
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: DefinitionExtensions) {
  const result = codec.decode(bytes); if (result.unknownFields.length) extensions.set(path, result.unknownFields); return result.fields;
}
export function encodeNativeDefinition(value: NativeDefinitionRecord, extensions: DefinitionExtensions = new Map()): Uint8Array {
  validateNativeDefinitionOrder(value.entityOrder); const m = value.metadata, b = m.behaviors, glueTo = glueTypes.indexOf(b.glueTo);
  if (glueTo < 0) return fail(); const axes: number[] = [];
  for (const key of Object.keys(axisOrder) as (keyof Axes)[]) { if (m.axes[key].length !== 3) return fail(); axes.push(...m.axes[key]); }
  const fields: Record<string, NativeScalar> = {
    id: m.id, guid: m.guid, name: m.name, description: m.description, isGroup: m.isGroup, axes: encodeNativeNumbers(axes, 12),
    behaviors: write(behaviors, { ...b, glueTo }, 'behaviors', extensions),
    entityOrder: write(order, { count: value.entityOrder.count, ...(value.entityOrder.chunks.length ? { chunks: encodeNativeIds(value.entityOrder.chunks) } : {}) }, 'entityOrder', extensions),
  };
  if (value.activeSectionPlaneId !== null) fields.activeSectionPlaneId = value.activeSectionPlaneId;
  return write(definition, fields, '', extensions);
}
export function decodeNativeDefinition(bytes: Uint8Array): { value: NativeDefinitionRecord; extensions: DefinitionExtensions } {
  const extensions: DefinitionExtensions = new Map(), f = read(definition, bytes, '', extensions);
  const b = read(behaviors, f.behaviors as Uint8Array, 'behaviors', extensions), o = read(order, f.entityOrder as Uint8Array, 'entityOrder', extensions);
  const glueTo = glueTypes[b.glueTo as number]; if (!glueTo) return fail();
  const numbers = decodeNativeNumbers(f.axes as Uint8Array, 12), axes = {} as Axes;
  for (const key of Object.keys(axisOrder) as (keyof Axes)[]) axes[key] = numbers.slice(axisOrder[key], axisOrder[key] + 3) as unknown as Vec3;
  const value: NativeDefinitionRecord = {
    metadata: { id: f.id as DefId, guid: f.guid as Guid, name: f.name as string, description: f.description as string, isGroup: f.isGroup as boolean, axes,
      behaviors: { glueTo, cutsOpening: b.cutsOpening as boolean, alwaysFaceCamera: b.alwaysFaceCamera as boolean, shadowsFaceSun: b.shadowsFaceSun as boolean } },
    entityOrder: { count: o.count as number, chunks: decodeNativeIds(o.chunks as Uint8Array | undefined) },
    activeSectionPlaneId: Object.hasOwn(f, 'activeSectionPlaneId') ? f.activeSectionPlaneId as Id : null,
  };
  validateNativeDefinitionOrder(value.entityOrder); return { value, extensions };
}
