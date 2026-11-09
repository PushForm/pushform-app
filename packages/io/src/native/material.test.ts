// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { ImageId, MaterialId } from '@pushform/core';
import { DEFAULT_MATERIAL_APPEARANCE } from '@pushform/model';
import type { Material } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeMaterial, encodeNativeMaterial } from './material';
const root = protobuf.loadSync(fileURLToPath(new URL('./material.proto', import.meta.url))).resolveAll();
const schema = root.lookupType('pushform.native.Material');
const fixture = (): Material => ({ id: 1 as MaterialId, name: 'wood', color: [0.1, 0.2, 0.3], alpha: 0.5,
  texture: { imageId: 2 as ImageId, widthM: 1, heightM: 2, colorize: false } });
describe('native material adapter', () => {
  it('preserves optional colorization states and nullable textures', () => {
    for (const choice of ['absent', undefined, 'shift', 'tint', 'null'] as const) {
      const value = fixture();
      if (choice === 'null') value.texture = null;
      else if (choice !== 'absent') value.texture!.colorizeType = choice;
      const bytes = encodeNativeMaterial(value), decoded = decodeNativeMaterial(bytes);
      expect(decoded.value).toEqual(value);
      if (decoded.value.texture) expect(Object.hasOwn(decoded.value.texture, 'colorizeType')).toBe(choice !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('round-trips the grain axis and leaves it absent in older records', () => {
    for (const grain of [undefined, 'width', 'height', 'none'] as const) {
      const value = fixture();
      if (grain) value.texture!.grain = grain;
      const bytes = encodeNativeMaterial(value), decoded = decodeNativeMaterial(bytes);
      expect(decoded.value.texture!.grain).toBe(grain);
      expect(Object.hasOwn(decoded.value.texture!, 'grain')).toBe(grain !== undefined);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
    const wire = schema.decode(encodeNativeMaterial(fixture())) as unknown as { texture: { value: { grain?: number } } };
    wire.texture.value.grain = 7; expect(() => decodeNativeMaterial(schema.encode(wire).finish())).toThrow();
  });
  it('round-trips appearance, zero values and normal-only assets with the protobuf schema', () => {
    const value = fixture(); value.texture = null;
    value.appearance = { ...DEFAULT_MATERIAL_APPEARANCE, roughness: 0, metalness: 1, emissionColor: [0, 0.25, 1], emissionStrength: 7,
      normal: { imageId: 8 as ImageId, strength: 0, flipGreen: true, widthM: 0.5, heightM: 0.2 } };
    const bytes = encodeNativeMaterial(value); expect(decodeNativeMaterial(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    value.appearance.roughness = 2; expect(() => encodeNativeMaterial(value)).toThrow();
  });
  it('preserves per-material image filenames while leaving older texture records unchanged', () => {
    const older=fixture();expect(Object.hasOwn(decodeNativeMaterial(encodeNativeMaterial(older)).value.texture!,'imageName')).toBe(false);
    const value=fixture();value.texture!.imageName='Birch grain \u00e9.png';
    const bytes=encodeNativeMaterial(value);expect(decodeNativeMaterial(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    for(const name of ['', 'x'.repeat(201)]){
      value.texture!.imageName=name;expect(()=>encodeNativeMaterial(value)).toThrow();
      const wire=schema.decode(bytes) as unknown as {texture:{value:{imageName:string}}};wire.texture.value.imageName=name;
      expect(()=>decodeNativeMaterial(schema.encode(wire).finish())).toThrow();
    }

  });
  it('retains unknown texture fields while editing width', () => {
    const future = protobuf.Root.fromJSON(root.toJSON()); future.lookupType('pushform.native.MaterialTexture').add(new protobuf.Field('futureData', 90, 'bytes')); future.resolveAll();
    const newer = future.lookupType('pushform.native.Material');
    const wire = newer.decode(encodeNativeMaterial(fixture())) as unknown as { texture: { value: { futureData: Uint8Array } } };
    wire.texture.value.futureData = new Uint8Array([7, 8]); const bytes = newer.encode(wire).finish();
    const decoded = decodeNativeMaterial(bytes); bytes.fill(0); decoded.value.texture!.widthM = 3;
    const result = newer.decode(encodeNativeMaterial(decoded.value, decoded.extensions)) as unknown as { texture: { value: { futureData: Uint8Array; widthM: number } } };
    expect(result.texture.value.widthM).toBe(3); expect(Array.from(result.texture.value.futureData)).toEqual([7, 8]);
  });
  it('rejects invalid numeric settings and ambiguous wrappers', () => {
    expect(() => encodeNativeMaterial({ ...fixture(), alpha: Infinity })).toThrow();
    const wire = schema.decode(encodeNativeMaterial(fixture())) as unknown as { texture: object };
    wire.texture = {}; expect(() => decodeNativeMaterial(schema.encode(wire).finish())).toThrow();
  });
});
