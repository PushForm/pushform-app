// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId, MaterialId } from '@pushform/core';
import { validMaterialAppearance } from '@pushform/model';
import type { MaterialAppearance } from '@pushform/model';
import type { Material, MaterialTexture } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const material = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), color: f(3, 'bytes'), alpha: f(4, 'double'), texture: f(5, 'bytes'), appearance: f(6, 'bytes', false) } satisfies Record<keyof Material, NativeField>);
const texture = new NativeRecordCodec({ imageId: f(1, 'uint32'), widthM: f(2, 'double'), heightM: f(3, 'double'), colorize: f(4, 'bool'), colorizeType: f(5, 'bytes', false), grain: f(6, 'uint32', false), imageName: f(7, 'string', false) } satisfies Record<keyof MaterialTexture, NativeField>);
const appearance = new NativeRecordCodec({ roughness: f(1, 'double'), metalness: f(2, 'double'), emissionColor: f(3, 'bytes'), emissionStrength: f(4, 'double'), normal: f(5, 'bytes', false) });
const normal = new NativeRecordCodec({ imageId: f(1, 'uint32'), strength: f(2, 'double'), flipGreen: f(3, 'bool'), widthM: f(4, 'double'), heightM: f(5, 'double') });

const rgb = new NativeRecordCodec({ red: f(1, 'double'), green: f(2, 'double'), blue: f(3, 'double') });
const nullable = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'bytes', false) });
const optional = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'uint32', false) });
const empty = new NativeRecordCodec({});
const GRAINS = ['width', 'height', 'none'] as const;
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
    if (t.grain !== undefined) {
      const grain = GRAINS.indexOf(t.grain);
      if (grain < 0) return fail();
      fields.grain = grain;
    }
    if (Object.hasOwn(t, 'imageName')) {
      if (typeof t.imageName !== 'string' || !t.imageName.length || t.imageName.length > 200) return fail();
      fields.imageName = t.imageName;
    }
    wrapped = { value: encode(texture, fields, 'texture.value', extensions) };
  }
  const color = encode(rgb, { red: number(value.color[0], true), green: number(value.color[1], true), blue: number(value.color[2], true) }, 'color', extensions);
  return encode(material, { id: value.id, name: value.name, color, alpha: number(value.alpha, true), texture: encode(nullable, wrapped, 'texture', extensions), ...(value.appearance ? { appearance: encodeAppearance(value.appearance, extensions) } : {}) }, '', extensions);
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
    if (Object.hasOwn(f, 'grain')) t.grain = GRAINS[f.grain as number] ?? fail();
    if (Object.hasOwn(f, 'imageName')) {
      if (typeof f.imageName !== 'string' || !f.imageName.length || f.imageName.length > 200) return fail();
      t.imageName = f.imageName;
    }
  }
  return { value: { id: fields.id as MaterialId, name: fields.name as string, color: [number(color.red, true), number(color.green, true), number(color.blue, true)], alpha: number(fields.alpha, true), texture: t, ...(fields.appearance ? { appearance: decodeAppearance(fields.appearance as Uint8Array, extensions) } : {}) }, extensions };
}

function encodeAppearance(a: MaterialAppearance, extensions: MaterialExtensions): Uint8Array {
  if (!validMaterialAppearance(a)) return fail();
  return encode(appearance, { roughness: a.roughness, metalness: a.metalness, emissionStrength: a.emissionStrength,
    emissionColor: encode(rgb, { red: a.emissionColor[0], green: a.emissionColor[1], blue: a.emissionColor[2] }, 'appearance.color', extensions),
    ...(a.normal ? { normal: encode(normal, { ...a.normal }, 'appearance.normal', extensions) } : {}) }, 'appearance', extensions);
}
function decodeAppearance(bytes: Uint8Array, extensions: MaterialExtensions): MaterialAppearance {
  const a = decode(appearance, bytes, 'appearance', extensions), c = decode(rgb, a.emissionColor as Uint8Array, 'appearance.color', extensions);
  const n = a.normal ? decode(normal, a.normal as Uint8Array, 'appearance.normal', extensions) : null;
  const value: MaterialAppearance = { roughness: a.roughness as number, metalness: a.metalness as number, emissionStrength: a.emissionStrength as number,
    emissionColor: [c.red as number, c.green as number, c.blue as number], normal: n ? { imageId: n.imageId as ImageId, strength: n.strength as number, flipGreen: n.flipGreen as boolean, widthM: n.widthM as number, heightM: n.heightM as number } : null };
  if (!validMaterialAppearance(value)) return fail();
  return value;
}
