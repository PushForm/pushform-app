// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, ImageId, Vec3 } from '@pushform/core';

export type EnvironmentPreset = 'bright' | 'soft' | 'daylight' | 'night' | 'custom';
export type EnvironmentSky = 'solid' | 'clear' | 'overcast' | 'night' | 'image';

/** Appearance belongs to a style. Geographic/time settings and light placement belong to the model. */
export interface EnvironmentSettings {
  preset: EnvironmentPreset;
  studioEnabled: boolean;
  brightness: number;
  fill: number;
  facing: number;
  key: number;
  azimuth: number;
  elevation: number;
  followCamera: boolean;
  studioShadows: boolean;
  sunEnabled: boolean;
  sunIntensity: number;
  sunShadows: boolean;
  skyLight: number;
  sky: EnvironmentSky;
  skyboxImageId: ImageId | null;
  skyRotation: number;
  sceneLightsEnabled: boolean;
}

export interface SceneLight {
  id: Id;
  name: string;
  type: 'point' | 'spot' | 'area';
  position: Vec3;
  target: Vec3;
  lumens: number;
  temperature: number;
  enabled: boolean;
  castShadow: boolean;
  angle: number;
  penumbra: number;
  width: number;
  height: number;
  nativeUnknownFields?: Uint8Array[];
}

export const ENVIRONMENT_PRESETS = [
  { id: 'bright', name: 'Bright Studio' },
  { id: 'soft', name: 'Soft Studio' },
  { id: 'daylight', name: 'Daylight' },
  { id: 'night', name: 'Night interior' },
] as const;
export const MAX_SCENE_LIGHTS = 8;
export const MAX_SCENE_SHADOW_SAMPLES = 6;

export function environmentPreset(
  preset: Exclude<EnvironmentPreset, 'custom'>,
): EnvironmentSettings {
  const base: EnvironmentSettings = {
    preset,
    studioEnabled: true,
    brightness: 1,
    fill: 0.8,
    facing: 0.18,
    key: 0.08,
    azimuth: (Math.atan2(-0.35, 0.7) * 180) / Math.PI,
    elevation: (Math.atan2(0.62, Math.hypot(-0.35, 0.7)) * 180) / Math.PI,
    followCamera: true,
    studioShadows: false,
    sunEnabled: false,
    sunIntensity: 1,
    sunShadows: false,
    skyLight: 0,
    sky: 'solid',
    skyboxImageId: null,
    skyRotation: 0,
    sceneLightsEnabled: false,
  };
  if (preset === 'soft') Object.assign(base, { fill: 0.64, facing: 0.22, key: 0.18 });
  if (preset === 'daylight')
    Object.assign(base, {
      studioEnabled: false,
      sunEnabled: true,
      sunShadows: true,
      skyLight: 0.5,
      sky: 'clear',
      sceneLightsEnabled: true,
    });
  if (preset === 'night')
    Object.assign(base, {
      studioEnabled: false,
      skyLight: 0.025,
      sky: 'night',
      sceneLightsEnabled: true,
    });
  return base;
}

export function defaultSceneLight(type: SceneLight['type'] = 'point'): Omit<SceneLight, 'id'> {
  return {
    name: type === 'point' ? 'Point light' : type === 'spot' ? 'Spot light' : 'Area light',
    type,
    position: [0, 0, 2],
    target: [0, 0, 0],
    lumens: 800,
    temperature: 3000,
    enabled: true,
    castShadow: true,
    angle: 45,
    penumbra: 0.3,
    width: 1,
    height: 1,
  };
}

export function sceneShadowSamples(lights: readonly SceneLight[]): number {
  return lights.reduce(
    (sum, light) =>
      sum +
      (light.enabled && light.lumens > 0 && light.castShadow ? (light.type === 'area' ? 4 : 1) : 0),
    0,
  );
}

export const ENVIRONMENT_RANGES = {
  brightness: [0, 1.5],
  fill: [0, 1],
  facing: [0, 1],
  key: [0, 1],
  azimuth: [-180, 180],
  elevation: [-90, 90],
  sunIntensity: [0, 2],
  skyLight: [0, 2],
  skyRotation: [-180, 180],
} as const;

export function validEnvironment(value: EnvironmentSettings): boolean {
  return (
    ['bright', 'soft', 'daylight', 'night', 'custom'].includes(value.preset) &&
    ['solid', 'clear', 'overcast', 'night', 'image'].includes(value.sky) &&
    Object.entries(ENVIRONMENT_RANGES).every(([key, range]) => {
      const n = value[key as keyof typeof ENVIRONMENT_RANGES];
      return Number.isFinite(n) && n >= range[0] && n <= range[1];
    }) &&
    [
      'studioEnabled',
      'followCamera',
      'studioShadows',
      'sunEnabled',
      'sunShadows',
      'sceneLightsEnabled',
    ].every((key) => typeof value[key as keyof EnvironmentSettings] === 'boolean') &&
    (value.skyboxImageId === null ||
      (Number.isInteger(value.skyboxImageId) &&
        value.skyboxImageId > 0 &&
        value.skyboxImageId <= 0xffffffff)) &&
    (value.sky !== 'image' || value.skyboxImageId !== null)
  );
}

export function validSceneLight(value: SceneLight): boolean {
  return (
    Number.isInteger(value.id) &&
    value.id > 0 &&
    value.id <= 0xffffffff &&
    typeof value.name === 'string' &&
    !!value.name.trim() &&
    value.name.length <= 100 &&
    ['point', 'spot', 'area'].includes(value.type) &&
    typeof value.enabled === 'boolean' &&
    typeof value.castShadow === 'boolean' &&
    [value.position, value.target].every(
      (v) =>
        Array.isArray(v) &&
        v.length === 3 &&
        v.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e9),
    ) &&
    Number.isFinite(value.lumens) &&
    value.lumens >= 0 &&
    value.lumens <= 100000 &&
    Number.isFinite(value.temperature) &&
    value.temperature >= 1000 &&
    value.temperature <= 12000 &&
    Number.isFinite(value.angle) &&
    value.angle >= 1 &&
    value.angle <= 178 &&
    Number.isFinite(value.penumbra) &&
    value.penumbra >= 0 &&
    value.penumbra <= 1 &&
    Number.isFinite(value.width) &&
    value.width >= 0.001 &&
    value.width <= 1000 &&
    Number.isFinite(value.height) &&
    value.height >= 0.001 &&
    value.height <= 1000 &&
    (value.type === 'point' || value.position.some((n, i) => n !== value.target[i]))
  );
}

/** Display approximation of the black-body locus, using Tanner Helland's temperature/RGB fit.
 * https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html */
export function temperatureColor(kelvin: number): Vec3 {
  const t = Math.min(12000, Math.max(1000, kelvin)) / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [
    clamp(t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592),
    clamp(
      t <= 66
        ? 99.4708025861 * Math.log(t) - 161.1195681661
        : 288.1221695283 * (t - 60) ** -0.0755148492,
    ),
    clamp(t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307),
  ];
}
