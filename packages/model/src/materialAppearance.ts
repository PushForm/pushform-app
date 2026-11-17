// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId } from '@pushform/core';
import type { Material, Rgb } from './entities/attrs';

export interface MaterialNormal {
  imageId: ImageId;
  strength: number;
  flipGreen: boolean;
  widthM: number;
  heightM: number;
}
export interface MaterialAppearance {
  roughness: number;
  metalness: number;
  emissionColor: Rgb;
  emissionStrength: number;
  normal: MaterialNormal | null;
}
export const DEFAULT_MATERIAL_APPEARANCE: Readonly<MaterialAppearance> = Object.freeze({
  roughness: 1,
  metalness: 0,
  emissionColor: Object.freeze([1, 1, 1]) as Rgb,
  emissionStrength: 0,
  normal: null,
});
export function materialAppearance(
  material: Pick<Material, 'appearance'>,
): Readonly<MaterialAppearance> {
  return material.appearance ?? DEFAULT_MATERIAL_APPEARANCE;
}
const range = (v: number, max: number) => Number.isFinite(v) && v >= 0 && v <= max;
export function validMaterialAppearance(a: MaterialAppearance): boolean {
  return (
    range(a.roughness, 1) &&
    range(a.metalness, 1) &&
    range(a.emissionStrength, 100) &&
    a.emissionColor.length === 3 &&
    a.emissionColor.every((c) => range(c, 1)) &&
    (a.normal === null ||
      (Number.isInteger(a.normal.imageId) &&
        a.normal.imageId >= 0 &&
        range(a.normal.strength, 2) &&
        typeof a.normal.flipGreen === 'boolean' &&
        Number.isFinite(a.normal.widthM) &&
        a.normal.widthM > 0 &&
        Number.isFinite(a.normal.heightM) &&
        a.normal.heightM > 0))
  );
}
export const MATERIAL_FINISHES = {
  matte: { name: 'Matte', roughness: 1, metalness: 0 },
  satin: { name: 'Satin', roughness: 0.5, metalness: 0 },
  polished: { name: 'Polished', roughness: 0.15, metalness: 0 },
  metal: { name: 'Metal', roughness: 0.25, metalness: 1 },
} as const;
export type MaterialFinish = keyof typeof MATERIAL_FINISHES;
export function materialFinish(a: Readonly<MaterialAppearance>): MaterialFinish | 'custom' {
  return (
    (Object.keys(MATERIAL_FINISHES) as MaterialFinish[]).find((key) => {
      const p = MATERIAL_FINISHES[key];
      return p.roughness === a.roughness && p.metalness === a.metalness && a.emissionStrength === 0;
    }) ?? 'custom'
  );
}
