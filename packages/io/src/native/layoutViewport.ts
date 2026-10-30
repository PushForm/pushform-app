// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutViewport, LayoutViewportCamera, LayoutViewportDisplay, LayoutViewportSource, ModelReference, LayoutModelArchive } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { encodeNativeShadows, decodeNativeShadows } from './viewSettings';
import type { ViewSettingsExtensions } from './viewSettings';
export interface LayoutViewportExtensions { records: Map<string, Uint8Array[]>; shadows: ViewSettingsExtensions }
/** Put nested record fields on their editable owners before camera/cache/source replacement. */
export function attachNativeLayoutViewportFields(value: LayoutViewport, extensions: LayoutViewportExtensions): void {
  const records = new Map(extensions.records);
  for (const [key, owner] of [['source', value.source], ['camera', value.camera], ['cache.camera', value.cache?.camera]] as const) {
    const fields = records.get(key);
    if (owner && fields) { owner.nativeUnknownFields = fields; records.delete(key); }
  }
  for (const [prefix, owner, root] of [['cache', value.cache, 'cache'], ['display', value.display, 'display.value']] as const) if (owner) {
    const fields = new Map<string, Uint8Array[]>();
    for (const [key, bytes] of records) if (key === root || key.startsWith(`${prefix}.`)) {
      fields.set(key === root ? '' : key.slice(prefix.length + 1), bytes); records.delete(key);
    }
    if (fields.size) owner.nativeUnknownFields = fields;
  }
  if (value.display?.shadows && extensions.shadows.size) value.display.shadows.nativeUnknownFields = extensions.shadows;
  if (records.size) value.nativeUnknownFields = records;
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const camera = new NativeRecordCodec({ eye: f(1, 'bytes'), target: f(2, 'bytes'), up: f(3, 'bytes'), projection: f(4, 'uint32'), fov: f(5, 'double'), scale: f(6, 'double'), shift: f(7, 'bytes', false) } satisfies Record<Exclude<keyof LayoutViewportCamera, 'nativeUnknownFields'>, NativeField>);
const source = new NativeRecordCodec({ kind: f(1, 'uint32'), archiveId: f(2, 'string', false), modelReferenceId: f(3, 'string', false), referenceId: f(4, 'uint32', false) });
const display = new NativeRecordCodec({ faceStyle: f(1, 'uint32'), edges: f(2, 'bool'), profiles: f(3, 'bool'), backEdges: f(4, 'bool'), xray: f(5, 'bool'), hiddenGeometry: f(6, 'bool'), shadows: f(7, 'bytes', false) } satisfies Record<Exclude<keyof LayoutViewportDisplay, 'nativeUnknownFields'>, NativeField>);
const cache = new NativeRecordCodec({ camera: f(1, 'bytes'), widthMm: f(2, 'double'), heightMm: f(3, 'double'), sha256: f(4, 'bytes', false) } satisfies Record<Exclude<keyof NonNullable<LayoutViewport['cache']>, 'nativeUnknownFields'>, NativeField>);
const viewport = new NativeRecordCodec({ source: f(1, 'bytes'), templateId: f(2, 'string', false), originalId: f(3, 'string', false), camera: f(4, 'bytes'), preserveScaleOnResize: f(5, 'uint32', false),
  scene: f(6, 'string', false), background: f(7, 'string', false), cache: f(8, 'bytes', false), display: f(9, 'bytes', false) } satisfies Record<Exclude<keyof LayoutViewport, 'nativeUnknownFields'>, NativeField>);
const optional = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'bytes', false) });
const optionalString = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'string', false) });
const styles = ['wireframe', 'hiddenLine', 'shaded', 'shadedTextured', 'monochrome'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout viewport'); };
function finite(n: unknown): number { if (typeof n !== 'number' || !Number.isFinite(n)) return fail(); return n; }
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, key: string, ext: LayoutViewportExtensions) { return codec.encode({ fields, unknownFields: ext.records.get(key) ?? [] }); }
function read(codec: NativeRecordCodec, bytes: Uint8Array, key: string, ext: LayoutViewportExtensions) { const r = codec.decode(bytes); if (r.unknownFields.length) ext.records.set(key, r.unknownFields); return r.fields; }
function wrap(codec: NativeRecordCodec, value: NativeScalar | undefined, key: string, ext: LayoutViewportExtensions) { return write(codec, value === undefined ? { state: 0 } : { state: 1, value }, key, ext); }
function unwrap(codec: NativeRecordCodec, bytes: Uint8Array, key: string, ext: LayoutViewportExtensions): NativeScalar | undefined {
  const r = read(codec, bytes, key, ext), has = Object.hasOwn(r, 'value');
  if (r.state === 0 && !has) return undefined; if (r.state === 1 && has) return r.value; return fail();
}
function writeCamera(c: LayoutViewportCamera, key: string, ext: LayoutViewportExtensions): Uint8Array {
  if (c.projection !== 'perspective' && c.projection !== 'parallel') return fail();
  const fields: Record<string, NativeScalar> = { eye: encodeNativeNumbers(c.eye, 3), target: encodeNativeNumbers(c.target, 3), up: encodeNativeNumbers(c.up, 3),
    projection: c.projection === 'perspective' ? 0 : 1, fov: finite(c.fov), scale: finite(c.scale) };
  if (Object.hasOwn(c, 'shift')) fields.shift = c.shift === undefined ? new Uint8Array() : encodeNativeNumbers(c.shift, 2);
  return camera.encode({ fields, unknownFields: c.nativeUnknownFields ?? ext.records.get(key) ?? [] });
}
function writeShadows(value: NonNullable<LayoutViewportDisplay['shadows']>, ext: ViewSettingsExtensions): Uint8Array {
  const { nativeUnknownFields: _fields, ...known } = value;
  return encodeNativeShadows(known, ext);
}
function readCamera(bytes: Uint8Array, key: string, ext: LayoutViewportExtensions): LayoutViewportCamera {
  const c = read(camera, bytes, key, ext); if (c.projection !== 0 && c.projection !== 1) return fail();
  const value: LayoutViewportCamera = { eye: decodeNativeNumbers(c.eye as Uint8Array, 3) as [number, number, number], target: decodeNativeNumbers(c.target as Uint8Array, 3) as [number, number, number],
    up: decodeNativeNumbers(c.up as Uint8Array, 3) as [number, number, number], projection: c.projection === 0 ? 'perspective' : 'parallel', fov: finite(c.fov), scale: finite(c.scale) };
  if (Object.hasOwn(c, 'shift')) { const bytes = c.shift as Uint8Array; value.shift = bytes.length ? decodeNativeNumbers(bytes, 2) as [number, number] : undefined; }
  return value;
}
function sourceFields(s: LayoutViewportSource): Record<string, NativeScalar> {
  if ('referenceId' in s) {
    if ('archiveId' in s || 'modelReferenceId' in s || !Number.isInteger(s.referenceId) || s.referenceId < 1 || s.referenceId > 0xffffffff) return fail();
    return { kind: 1, referenceId: s.referenceId };
  }
  return { kind: 0, archiveId: s.archiveId, modelReferenceId: s.modelReferenceId };
}
export function encodeNativeLayoutViewportSource(value: LayoutViewportSource, extensions: Map<string, Uint8Array[]> = new Map(), path = ''): Uint8Array {
  return source.encode({ fields: sourceFields(value), unknownFields: value.nativeUnknownFields ?? extensions.get(path) ?? [] });
}
export function decodeNativeLayoutViewportSource(bytes: Uint8Array, extensions: Map<string, Uint8Array[]> = new Map(), path = ''): LayoutViewportSource {
  const s = read(source, bytes, path, { records: extensions, shadows: new Map() });
  if (s.kind === 0 && typeof s.archiveId === 'string' && typeof s.modelReferenceId === 'string' && !Object.hasOwn(s, 'referenceId')) return { archiveId: s.archiveId, modelReferenceId: s.modelReferenceId };
  if (s.kind === 1 && typeof s.referenceId === 'number' && s.referenceId > 0 && !Object.hasOwn(s, 'archiveId') && !Object.hasOwn(s, 'modelReferenceId')) return { referenceId: s.referenceId };
  return fail();
}
export function encodeNativeLayoutViewport(value: LayoutViewport, ext: LayoutViewportExtensions = { records: value.nativeUnknownFields ?? new Map(), shadows: new Map() }): Uint8Array {
  if (value.cache?.nativeUnknownFields || value.display?.nativeUnknownFields || value.display?.shadows?.nativeUnknownFields) {
    ext = { records: new Map(ext.records), shadows: value.display?.shadows?.nativeUnknownFields ?? ext.shadows };
    for (const [key, fields] of value.cache?.nativeUnknownFields ?? []) ext.records.set(key ? `cache.${key}` : 'cache', fields);
    for (const [key, fields] of value.display?.nativeUnknownFields ?? []) ext.records.set(key ? `display.${key}` : 'display.value', fields);
  }
  const fields: Record<string, NativeScalar> = { source: encodeNativeLayoutViewportSource(value.source, ext.records, 'source'), camera: writeCamera(value.camera, 'camera', ext) };
  for (const key of ['templateId', 'originalId', 'scene', 'background'] as const) if (value[key] !== null) fields[key] = value[key];
  if (Object.hasOwn(value, 'preserveScaleOnResize')) {
    if (value.preserveScaleOnResize !== undefined && typeof value.preserveScaleOnResize !== 'boolean') return fail();
    fields.preserveScaleOnResize = value.preserveScaleOnResize === undefined ? 0 : value.preserveScaleOnResize ? 2 : 1;
  }
  if (value.cache !== null) {
    const c = value.cache, cf: Record<string, NativeScalar> = { camera: writeCamera(c.camera, 'cache.camera', ext), widthMm: finite(c.widthMm), heightMm: finite(c.heightMm) };
    if (Object.hasOwn(c, 'sha256')) cf.sha256 = wrap(optionalString, c.sha256, 'cache.sha256', ext);
    fields.cache = write(cache, cf, 'cache', ext);
  }
  if (Object.hasOwn(value, 'display')) {
    let bytes: Uint8Array | undefined;
    if (value.display !== undefined) {
      const d = value.display, faceStyle = styles.indexOf(d.faceStyle); if (faceStyle < 0) return fail();
      const df: Record<string, NativeScalar> = { faceStyle, edges: d.edges, profiles: d.profiles, backEdges: d.backEdges, xray: d.xray, hiddenGeometry: d.hiddenGeometry };
      if (Object.hasOwn(d, 'shadows')) df.shadows = wrap(optional, d.shadows === undefined ? undefined : writeShadows(d.shadows, ext.shadows), 'display.shadows', ext);
      bytes = write(display, df, 'display.value', ext);
    }
    fields.display = wrap(optional, bytes, 'display', ext);
  }
  return write(viewport, fields, '', ext);
}
export function decodeNativeLayoutViewport(bytes: Uint8Array): { value: LayoutViewport; extensions: LayoutViewportExtensions } {
  const ext: LayoutViewportExtensions = { records: new Map(), shadows: new Map() }, v = read(viewport, bytes, '', ext);
  const target = decodeNativeLayoutViewportSource(v.source as Uint8Array, ext.records, 'source');
  const value: LayoutViewport = { source: target, templateId: v.templateId as string | undefined ?? null, originalId: v.originalId as string | undefined ?? null,
    scene: v.scene as string | undefined ?? null, background: v.background as string | undefined ?? null, camera: readCamera(v.camera as Uint8Array, 'camera', ext), cache: null };
  if (Object.hasOwn(v, 'preserveScaleOnResize')) {
    if (v.preserveScaleOnResize === 0) present(value, 'preserveScaleOnResize', undefined);
    else if (v.preserveScaleOnResize === 1 || v.preserveScaleOnResize === 2) value.preserveScaleOnResize = v.preserveScaleOnResize === 2; else return fail();
  }
  if (Object.hasOwn(v, 'cache')) {
    const c = read(cache, v.cache as Uint8Array, 'cache', ext);
    value.cache = { camera: readCamera(c.camera as Uint8Array, 'cache.camera', ext), widthMm: finite(c.widthMm), heightMm: finite(c.heightMm) };
    if (Object.hasOwn(c, 'sha256')) value.cache.sha256 = unwrap(optionalString, c.sha256 as Uint8Array, 'cache.sha256', ext) as string | undefined;
  }
  if (Object.hasOwn(v, 'display')) {
    const bytes = unwrap(optional, v.display as Uint8Array, 'display', ext);
    if (bytes === undefined) present(value, 'display', undefined);
    else {
      const d = read(display, bytes as Uint8Array, 'display.value', ext), faceStyle = styles[d.faceStyle as number]; if (!faceStyle) return fail();
      value.display = { faceStyle, edges: d.edges as boolean, profiles: d.profiles as boolean, backEdges: d.backEdges as boolean, xray: d.xray as boolean, hiddenGeometry: d.hiddenGeometry as boolean };
      if (Object.hasOwn(d, 'shadows')) {
        const bytes = unwrap(optional, d.shadows as Uint8Array, 'display.shadows', ext);
        if (bytes === undefined) present(value.display, 'shadows', undefined);
        else { const decoded = decodeNativeShadows(bytes as Uint8Array); value.display.shadows = decoded.value; ext.shadows = decoded.extensions; }
      }
    }
  }
  return { value, extensions: ext };
}
/** Resolve references against staged document catalogs, without loading models or fetching cloud data. */
export function validateNativeLayoutViewportReferences(value: LayoutViewport, references: ReadonlyMap<number, ModelReference>, archives: ReadonlyMap<string, LayoutModelArchive>): void {
  const s = value.source;
  if ('referenceId' in s) {
    if (references.get(s.referenceId)?.target.kind !== 'cloud' || value.templateId !== null || value.originalId !== null) fail();
  } else if (value.templateId === null || !archives.get(s.archiveId)?.models.has(s.modelReferenceId)) fail();
}
