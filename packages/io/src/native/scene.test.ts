// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { Id, SceneId, StyleId, TagId, TagFolderId } from '@pushform/core';
import type { Scene, FogSettings } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeScene, encodeNativeScene } from './scene';
const root = protobuf.loadSync(fileURLToPath(new URL('./scene.proto', import.meta.url))).resolveAll(), schema = root.lookupType('pushform.native.Scene');
const fixture = (): Scene => ({ id: 1 as SceneId, name: 'Scene', description: 'saved view', camera: { eye: [1, -0, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: true, fov: 35, height: 1 },
  flags: { useCamera: true, useHiddenGeometry: false, useHiddenObjects: true, useTags: true, useStyle: false, useShadows: true, useSectionPlanes: true, useAxes: false },
  hiddenEntities: [3, 2, 3] as Id[], hiddenTags: [6, 5] as TagId[], hiddenTagFolders: [9, 8] as TagFolderId[], styleId: 7 as StyleId,
  shadows: { enabled: true, month: 10, day: 28, time: 720, utcOffsetHours: -7, latitude: 45, longitude: -122,
    northAngle: 0, light: 0.8, dark: 0.2, useSunForShading: true, onGround: false, onFaces: true, fromEdges: false },
  activeSectionPlanes: [11, 10] as Id[], axesVisible: false });
const fog: FogSettings = { enabled: false, near: 1, far: 20, useBackground: true, color: [0.1, 0.2, 0.3] };
describe('native saved scenes', () => {
  it('preserves fog and animation presence, ordered IDs and all schema fields', () => {
    const nullOverrides = { ...fixture(), shadows: null, styleId: null };
    expect(decodeNativeScene(encodeNativeScene(nullOverrides)).value).toEqual(nullOverrides);
    for (const f of ['absent', undefined, null, fog] as const) for (const animation of ['absent', undefined, false, true] as const) {
      const value = fixture(); if (f !== 'absent') value.fog = f; if (animation !== 'absent') value.includeInAnimation = animation;
      const bytes = encodeNativeScene(value), decoded = decodeNativeScene(bytes);
      expect(decoded.value).toEqual(value); expect(Object.hasOwn(decoded.value, 'fog')).toBe(f !== 'absent');
      expect(Object.hasOwn(decoded.value, 'includeInAnimation')).toBe(animation !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('preserves nested environment extensions through a scene edit', () => {
    const future = protobuf.Root.fromJSON(root.toJSON()); future.lookupType('pushform.native.Fog').add(new protobuf.Field('extra', 90, 'bytes')); future.resolveAll();
    const newer = future.lookupType('pushform.native.Scene'), wire = newer.decode(encodeNativeScene({ ...fixture(), fog })) as unknown as { fog: { value: { extra: Uint8Array } } };
    wire.fog.value.extra = new Uint8Array([7, 8]); const bytes = newer.encode(wire).finish(), decoded = decodeNativeScene(bytes); bytes.fill(0);
    decoded.value.name = 'edited'; const restored = newer.decode(encodeNativeScene(decoded.value, decoded.extensions)) as unknown as { name: string; fog: { value: { extra: Uint8Array } } };
    expect(restored.name).toBe('edited'); expect(Array.from(restored.fog.value.extra)).toEqual([7, 8]);
  });
  it('rejects ambiguous fog overrides and invalid packed IDs', () => {
    const wire = schema.decode(encodeNativeScene(fixture())) as unknown as Record<string, unknown>;
    expect(() => decodeNativeScene(schema.encode({ ...wire, fog: { undefinedValue: {}, nullValue: {} } }).finish())).toThrow();
    const value = fixture(); value.hiddenEntities = [-1] as Id[]; expect(() => encodeNativeScene(value)).toThrow();
  });
});
