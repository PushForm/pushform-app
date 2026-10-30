// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LAYOUT_OBJECT_NAME_MAX } from '@pushform/layout';
import type { LayoutEntity } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { encodeNativeLayoutStyle, decodeNativeLayoutStyle } from './layoutStyle';
import type { LayoutStyleExtensions } from './layoutStyle';
export type NativeLayoutEntityMetadata = Pick<LayoutEntity, 'id' | 'kind' | 'layerId' | 'name' | 'locked' | 'hidden' | 'groupId' | 'nestedGroupIds' | 'style'>;
export interface LayoutEntityMetadataExtensions { records: Map<string, Uint8Array[]>; style: LayoutStyleExtensions }
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const record = new NativeRecordCodec({ id: f(1, 'uint32'), kind: f(2, 'uint32'), layerId: f(3, 'uint32'), name: f(4, 'bytes', false), locked: f(5, 'uint32', false),
  hidden: f(6, 'uint32', false), groupId: f(7, 'uint32', false), nestedGroupIds: f(8, 'bytes', false), style: f(9, 'bytes', false) } satisfies Record<keyof NativeLayoutEntityMetadata, NativeField>);
const optionalString = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'string', false) });
const optionalBytes = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'bytes', false) });
const style = new NativeRecordCodec({ base: f(1, 'bytes'), strokeDashMm: f(2, 'bytes', false) });
const kinds = ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'table'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout entity metadata'); };
function id(n: number): void { if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) fail(); }
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, ext: LayoutEntityMetadataExtensions) { return codec.encode({ fields, unknownFields: ext.records.get(path) ?? [] }); }
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: LayoutEntityMetadataExtensions) { const r = codec.decode(bytes); if (r.unknownFields.length) ext.records.set(path, r.unknownFields); return r.fields; }
function wrap(codec: NativeRecordCodec, value: NativeScalar | undefined, path: string, ext: LayoutEntityMetadataExtensions) { return write(codec, value === undefined ? { state: 0 } : { state: 1, value }, path, ext); }
function unwrap(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: LayoutEntityMetadataExtensions): NativeScalar | undefined {
  const r = read(codec, bytes, path, ext), has = Object.hasOwn(r, 'value'); if (r.state === 0 && !has) return undefined; if (r.state === 1 && has) return r.value; return fail();
}
function validate(value: NativeLayoutEntityMetadata): void {
  id(value.id); id(value.layerId); if (!kinds.includes(value.kind)) fail();
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > LAYOUT_OBJECT_NAME_MAX)) fail();
  if (value.groupId !== undefined) id(value.groupId);
  if (value.nestedGroupIds !== undefined) {
    const ids = value.nestedGroupIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 65536 || value.groupId === undefined || new Set(ids).size !== ids.length) fail();
    for (const n of ids) { id(n); if (n === value.groupId) fail(); }
  }
  const dash = value.style?.strokeDashMm;
  if (dash !== undefined) {
    if (!Array.isArray(dash) || dash.length % 2 || dash.length > 131070) fail();
    for (const n of dash) if (!Number.isFinite(n) || n <= 0) fail();
  }
}
export function encodeNativeLayoutEntityMetadata(value: NativeLayoutEntityMetadata, ext: LayoutEntityMetadataExtensions = { records: new Map(), style: new Map() }): Uint8Array {
  if (value.style?.nativeUnknownFields) ext = { records: new Map([...ext.records, ...value.style.nativeUnknownFields.records]), style: value.style.nativeUnknownFields.style };
  validate(value); const fields: Record<string, NativeScalar> = { id: value.id, kind: kinds.indexOf(value.kind), layerId: value.layerId };
  if (Object.hasOwn(value, 'name')) fields.name = wrap(optionalString, value.name, 'name', ext);
  for (const key of ['hidden', 'locked'] as const) if (Object.hasOwn(value, key)) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return fail(); fields[key] = value[key] === undefined ? 0 : value[key] ? 2 : 1;
  }
  if (Object.hasOwn(value, 'groupId')) fields.groupId = value.groupId ?? 0;
  if (Object.hasOwn(value, 'nestedGroupIds')) fields.nestedGroupIds = wrap(optionalBytes, value.nestedGroupIds === undefined ? undefined : encodeNativeIds(value.nestedGroupIds), 'nestedGroupIds', ext);
  if (Object.hasOwn(value, 'style')) {
    let bytes: Uint8Array | undefined;
    if (value.style !== undefined) {
      const s = value.style, fields: Record<string, NativeScalar> = { base: encodeNativeLayoutStyle(s, ext.style) };
      if (Object.hasOwn(s, 'strokeDashMm')) {
        let bytes: Uint8Array | undefined;
        if (s.strokeDashMm !== undefined) { bytes = new Uint8Array(s.strokeDashMm.length * 8); const view = new DataView(bytes.buffer); for (let i = 0; i < s.strokeDashMm.length; i++) view.setFloat64(i * 8, s.strokeDashMm[i]!, true); }
        fields.strokeDashMm = wrap(optionalBytes, bytes, 'style/dash', ext);
      }
      bytes = write(style, fields, 'style/value', ext);
    }
    fields.style = wrap(optionalBytes, bytes, 'style', ext);
  }
  return write(record, fields, '', ext);
}
export function decodeNativeLayoutEntityMetadata(bytes: Uint8Array): { value: NativeLayoutEntityMetadata; extensions: LayoutEntityMetadataExtensions } {
  const ext: LayoutEntityMetadataExtensions = { records: new Map(), style: new Map() }, r = read(record, bytes, '', ext), kind = kinds[r.kind as number]; if (!kind) return fail();
  const value: NativeLayoutEntityMetadata = { id: r.id as number, kind, layerId: r.layerId as number };
  if (Object.hasOwn(r, 'name')) present(value, 'name', unwrap(optionalString, r.name as Uint8Array, 'name', ext));
  for (const key of ['hidden', 'locked'] as const) if (Object.hasOwn(r, key)) {
    if (r[key] !== 0 && r[key] !== 1 && r[key] !== 2) return fail(); present(value, key, r[key] === 0 ? undefined : r[key] === 2);
  }
  if (Object.hasOwn(r, 'groupId')) present(value, 'groupId', r.groupId === 0 ? undefined : r.groupId);
  if (Object.hasOwn(r, 'nestedGroupIds')) { const bytes = unwrap(optionalBytes, r.nestedGroupIds as Uint8Array, 'nestedGroupIds', ext); present(value, 'nestedGroupIds', bytes === undefined ? undefined : decodeNativeIds(bytes as Uint8Array)); }
  if (Object.hasOwn(r, 'style')) {
    const bytes = unwrap(optionalBytes, r.style as Uint8Array, 'style', ext);
    if (bytes === undefined) present(value, 'style', undefined);
    else {
      const s = read(style, bytes as Uint8Array, 'style/value', ext), base = decodeNativeLayoutStyle(s.base as Uint8Array); value.style = base.value; ext.style = base.extensions;
      if (Object.hasOwn(s, 'strokeDashMm')) {
        const bytes = unwrap(optionalBytes, s.strokeDashMm as Uint8Array, 'style/dash', ext);
        if (bytes === undefined) present(value.style, 'strokeDashMm', undefined);
        else {
          const b = bytes as Uint8Array; if (b.length % 16) return fail(); const view = new DataView(b.buffer, b.byteOffset, b.byteLength), dash = [];
          for (let at = 0; at < b.length; at += 8) dash.push(view.getFloat64(at, true)); value.style.strokeDashMm = dash;
        }
      }
    }
  }
  validate(value); return { value, extensions: ext };
}
