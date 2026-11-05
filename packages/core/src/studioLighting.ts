// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from './math';

/** Shared studio lighting. Coefficients multiply linear light, not display RGB. */
export const STUDIO_LIGHTING = {
  soft: { ambient: .64, facing: .22, key: .18 },
  bright: { ambient: .80, facing: .18, key: .08 },
} as const;
export type StudioLightingPreset = keyof typeof STUDIO_LIGHTING;
const keyLength = Math.hypot(-.35, .7, .62);
export const STUDIO_KEY: Vec3 = [-.35 / keyLength, .7 / keyLength, .62 / keyLength];
export const srgbToLinear = (c: number): number => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
export const linearToSrgb = (c: number): number => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055;
export function studioIllumination(normal: Vec3, preset: StudioLightingPreset = 'soft'): number {
  const p = STUDIO_LIGHTING[preset];
  const key = Math.max(0, normal[0] * STUDIO_KEY[0] + normal[1] * STUDIO_KEY[1] + normal[2] * STUDIO_KEY[2]);
  return Math.min(1, p.ambient + p.facing * Math.max(0, normal[2]) + p.key * key);
}
export function studioColor(color: Vec3, normal: Vec3, preset: StudioLightingPreset = 'soft'): Vec3 {
  const light = studioIllumination(normal, preset);
  const channel = (c: number): number => linearToSrgb(srgbToLinear(c) * light);
  return [channel(color[0]), channel(color[1]), channel(color[2])];
}
