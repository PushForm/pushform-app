// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId, MaterialId } from '@pushform/core';
import type { Material, MaterialTexture } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const material = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), color: f(3, 'bytes'), alpha: f(4, 'double'), texture: f(5, 'bytes') } satisfies Record<keyof Material, NativeField>);
const texture = new NativeRecordCodec({ imageId: f(1, 'uint32'), widthM: f(2, 'double'), heightM: f(3, 'double'), colorize: f(4, 'bool'), colorizeType: f(5, 'bytes', false) } satisfies Record<keyof MaterialTexture, NativeField>);
const rgb = new NativeRecordCodec({ red: f(1, 'double'), green: f(2, 'double'), blue: f(3, 'double') });
const nullable = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'bytes', false) });
const optional = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'uint32', false) });
const empty = new NativeRecordCodec({});
export type MaterialExtensions = Map<string, Uint8Array[]>;
const fail = (): never => { throw new NativeChunkError('Invalid native material'); };
function number(value: unknown, color = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (color && (value < 0 || value > 1))) return fail(); return value;
}
function state(value: Record<string, NativeScalar>, a: string): boolean {
  const first = Object.hasOwn(value, a); if (first === Object.hasOwn(value, 'value')) return fail(); return first;
}
function decode(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: MaterialExtensions) {
  const record = codec.decode(bytes); if (record.unknownFields.length) extensions.set(path, record.unknownFields); return record.fields;
}
function encode(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: MaterialExtensions) {
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
export function encodeNativeMaterial(value: Material, extensions: MaterialExtensions = new Map()): Uint8Array {
  let wrapped: Record<string, NativeScalar>;
  if (value.texture === null) wrapped = { nullValue: encode(empty, {}, 'texture.null', extensions) };
  else {
    const t = value.texture;
    const fields: Record<string, NativeScalar> = { imageId: t.imageId, widthM: number(t.widthM), heightM: number(t.heightM), colorize: t.colorize };
    if (Object.hasOwn(t, 'colorizeType')) {
      if (t.colorizeType !== undefined && t.colorizeType !== 'shift' && t.colorizeType !== 'tint') return fail();
      fields.colorizeType = encode(optional, t.colorizeType === undefined ? { undefinedValue: encode(empty, {}, 'texture.colorizeType.undefined', extensions) }
        : { value: t.colorizeType === 'shift' ? 0 : 1 }, 'texture.colorizeType', extensions);
    }
    wrapped = { value: encode(texture, fields, 'texture.value', extensions) };
  }
  const color = encode(rgb, { red: number(value.color[0], true), green: number(value.color[1], true), blue: number(value.color[2], true) }, 'color', extensions);
  return encode(material, { id: value.id, name: value.name, color, alpha: number(value.alpha, true), texture: encode(nullable, wrapped, 'texture', extensions) }, '', extensions);
}
export function decodeNativeMaterial(bytes: Uint8Array): { value: Material; extensions: MaterialExtensions } {
  const extensions: MaterialExtensions = new Map(), fields = decode(material, bytes, '', extensions);
  const color = decode(rgb, fields.color as Uint8Array, 'color', extensions), wrapped = decode(nullable, fields.texture as Uint8Array, 'texture', extensions);
  let t: MaterialTexture | null;
  if (state(wrapped, 'nullValue')) { decode(empty, wrapped.nullValue as Uint8Array, 'texture.null', extensions); t = null; }
  else {
    const f = decode(texture, wrapped.value as Uint8Array, 'texture.value', extensions);
    t = { imageId: f.imageId as ImageId, widthM: number(f.widthM), heightM: number(f.heightM), colorize: f.colorize as boolean };
    if (Object.hasOwn(f, 'colorizeType')) {
      const choice = decode(optional, f.colorizeType as Uint8Array, 'texture.colorizeType', extensions);
      if (state(choice, 'undefinedValue')) { decode(empty, choice.undefinedValue as Uint8Array, 'texture.colorizeType.undefined', extensions); t.colorizeType = undefined; }
      else { if (choice.value !== 0 && choice.value !== 1) return fail(); t.colorizeType = choice.value === 0 ? 'shift' : 'tint'; }
    }
  }
  return { value: { id: fields.id as MaterialId, name: fields.name as string, color: [number(color.red, true), number(color.green, true), number(color.blue, true)], alpha: number(fields.alpha, true), texture: t }, extensions };
}
