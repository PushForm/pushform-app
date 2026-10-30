// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { CameraState, FogSettings, ShadowSettings } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const f = (id: number, kind: NativeFieldKind): NativeField => ({ id, kind, required: true });
const camera = new NativeRecordCodec({ eye: f(1, 'bytes'), target: f(2, 'bytes'), up: f(3, 'bytes'), perspective: f(4, 'bool'), fov: f(5, 'double'), height: f(6, 'double') } satisfies Record<keyof CameraState, NativeField>);
const fog = new NativeRecordCodec({ enabled: f(1, 'bool'), near: f(2, 'double'), far: f(3, 'double'), useBackground: f(4, 'bool'), color: f(5, 'bytes') } satisfies Record<keyof FogSettings, NativeField>);
const shadows = new NativeRecordCodec({ enabled: f(1, 'bool'), month: f(2, 'uint32'), day: f(3, 'uint32'), time: f(4, 'double'), utcOffsetHours: f(5, 'double'),
  latitude: f(6, 'double'), longitude: f(7, 'double'), northAngle: f(8, 'double'), light: f(9, 'double'), dark: f(10, 'double'),
  useSunForShading: f(11, 'bool'), onGround: f(12, 'bool'), onFaces: f(13, 'bool'), fromEdges: f(14, 'bool') } satisfies Record<keyof ShadowSettings, NativeField>);
// RGB and Vec3 have identical wire field numbers/types; names remain schema-specific.
const triple = new NativeRecordCodec({ x: f(1, 'double'), y: f(2, 'double'), z: f(3, 'double') });
export type ViewSettingsExtensions = Map<string, Uint8Array[]>;
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new NativeChunkError('Invalid native view setting'); return value;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: ViewSettingsExtensions): Uint8Array {
  for (const value of Object.values(fields)) if (typeof value === 'number') finite(value);
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: ViewSettingsExtensions) {
  const value = codec.decode(bytes); if (value.unknownFields.length) extensions.set(path, value.unknownFields);
  for (const field of Object.values(value.fields)) if (typeof field === 'number') finite(field); return value.fields;
}
function encodeTriple(value: Vec3, path: string, extensions: ViewSettingsExtensions): Uint8Array {
  return write(triple, { x: finite(value[0]), y: finite(value[1]), z: finite(value[2]) }, path, extensions);
}
function decodeTriple(bytes: Uint8Array, path: string, extensions: ViewSettingsExtensions): Vec3 {
  const value = read(triple, bytes, path, extensions); return [value.x as number, value.y as number, value.z as number];
}
export function encodeNativeCamera(value: CameraState, extensions: ViewSettingsExtensions = new Map()): Uint8Array {
  return write(camera, { eye: encodeTriple(value.eye, 'eye', extensions), target: encodeTriple(value.target, 'target', extensions), up: encodeTriple(value.up, 'up', extensions),
    perspective: value.perspective, fov: value.fov, height: value.height }, '', extensions);
}
export function decodeNativeCamera(bytes: Uint8Array): { value: CameraState; extensions: ViewSettingsExtensions } {
  const extensions: ViewSettingsExtensions = new Map(), fields = read(camera, bytes, '', extensions);
  return { value: { eye: decodeTriple(fields.eye as Uint8Array, 'eye', extensions), target: decodeTriple(fields.target as Uint8Array, 'target', extensions),
    up: decodeTriple(fields.up as Uint8Array, 'up', extensions), perspective: fields.perspective as boolean, fov: fields.fov as number, height: fields.height as number }, extensions };
}
export function encodeNativeShadows(value: ShadowSettings, extensions: ViewSettingsExtensions = new Map()): Uint8Array {
  return write(shadows, { ...value }, '', extensions);
}
export function decodeNativeShadows(bytes: Uint8Array): { value: ShadowSettings; extensions: ViewSettingsExtensions } {
  const extensions: ViewSettingsExtensions = new Map(); return { value: { ...read(shadows, bytes, '', extensions) } as unknown as ShadowSettings, extensions };
}
export function encodeNativeFog(value: FogSettings, extensions: ViewSettingsExtensions = new Map()): Uint8Array {
  return write(fog, { ...value, color: encodeTriple(value.color, 'color', extensions) }, '', extensions);
}
export function decodeNativeFog(bytes: Uint8Array): { value: FogSettings; extensions: ViewSettingsExtensions } {
  const extensions: ViewSettingsExtensions = new Map(), fields = read(fog, bytes, '', extensions);
  return { value: { enabled: fields.enabled as boolean, near: fields.near as number, far: fields.far as number, useBackground: fields.useBackground as boolean,
    color: decodeTriple(fields.color as Uint8Array, 'color', extensions) }, extensions };
}
