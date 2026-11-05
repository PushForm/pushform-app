// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { validEnvironment, validSceneLight } from '@pushform/model';
import type { EnvironmentSettings, SceneLight } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { NativeChunkError } from './chunks';

const environmentFields = {
  preset: { id: 1, kind: 'string', required: true },
  studioEnabled: { id: 2, kind: 'bool', required: true },
  brightness: { id: 3, kind: 'double', required: true },
  fill: { id: 4, kind: 'double', required: true },
  facing: { id: 5, kind: 'double', required: true },
  key: { id: 6, kind: 'double', required: true },
  azimuth: { id: 7, kind: 'double', required: true },
  elevation: { id: 8, kind: 'double', required: true },
  followCamera: { id: 9, kind: 'bool', required: true },
  studioShadows: { id: 10, kind: 'bool', required: true },
  sunEnabled: { id: 11, kind: 'bool', required: true },
  sunIntensity: { id: 12, kind: 'double', required: true },
  sunShadows: { id: 13, kind: 'bool', required: true },
  skyLight: { id: 14, kind: 'double', required: true },
  sky: { id: 15, kind: 'string', required: true },
  skyboxImageId: { id: 16, kind: 'uint32', required: true },
  skyRotation: { id: 17, kind: 'double', required: true },
  sceneLightsEnabled: { id: 18, kind: 'bool', required: true },
} satisfies Record<keyof EnvironmentSettings, NativeField>;
const environment = new NativeRecordCodec(environmentFields);
const light = new NativeRecordCodec({
  id: { id: 1, kind: 'uint32', required: true },
  name: { id: 2, kind: 'string', required: true },
  type: { id: 3, kind: 'string', required: true },
  px: { id: 4, kind: 'double', required: true },
  py: { id: 5, kind: 'double', required: true },
  pz: { id: 6, kind: 'double', required: true },
  tx: { id: 7, kind: 'double', required: true },
  ty: { id: 8, kind: 'double', required: true },
  tz: { id: 9, kind: 'double', required: true },
  lumens: { id: 10, kind: 'double', required: true },
  temperature: { id: 11, kind: 'double', required: true },
  enabled: { id: 12, kind: 'bool', required: true },
  castShadow: { id: 13, kind: 'bool', required: true },
  angle: { id: 14, kind: 'double', required: true },
  penumbra: { id: 15, kind: 'double', required: true },
  width: { id: 16, kind: 'double', required: true },
  height: { id: 17, kind: 'double', required: true },
});
export function encodeNativeEnvironment(
  value: EnvironmentSettings,
  unknownFields: Uint8Array[] = [],
): Uint8Array {
  if (!validEnvironment(value)) throw new NativeChunkError('Invalid native environment');
  return environment.encode({
    fields: { ...value, skyboxImageId: value.skyboxImageId ?? 0 },
    unknownFields,
  });
}
export function decodeNativeEnvironment(bytes: Uint8Array): {
  value: EnvironmentSettings;
  unknownFields: Uint8Array[];
} {
  const record = environment.decode(bytes);
  const value = {
    ...record.fields,
    skyboxImageId: record.fields.skyboxImageId || null,
  } as unknown as EnvironmentSettings;
  if (!validEnvironment(value)) throw new NativeChunkError('Invalid native environment');
  return { value, unknownFields: record.unknownFields };
}
export function encodeNativeSceneLight(value: SceneLight): Uint8Array {
  if (!validSceneLight(value)) throw new NativeChunkError('Invalid native scene light');
  const { position, target, nativeUnknownFields, ...fields } = value;
  return light.encode({
    fields: {
      ...fields,
      px: position[0],
      py: position[1],
      pz: position[2],
      tx: target[0],
      ty: target[1],
      tz: target[2],
    },
    unknownFields: nativeUnknownFields ?? [],
  });
}
export function decodeNativeSceneLight(bytes: Uint8Array): SceneLight {
  const { fields, unknownFields } = light.decode(bytes),
    { px, py, pz, tx, ty, tz, ...rest } = fields as Record<string, NativeScalar>;
  const value = {
    ...rest,
    position: [px, py, pz],
    target: [tx, ty, tz],
    ...(unknownFields.length ? { nativeUnknownFields: unknownFields } : {}),
  } as unknown as SceneLight;
  if (!validSceneLight(value)) throw new NativeChunkError('Invalid native scene light');
  return value;
}
