// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { validLayoutModelAttachment } from '@pushform/layout';
import type { LayoutEntity, LayoutModelAttachment } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeModelAnchor, decodeNativeModelAnchor } from './dimension';
import { encodeNativeLayoutViewportSource, decodeNativeLayoutViewportSource } from './layoutViewport';
type Annotation = NonNullable<LayoutEntity['modelAnnotation']>;
export type LayoutModelAnnotationExtensions = Map<string, Uint8Array[]>;
/** Attachment indices are wire locations, not editable ownership. */
export function attachNativeLayoutModelAnnotationFields(value: Annotation, extensions: LayoutModelAnnotationExtensions, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  const ext = new Map(extensions);
  for (const [i, attachment] of value.attachments.entries()) {
    const path = `attachments/${i}`;
    for (const [key, owner] of [[path, attachment], [`${path}/source`, attachment.source], [`${path}/anchor`, attachment.anchor]] as const) {
      const fields = ext.get(key);
      if (fields) { owner.nativeUnknownFields = fields; ext.delete(key); }
    }
  }
  if (ext.size || envelope.length || outer.length) value.nativeUnknownFields = {
    ...(ext.size ? { extensions: ext } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const attachment = new NativeRecordCodec({ viewportId: f(1, 'uint32'), source: f(2, 'bytes'), modelGuid: f(3, 'string'), anchor: f(4, 'bytes') } satisfies Record<Exclude<keyof LayoutModelAttachment, 'nativeUnknownFields'>, NativeField>);
const annotation = new NativeRecordCodec({ attachments: { ...f(1, 'bytes', false), repeated: true }, status: f(2, 'uint32'), fields: f(3, 'bytes', false) } satisfies Record<Exclude<keyof Annotation, 'nativeUnknownFields'>, NativeField>);
const fields = new NativeRecordCodec({ state: f(1, 'uint32'), entries: { ...f(2, 'bytes', false), repeated: true } });
const field = new NativeRecordCodec({ key: f(1, 'string'), value: f(2, 'string') });
const statuses = ['resolved', 'unavailable', 'detached'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout model annotation'); };
function write(codec: NativeRecordCodec, values: Record<string, NativeScalar>, path: string, ext: LayoutModelAnnotationExtensions) { return codec.encode({ fields: values, unknownFields: ext.get(path) ?? [] }); }
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: LayoutModelAnnotationExtensions) { const r = codec.decode(bytes); if (r.unknownFields.length) ext.set(path, r.unknownFields); return r.fields; }
/** Shared Auto-Text field dictionary, including explicit undefined and prototype-like authored keys. */
export function encodeNativeLayoutAnnotationFields(value: Record<string, string> | undefined, ext: LayoutModelAnnotationExtensions = new Map(), path = 'fields'): Uint8Array {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return fail();
  const entries: Uint8Array[] = []; let total = 0;
  for (const key of Object.keys(value ?? {})) {
    if (entries.length >= 65536) return fail();
    const bytes = write(field, { key, value: value![key]! }, `${path}/${key}`, ext); total += bytes.length; if (total > 1024 * 1024) return fail(); entries.push(bytes);
  }
  return write(fields, { state: value === undefined ? 0 : 1, entries }, path, ext);
}
export function decodeNativeLayoutAnnotationFields(bytes: Uint8Array, ext: LayoutModelAnnotationExtensions = new Map(), path = 'fields'): Record<string, string> | undefined {
  const f = read(fields, bytes, path, ext), entries = (f.entries ?? []) as Uint8Array[];
  if (f.state === 0 && !entries.length) return undefined; if (f.state !== 1) return fail();
  const value: Record<string, string> = {};
  for (const bytes of entries) {
    const r = field.decode(bytes), key = r.fields.key as string; if (Object.hasOwn(value, key)) return fail();
    Object.defineProperty(value, key, { value: r.fields.value as string, enumerable: true, writable: true, configurable: true });
    if (r.unknownFields.length) ext.set(`${path}/${key}`, r.unknownFields);
  }
  return value;
}
export function encodeNativeLayoutModelAttachment(value: LayoutModelAttachment, ext: LayoutModelAnnotationExtensions = new Map(), path = ''): Uint8Array {
  if (!validLayoutModelAttachment(value)) return fail();
  return attachment.encode({ fields: { viewportId: value.viewportId, source: encodeNativeLayoutViewportSource(value.source, ext, `${path}/source`), modelGuid: value.modelGuid,
    anchor: encodeNativeModelAnchor(value.anchor, ext, `${path}/anchor`) }, unknownFields: value.nativeUnknownFields ?? ext.get(path) ?? [] });
}
export function decodeNativeLayoutModelAttachment(bytes: Uint8Array, ext: LayoutModelAnnotationExtensions = new Map(), path = ''): LayoutModelAttachment {
  const a = read(attachment, bytes, path, ext), anchor = decodeNativeModelAnchor(a.anchor as Uint8Array, ext, `${path}/anchor`); if (anchor === null) return fail();
  const value = { viewportId: a.viewportId as number, source: decodeNativeLayoutViewportSource(a.source as Uint8Array, ext, `${path}/source`), modelGuid: a.modelGuid as string, anchor };
  if (!validLayoutModelAttachment(value)) return fail(); return value;
}
/** Preserve identity when the source is unavailable or deleted; resolution belongs to the loaded editor. */
export function encodeNativeLayoutModelAnnotation(value: Annotation, ext: LayoutModelAnnotationExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  const status = statuses.indexOf(value.status); if (status < 0 || !Array.isArray(value.attachments) || value.attachments.length < 1 || value.attachments.length > 2) return fail();
  const fields: Record<string, NativeScalar> = { status, attachments: value.attachments.map((a, i) => encodeNativeLayoutModelAttachment(a, ext, `attachments/${i}`)) };
  if (Object.hasOwn(value, 'fields')) fields.fields = encodeNativeLayoutAnnotationFields(value.fields, ext);
  return write(annotation, fields, '', ext);
}
export function decodeNativeLayoutModelAnnotation(bytes: Uint8Array): { value: Annotation; extensions: LayoutModelAnnotationExtensions } {
  const ext: LayoutModelAnnotationExtensions = new Map(), r = read(annotation, bytes, '', ext), status = statuses[r.status as number], entries = (r.attachments ?? []) as Uint8Array[];
  if (!status || entries.length < 1 || entries.length > 2) return fail();
  const value: Annotation = { status, attachments: entries.map((bytes, i) => decodeNativeLayoutModelAttachment(bytes, ext, `attachments/${i}`)) };
  if (Object.hasOwn(r, 'fields')) Object.defineProperty(value, 'fields', { value: decodeNativeLayoutAnnotationFields(r.fields as Uint8Array, ext), enumerable: true, writable: true, configurable: true });
  return { value, extensions: ext };
}
