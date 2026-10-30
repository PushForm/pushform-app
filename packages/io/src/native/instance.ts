// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, Id, Mat4, MaterialId } from '@pushform/core';
import type { CommonAttrs, ComponentInstance } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import type { NativeCommonPropertyReader } from './commonProperty';

export type NativeInstanceValue = Omit<ComponentInstance, keyof CommonAttrs | 'nativeUnknownFields'>;
export interface NativeInstanceRecord { value: NativeInstanceValue; properties: number }
export type InstanceExtensions = Map<string, Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const fields = { id: f(1, 'uint32'), definitionId: f(2, 'uint32'), transform: f(3, 'bytes'), name: f(4, 'string'), materialId: f(5, 'uint32', false), gluedPlane: f(6, 'bytes', false) } satisfies Record<keyof NativeInstanceValue, NativeField>;
const instance = new NativeRecordCodec({ ...fields, properties: f(7, 'uint32') });
const optional = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'bytes', false) }), empty = new NativeRecordCodec({});
const fail = (): never => { throw new NativeChunkError('Invalid native instance'); };
function properties(id: number): void { if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail(); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: InstanceExtensions): Uint8Array {
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: InstanceExtensions) {
  const result = codec.decode(bytes); if (result.unknownFields.length) extensions.set(path, result.unknownFields); return result.fields;
}
export function encodeNativeInstance(record: NativeInstanceRecord, extensions: InstanceExtensions = new Map()): Uint8Array {
  properties(record.properties); const value = record.value;
  const fields: Record<string, NativeScalar> = { id: value.id, definitionId: value.definitionId, transform: encodeNativeNumbers(value.transform, 16), name: value.name, properties: record.properties };
  if (value.materialId !== null) fields.materialId = value.materialId;
  if (Object.hasOwn(value, 'gluedPlane')) {
    if (value.gluedPlane !== undefined && value.gluedPlane.n.length !== 3) return fail();
    fields.gluedPlane = write(optional, value.gluedPlane === undefined ? { undefinedValue: write(empty, {}, 'gluedPlane.undefined', extensions) }
      : { value: encodeNativeNumbers([...value.gluedPlane.n, value.gluedPlane.d], 4) }, 'gluedPlane', extensions);
  }
  return write(instance, fields, '', extensions);
}
export function decodeNativeInstance(bytes: Uint8Array): { value: NativeInstanceRecord; extensions: InstanceExtensions } {
  const extensions: InstanceExtensions = new Map(), fields = read(instance, bytes, '', extensions), propertyId = fields.properties as number;
  properties(propertyId);
  const value: NativeInstanceValue = { id: fields.id as Id, definitionId: fields.definitionId as DefId, transform: decodeNativeNumbers(fields.transform as Uint8Array, 16) as unknown as Mat4,
    name: fields.name as string, materialId: Object.hasOwn(fields, 'materialId') ? fields.materialId as MaterialId : null };
  if (Object.hasOwn(fields, 'gluedPlane')) {
    const plane = read(optional, fields.gluedPlane as Uint8Array, 'gluedPlane', extensions);
    if (Object.keys(plane).length !== 1) return fail();
    if (Object.hasOwn(plane, 'undefinedValue')) { read(empty, plane.undefinedValue as Uint8Array, 'gluedPlane.undefined', extensions); value.gluedPlane = undefined; }
    else { const p = decodeNativeNumbers(plane.value as Uint8Array, 4); value.gluedPlane = { n: [p[0]!, p[1]!, p[2]!], d: p[3]! }; }
  }
  return { value: { value, properties: propertyId }, extensions };
}

/** Resolve one staged instance; nested attributes share an immutable catalog value. */
export function resolveNativeInstance(record: NativeInstanceRecord, properties: NativeCommonPropertyReader): ComponentInstance {
  return { ...properties.get(record.properties).value, ...record.value };
}
