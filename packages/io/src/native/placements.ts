// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, ImageId, Mat4, Vec3 } from '@pushform/core';
import type { CommonAttrs, Guide, ImageEntity, SectionPlane } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { NativeChunkError } from './chunks';
type WithoutCommon<T> = T extends CommonAttrs ? Omit<T, keyof CommonAttrs | 'nativeUnknownFields'> : never;
export type NativeGuide = WithoutCommon<Guide>;
export type NativeImagePlacement = WithoutCommon<ImageEntity>;
export type NativeSectionPlane = WithoutCommon<SectionPlane>;
export interface NativePlacement<T> { value: T; properties: number; unknownFields: Uint8Array[] }
const base = { id: { id: 1, kind: 'uint32', required: true }, properties: { id: 2, kind: 'uint32', required: true } } as const;
const guide = new NativeRecordCodec({ ...base, kind: { id: 3, kind: 'uint32', required: true }, origin: { id: 4, kind: 'bytes', required: true }, vector: { id: 5, kind: 'bytes', required: false } });
const image = new NativeRecordCodec({ ...base, imageId: { id: 3, kind: 'uint32', required: true }, transform: { id: 4, kind: 'bytes', required: true }, widthM: { id: 5, kind: 'double', required: true }, heightM: { id: 6, kind: 'double', required: true } });
const section = new NativeRecordCodec({ ...base, name: { id: 3, kind: 'string', required: true }, symbol: { id: 4, kind: 'string', required: true }, plane: { id: 5, kind: 'bytes', required: true }, origin: { id: 6, kind: 'bytes', required: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native placement'); };
function property(id: number): void { if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail(); }
function write<T extends { id: Id }>(codec: NativeRecordCodec, record: NativePlacement<T>, fields: Record<string, NativeScalar>): Uint8Array {
  property(record.properties); return codec.encode({ fields: { id: record.value.id, properties: record.properties, ...fields }, unknownFields: record.unknownFields });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array) { const result = codec.decode(bytes); property(result.fields.properties as number); return result; }
const vec = (bytes: NativeScalar): Vec3 => decodeNativeNumbers(bytes as Uint8Array, 3) as unknown as Vec3;
export function encodeNativeGuide(record: NativePlacement<NativeGuide>): Uint8Array {
  const v = record.value, kind = { point: 0, line: 1, segment: 2 }[v.kind]; if (kind === undefined) return fail();
  return write(guide, record, { kind, origin: encodeNativeNumbers(v.origin, 3), ...(v.kind === 'point' ? {} : { vector: encodeNativeNumbers(v.kind === 'line' ? v.dir : v.end, 3) }) });
}
export function decodeNativeGuide(bytes: Uint8Array): NativePlacement<NativeGuide> {
  const { fields: f, unknownFields } = read(guide, bytes), id = f.id as Id, origin = vec(f.origin!);
  if ((f.kind !== 0 && f.kind !== 1 && f.kind !== 2) || Object.hasOwn(f, 'vector') !== (f.kind !== 0)) return fail();
  const value: NativeGuide = f.kind === 0 ? { id, kind: 'point', origin } : f.kind === 1 ? { id, kind: 'line', origin, dir: vec(f.vector!) } : { id, kind: 'segment', origin, end: vec(f.vector!) };
  return { value, properties: f.properties as number, unknownFields };
}
export function encodeNativeImagePlacement(record: NativePlacement<NativeImagePlacement>): Uint8Array {
  const v = record.value; if (!Number.isFinite(v.widthM) || !Number.isFinite(v.heightM)) return fail();
  return write(image, record, { imageId: v.imageId, transform: encodeNativeNumbers(v.transform, 16), widthM: v.widthM, heightM: v.heightM });
}
export function decodeNativeImagePlacement(bytes: Uint8Array): NativePlacement<NativeImagePlacement> {
  const { fields: f, unknownFields } = read(image, bytes);
  if (!Number.isFinite(f.widthM) || !Number.isFinite(f.heightM)) return fail();
  return { value: { id: f.id as Id, imageId: f.imageId as ImageId, transform: decodeNativeNumbers(f.transform as Uint8Array, 16) as unknown as Mat4,
    widthM: f.widthM as number, heightM: f.heightM as number }, properties: f.properties as number, unknownFields };
}
export function encodeNativeSectionPlane(record: NativePlacement<NativeSectionPlane>): Uint8Array {
  const v = record.value; if (v.plane.n.length !== 3) return fail();
  return write(section, record, { name: v.name, symbol: v.symbol, plane: encodeNativeNumbers([...v.plane.n, v.plane.d], 4), origin: encodeNativeNumbers(v.origin, 3) });
}
export function decodeNativeSectionPlane(bytes: Uint8Array): NativePlacement<NativeSectionPlane> {
  const { fields: f, unknownFields } = read(section, bytes), p = decodeNativeNumbers(f.plane as Uint8Array, 4);
  return { value: { id: f.id as Id, name: f.name as string, symbol: f.symbol as string, plane: { n: [p[0]!, p[1]!, p[2]!], d: p[3]! }, origin: vec(f.origin!) }, properties: f.properties as number, unknownFields };
}
