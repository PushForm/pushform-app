// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { createDocumentState } from '@pushform/model';
import type { SceneId, ImageId } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { decodeNativeModelSettings, encodeNativeModelSettings, validateNativeModelCatalogs } from './modelSettings';
const schema = protobuf.loadSync(fileURLToPath(new URL('./modelSettings.proto', import.meta.url))).resolveAll().lookupType('pushform.native.ModelSettings');
describe('native model settings', () => {
  it('round trips real document settings with all fog presence states', () => {
    const state = createDocumentState();
    const { definitions: _d, materials: _m, tags: _t, tagFolders: _tf, styles: _st, scenes: _sc, images: _i, ...settings } = state;
    for (const variant of ['absent', 'undefined', 'value']) {
      const value = { ...settings }; if (variant === 'absent') delete value.fog; else if (variant === 'undefined') value.fog = undefined;
      const bytes = encodeNativeModelSettings(value), decoded = decodeNativeModelSettings(bytes);
      expect(decoded.value).toEqual(value); expect(Object.hasOwn(decoded.value, 'fog')).toBe(variant !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('validates default catalog references and rejects dangling scene and image references', () => {
    const state = createDocumentState(); expect(() => validateNativeModelCatalogs(state, state)).not.toThrow();
    expect(() => validateNativeModelCatalogs({ ...state, sceneOrder: [999 as SceneId] }, state)).toThrow();
    const material = state.materials.get(state.defaultMaterialId)!;
    state.materials.set(material.id, { ...material, texture: { imageId: 999 as ImageId, widthM: 1, heightM: 1, colorize: false } });
    expect(() => validateNativeModelCatalogs(state, state)).toThrow();
  });
});
