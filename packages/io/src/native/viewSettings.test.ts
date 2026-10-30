// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { CameraState, FogSettings, ShadowSettings } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeCamera, decodeNativeFog, decodeNativeShadows, encodeNativeCamera, encodeNativeFog, encodeNativeShadows } from './viewSettings';
const root = protobuf.loadSync(fileURLToPath(new URL('./viewSettings.proto', import.meta.url))).resolveAll();
const camera: CameraState = { eye: [1, -0, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: false, fov: 35, height: 12 };
const fog: FogSettings = { enabled: true, near: 2, far: 123.4, useBackground: false, color: [0.2, 0.4, 0.6] };
const shadows: ShadowSettings = { enabled: true, month: 10, day: 28, time: 721.5, utcOffsetHours: -7, latitude: 45.6,
  longitude: -122.3, northAngle: 45, light: 0.8, dark: 0.2, useSunForShading: true, onGround: false, onFaces: true, fromEdges: false };
describe('native camera and environment adapters', () => {
  it('round trips all source fields and matches the concrete schemas', () => {
    expect(decodeNativeCamera(encodeNativeCamera(camera)).value).toEqual(camera);
    expect(decodeNativeShadows(encodeNativeShadows(shadows)).value).toEqual(shadows);
    expect(decodeNativeFog(encodeNativeFog(fog)).value).toEqual(fog);
    for (const [name, bytes] of [['Camera', encodeNativeCamera(camera)], ['Shadows', encodeNativeShadows(shadows)], ['Fog', encodeNativeFog(fog)]] as const) {
      const type = root.lookupType(`pushform.native.${name}`); expect(Array.from(type.encode(type.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves nested camera extensions while changing the eye', () => {
    const future = protobuf.Root.fromJSON(root.toJSON()); future.lookupType('pushform.native.Vec3').add(new protobuf.Field('extra', 90, 'bytes')); future.resolveAll();
    const schema = future.lookupType('pushform.native.Camera'), wire = schema.decode(encodeNativeCamera(camera)) as unknown as { eye: { extra: Uint8Array } };
    wire.eye.extra = new Uint8Array([7, 8]); const bytes = schema.encode(wire).finish(), decoded = decodeNativeCamera(bytes); bytes.fill(0);
    decoded.value.eye = [3, 4, 5]; const restored = schema.decode(encodeNativeCamera(decoded.value, decoded.extensions)) as unknown as { eye: { x: number; extra: Uint8Array } };
    expect(restored.eye.x).toBe(3); expect(Array.from(restored.eye.extra)).toEqual([7, 8]);
  });
  it('rejects nonfinite values and missing required environment fields', () => {
    expect(() => encodeNativeFog({ ...fog, far: NaN })).toThrow();
    expect(() => encodeNativeCamera({ ...camera, eye: [Infinity, 0, 0] })).toThrow();
    const schema = root.lookupType('pushform.native.Shadows'); expect(() => decodeNativeShadows(schema.encode({ enabled: true }).finish())).toThrow();
  });
});
