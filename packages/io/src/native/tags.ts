// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TagId, TagFolderId } from '@pushform/core';
import type { Tag, TagFolder } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const tag = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), visible: f(3, 'bool'), color: f(4, 'bytes'), dashes: f(5, 'bytes'), folderId: f(6, 'bytes') } satisfies Record<keyof Tag, NativeField>);
const folder = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), visible: f(3, 'bool'), parentId: f(4, 'bytes') } satisfies Record<keyof TagFolder, NativeField>);
const rgb = new NativeRecordCodec({ red: f(1, 'double'), green: f(2, 'double'), blue: f(3, 'double') });
const nullableId = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'uint32', false) });
const nullableString = new NativeRecordCodec({ nullValue: f(2, 'bytes', false), value: f(3, 'string', false) });
const empty = new NativeRecordCodec({});
export type TagExtensions = Map<string, Uint8Array[]>;
const fail = (): never => { throw new NativeChunkError('Invalid native tag metadata'); };
function color(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fail(); return value; }
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: TagExtensions) {
  const record = codec.decode(bytes); if (record.unknownFields.length) extensions.set(path, record.unknownFields); return record.fields;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: TagExtensions) {
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
function encodeNullable(codec: NativeRecordCodec, value: string | number | null, path: string, extensions: TagExtensions): Uint8Array {
  return write(codec, value === null ? { nullValue: write(empty, {}, `${path}.null`, extensions) } : { value }, path, extensions);
}
function decodeNullable(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: TagExtensions): NativeScalar | null {
  const fields = read(codec, bytes, path, extensions), isNull = Object.hasOwn(fields, 'nullValue');
  if (isNull === Object.hasOwn(fields, 'value')) return fail();
  if (isNull) { read(empty, fields.nullValue as Uint8Array, `${path}.null`, extensions); return null; }
  return fields.value!;
}
export function encodeNativeTag(value: Tag, extensions: TagExtensions = new Map()): Uint8Array {
  return write(tag, { id: value.id, name: value.name, visible: value.visible,
    color: write(rgb, { red: color(value.color[0]), green: color(value.color[1]), blue: color(value.color[2]) }, 'color', extensions),
    dashes: encodeNullable(nullableString, value.dashes, 'dashes', extensions), folderId: encodeNullable(nullableId, value.folderId, 'folderId', extensions) }, '', extensions);
}
export function decodeNativeTag(bytes: Uint8Array): { value: Tag; extensions: TagExtensions } {
  const extensions: TagExtensions = new Map(), fields = read(tag, bytes, '', extensions), c = read(rgb, fields.color as Uint8Array, 'color', extensions);
  return { value: { id: fields.id as TagId, name: fields.name as string, visible: fields.visible as boolean,
    color: [color(c.red), color(c.green), color(c.blue)], dashes: decodeNullable(nullableString, fields.dashes as Uint8Array, 'dashes', extensions) as string | null,
    folderId: decodeNullable(nullableId, fields.folderId as Uint8Array, 'folderId', extensions) as TagFolderId | null }, extensions };
}
export function encodeNativeTagFolder(value: TagFolder, extensions: TagExtensions = new Map()): Uint8Array {
  return write(folder, { id: value.id, name: value.name, visible: value.visible, parentId: encodeNullable(nullableId, value.parentId, 'parentId', extensions) }, '', extensions);
}
export function decodeNativeTagFolder(bytes: Uint8Array): { value: TagFolder; extensions: TagExtensions } {
  const extensions: TagExtensions = new Map(), fields = read(folder, bytes, '', extensions);
  return { value: { id: fields.id as TagFolderId, name: fields.name as string, visible: fields.visible as boolean,
    parentId: decodeNullable(nullableId, fields.parentId as Uint8Array, 'parentId', extensions) as TagFolderId | null }, extensions };
}

/** Validate links before installing the completed catalogs; iterative for deep trees. */
export function validateNativeTagHierarchy(tags: ReadonlyMap<TagId, Tag>, folders: ReadonlyMap<TagFolderId, TagFolder>): void {
  for (const [id, tag] of tags) if (tag.id !== id || (tag.folderId !== null && !folders.has(tag.folderId))) fail();
  const done = new Set<TagFolderId>();
  for (const [id, folder] of folders) {
    if (folder.id !== id) fail();
    const visiting = new Set<TagFolderId>(); let current: TagFolderId | null = id;
    while (current !== null && !done.has(current)) {
      if (visiting.has(current)) fail(); visiting.add(current);
      const next = folders.get(current); if (!next) return fail(); current = next.parentId;
    }
    for (const item of visiting) done.add(item);
  }
}
