// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
import { encodeNativeModelMeta, decodeNativeModelMeta } from './modelMeta';
import type { ModelMetaExtensions } from './modelMeta';
import { encodeNativeShadows, decodeNativeShadows, encodeNativeFog, decodeNativeFog } from './viewSettings';
import type { ViewSettingsExtensions } from './viewSettings';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { validateNativeTagHierarchy } from './tags';
export type NativeModelSettings = Omit<DocumentState, 'nativeStyleUnknownFields' | 'nativeSceneUnknownFields' | 'nativeImageUnknownFields' | 'nativeMaterialUnknownFields' | 'nativeTagUnknownFields' | 'nativeSettingsUnknownFields' | 'nativeRootUnknownFields' | 'definitions' | 'materials' | 'tags' | 'tagFolders' | 'styles' | 'scenes' | 'images'>;
export interface ModelSettingsExtensions {
  records: Map<string, Uint8Array[]>;
  meta: ModelMetaExtensions;
  shadows: ViewSettingsExtensions;
  fog?: ViewSettingsExtensions;
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const codec = new NativeRecordCodec({ meta: f(1, 'bytes'), rootDefinitionId: f(2, 'uint32'), defaultTagId: f(3, 'uint32'), defaultMaterialId: f(4, 'uint32'),
  activeStyleId: f(5, 'uint32'), sceneOrder: f(6, 'bytes', false), shadows: f(7, 'bytes'), fog: f(8, 'bytes', false) } satisfies Record<keyof NativeModelSettings, NativeField>);
const optionalFog = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'bytes', false) }), empty = new NativeRecordCodec({});
const fresh = (): ModelSettingsExtensions => ({ records: new Map(), meta: new Map(), shadows: new Map() });
export function encodeNativeModelSettings(value: NativeModelSettings, ext: ModelSettingsExtensions = fresh()): Uint8Array {
  const fields: Record<string, NativeScalar> = { meta: encodeNativeModelMeta(value.meta, ext.meta), rootDefinitionId: value.rootDefinitionId,
    defaultTagId: value.defaultTagId, defaultMaterialId: value.defaultMaterialId, activeStyleId: value.activeStyleId, shadows: encodeNativeShadows(value.shadows, ext.shadows) };
  if (value.sceneOrder.length) fields.sceneOrder = encodeNativeIds(value.sceneOrder);
  if (Object.hasOwn(value, 'fog')) fields.fog = optionalFog.encode({ fields: value.fog === undefined
    ? { undefinedValue: empty.encode({ fields: {}, unknownFields: ext.records.get('fog.undefined') ?? [] }) }
    : { value: encodeNativeFog(value.fog, ext.fog) }, unknownFields: ext.records.get('fog') ?? [] });
  return codec.encode({ fields, unknownFields: ext.records.get('') ?? [] });
}
export function decodeNativeModelSettings(bytes: Uint8Array): { value: NativeModelSettings; extensions: ModelSettingsExtensions } {
  const ext = fresh(), decoded = codec.decode(bytes), f = decoded.fields;
  if (decoded.unknownFields.length) ext.records.set('', decoded.unknownFields);
  const meta = decodeNativeModelMeta(f.meta as Uint8Array), shadows = decodeNativeShadows(f.shadows as Uint8Array);
  ext.meta = meta.extensions; ext.shadows = shadows.extensions;
  const value: NativeModelSettings = { meta: meta.value, rootDefinitionId: f.rootDefinitionId as DocumentState['rootDefinitionId'],
    defaultTagId: f.defaultTagId as DocumentState['defaultTagId'], defaultMaterialId: f.defaultMaterialId as DocumentState['defaultMaterialId'],
    activeStyleId: f.activeStyleId as DocumentState['activeStyleId'], sceneOrder: decodeNativeIds(f.sceneOrder as Uint8Array | undefined) as DocumentState['sceneOrder'], shadows: shadows.value };
  if (Object.hasOwn(f, 'fog')) {
    const fog = optionalFog.decode(f.fog as Uint8Array); if (fog.unknownFields.length) ext.records.set('fog', fog.unknownFields);
    if (Object.keys(fog.fields).length !== 1) throw new NativeChunkError('Invalid native document fog');
    if (Object.hasOwn(fog.fields, 'undefinedValue')) {
      const state = empty.decode(fog.fields.undefinedValue as Uint8Array); if (state.unknownFields.length) ext.records.set('fog.undefined', state.unknownFields); value.fog = undefined;
    } else { const record = decodeNativeFog(fog.fields.value as Uint8Array); value.fog = record.value; ext.fog = record.extensions; }
  }
  return { value, extensions: ext };
}

/** Cross-catalog checks after staging records, before any Document installation. */
export function validateNativeModelCatalogs(settings: NativeModelSettings, state: Pick<DocumentState, 'tags' | 'tagFolders' | 'materials' | 'styles' | 'scenes' | 'images'> & { definitions: ReadonlyMap<DocumentState['rootDefinitionId'], unknown> }): void {
  const fail = (): never => { throw new NativeChunkError('Invalid native document reference'); };
  if (!state.definitions.has(settings.rootDefinitionId) || !state.tags.has(settings.defaultTagId) ||
      !state.materials.has(settings.defaultMaterialId) || !state.styles.has(settings.activeStyleId)) fail();
  if (new Set(settings.sceneOrder).size !== settings.sceneOrder.length || settings.sceneOrder.length !== state.scenes.size) fail();
  for (const id of settings.sceneOrder) if (!state.scenes.has(id)) fail();
  validateNativeTagHierarchy(state.tags, state.tagFolders);
  for (const [id, material] of state.materials) if (material.id !== id || (material.texture && !state.images.has(material.texture.imageId))) fail();
  for (const [id, image] of state.images) if (image.id !== id) fail();
  for (const [id, style] of state.styles) {
    if (style.id !== id) fail(); for (const watermark of style.watermarks) if (!state.images.has(watermark.imageId)) fail();
  }
  for (const [id, scene] of state.scenes) {
    if (scene.id !== id || (scene.styleId !== null && !state.styles.has(scene.styleId))) fail();
    for (const tag of scene.hiddenTags) if (!state.tags.has(tag)) fail();
    for (const folder of scene.hiddenTagFolders) if (!state.tagFolders.has(folder)) fail();
  }
}
