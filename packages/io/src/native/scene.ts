// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Scene, SceneFlags } from '@pushform/model';
import type { SceneId, StyleId } from '@pushform/core';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { encodeNativeCamera, decodeNativeCamera, encodeNativeFog, decodeNativeFog, encodeNativeShadows, decodeNativeShadows } from './viewSettings';
import type { ViewSettingsExtensions } from './viewSettings';
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const schema = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), description: f(3, 'string'), camera: f(4, 'bytes'), flags: f(5, 'bytes'),
  hiddenEntities: f(6, 'bytes', false), hiddenTags: f(7, 'bytes', false), hiddenTagFolders: f(8, 'bytes', false), styleId: f(9, 'bytes'), shadows: f(10, 'bytes'),
  fog: f(11, 'bytes', false), activeSectionPlanes: f(12, 'bytes', false), axesVisible: f(13, 'bool'), includeInAnimation: f(14, 'bytes', false) } satisfies Record<keyof Scene, NativeField>);
const flags = new NativeRecordCodec({ useCamera: f(1, 'bool'), useHiddenGeometry: f(2, 'bool'), useHiddenObjects: f(3, 'bool'), useTags: f(4, 'bool'),
  useStyle: f(5, 'bool'), useShadows: f(6, 'bool'), useSectionPlanes: f(7, 'bool'), useAxes: f(8, 'bool') } satisfies Record<keyof SceneFlags, NativeField>);
const nullableId = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'uint32', false) });
const nullableBytes = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'bytes', false) });
const optionalFog = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), nullValue: f(2, 'bytes', false), value: f(3, 'bytes', false) });
const optionalBool = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'bool', false) });
const empty = new NativeRecordCodec({});
export interface SceneExtensions { records: Map<string, Uint8Array[]>; camera: ViewSettingsExtensions; shadows?: ViewSettingsExtensions; fog?: ViewSettingsExtensions }
const fresh = (): SceneExtensions => ({ records: new Map(), camera: new Map() });
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: SceneExtensions) {
  const r = codec.decode(bytes); if (r.unknownFields.length) ext.records.set(path, r.unknownFields); return r.fields;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, ext: SceneExtensions) {
  return codec.encode({ fields, unknownFields: ext.records.get(path) ?? [] });
}
function arm(value: Record<string, NativeScalar>): string {
  const keys = Object.keys(value); if (keys.length !== 1) throw new NativeChunkError('Invalid native scene wrapper'); return keys[0]!;
}
export function encodeNativeScene(value: Scene, ext: SceneExtensions = fresh()): Uint8Array {
  const nil = (path: string) => write(empty, {}, path, ext);
  const fields: Record<string, NativeScalar> = { id: value.id, name: value.name, description: value.description, camera: encodeNativeCamera(value.camera, ext.camera),
    flags: write(flags, { ...value.flags }, 'flags', ext), axesVisible: value.axesVisible,
    styleId: write(nullableId, value.styleId === null ? { nullValue: nil('styleId.null') } : { value: value.styleId }, 'styleId', ext),
    shadows: write(nullableBytes, value.shadows === null ? { nullValue: nil('shadows.null') } : { value: encodeNativeShadows(value.shadows, ext.shadows) }, 'shadows', ext) };
  for (const key of ['hiddenEntities', 'hiddenTags', 'hiddenTagFolders', 'activeSectionPlanes'] as const) if (value[key].length) fields[key] = encodeNativeIds(value[key]);
  if (Object.hasOwn(value, 'fog')) fields.fog = write(optionalFog, value.fog === undefined ? { undefinedValue: nil('fog.undefined') }
    : value.fog === null ? { nullValue: nil('fog.null') } : { value: encodeNativeFog(value.fog, ext.fog) }, 'fog', ext);
  if (Object.hasOwn(value, 'includeInAnimation')) fields.includeInAnimation = write(optionalBool,
    value.includeInAnimation === undefined ? { undefinedValue: nil('animation.undefined') } : { value: value.includeInAnimation }, 'animation', ext);
  return write(schema, fields, '', ext);
}
export function decodeNativeScene(bytes: Uint8Array): { value: Scene; extensions: SceneExtensions } {
  const ext = fresh(), fields = read(schema, bytes, '', ext), camera = decodeNativeCamera(fields.camera as Uint8Array); ext.camera = camera.extensions;
  const style = read(nullableId, fields.styleId as Uint8Array, 'styleId', ext), shadows = read(nullableBytes, fields.shadows as Uint8Array, 'shadows', ext);
  const value: Scene = { id: fields.id as SceneId, name: fields.name as string, description: fields.description as string, camera: camera.value,
    flags: { ...read(flags, fields.flags as Uint8Array, 'flags', ext) } as unknown as SceneFlags,
    hiddenEntities: decodeNativeIds(fields.hiddenEntities as Uint8Array | undefined) as Scene['hiddenEntities'],
    hiddenTags: decodeNativeIds(fields.hiddenTags as Uint8Array | undefined) as Scene['hiddenTags'],
    hiddenTagFolders: decodeNativeIds(fields.hiddenTagFolders as Uint8Array | undefined) as Scene['hiddenTagFolders'],
    activeSectionPlanes: decodeNativeIds(fields.activeSectionPlanes as Uint8Array | undefined) as Scene['activeSectionPlanes'],
    styleId: null, shadows: null, axesVisible: fields.axesVisible as boolean };
  if (arm(style) === 'nullValue') read(empty, style.nullValue as Uint8Array, 'styleId.null', ext); else value.styleId = style.value as StyleId;
  if (arm(shadows) === 'nullValue') read(empty, shadows.nullValue as Uint8Array, 'shadows.null', ext);
  else { const decoded = decodeNativeShadows(shadows.value as Uint8Array); value.shadows = decoded.value; ext.shadows = decoded.extensions; }
  if (Object.hasOwn(fields, 'fog')) {
    const fog = read(optionalFog, fields.fog as Uint8Array, 'fog', ext), key = arm(fog);
    if (key === 'value') { const decoded = decodeNativeFog(fog.value as Uint8Array); value.fog = decoded.value; ext.fog = decoded.extensions; }
    else { read(empty, fog[key] as Uint8Array, key === 'nullValue' ? 'fog.null' : 'fog.undefined', ext); value.fog = key === 'nullValue' ? null : undefined; }
  }
  if (Object.hasOwn(fields, 'includeInAnimation')) {
    const animation = read(optionalBool, fields.includeInAnimation as Uint8Array, 'animation', ext);
    if (arm(animation) === 'value') value.includeInAnimation = animation.value as boolean;
    else { read(empty, animation.undefinedValue as Uint8Array, 'animation.undefined', ext); value.includeInAnimation = undefined; }
  }
  return { value, extensions: ext };
}
