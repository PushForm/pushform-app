// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPage } from '@pushform/layout';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { streamNativeNumbers } from './numericStream';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { encodeNativeIds, decodeNativeIds } from './idList';

export type NativeLayoutPageMetadata = Omit<LayoutPage, 'entities' | 'entityOrder' | 'nativeUnknownFields'>;
export interface NativeLayoutPageRecord { metadata: NativeLayoutPageMetadata; entityOrder: { count: number; chunks: number[] } }
export type LayoutPageExtensions = Map<string, Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const page = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), size: f(3, 'bytes'), margin: f(4, 'bytes'), background: f(5, 'string'),
  entityOrder: f(6, 'bytes'), layerVisibility: f(7, 'bytes', false) } satisfies Record<Exclude<keyof LayoutPage, 'entities' | 'nativeUnknownFields'>, NativeField>);
const margin = new NativeRecordCodec({ top: f(1, 'double'), right: f(2, 'double'), bottom: f(3, 'double'), left: f(4, 'double') } satisfies Record<keyof LayoutPage['margin'], NativeField>);
const order = new NativeRecordCodec({ count: f(1, 'uint32'), chunks: f(2, 'bytes', false) });
const visibility = new NativeRecordCodec({ state: f(1, 'uint32'), entries: { ...f(2, 'bytes', false), repeated: true } });
const entry = new NativeRecordCodec({ id: f(1, 'uint32'), visible: f(2, 'bool') });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout page'); };
function id(n: number): void { if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) fail(); }
function validate(value: NativeLayoutPageRecord): void {
  id(value.metadata.id);
  for (const n of [...value.metadata.size, ...Object.values(value.metadata.margin)]) if (!Number.isFinite(n)) fail();
  const r = value.entityOrder;
  if (!Number.isInteger(r.count) || r.count < 0 || r.count * 4 > NATIVE_MAX_DECODED_BYTES || !!r.count !== !!r.chunks.length ||
    r.chunks.length > NATIVE_MAX_CHUNKS || new Set(r.chunks).size !== r.chunks.length) fail();
  for (const chunk of r.chunks) { id(chunk); if (chunk === 0xffffffff) fail(); }
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, key: string, extensions: LayoutPageExtensions) {
  const record = codec.decode(bytes); if (record.unknownFields.length) extensions.set(key, record.unknownFields); return record.fields;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, key: string, extensions: LayoutPageExtensions): Uint8Array {
  return codec.encode({ fields, unknownFields: extensions.get(key) ?? [] });
}
export function encodeNativeLayoutPage(value: NativeLayoutPageRecord, extensions: LayoutPageExtensions = new Map()): Uint8Array {
  validate(value); const m = value.metadata, o = value.entityOrder;
  const fields: Record<string, NativeScalar> = { id: m.id, name: m.name, size: encodeNativeNumbers(m.size, 2), background: m.background,
    margin: write(margin, { ...m.margin }, 'margin', extensions),
    entityOrder: write(order, { count: o.count, ...(o.chunks.length ? { chunks: encodeNativeIds(o.chunks) } : {}) }, 'entityOrder', extensions) };
  if (Object.hasOwn(m, 'layerVisibility')) {
    const map = m.layerVisibility, entries: Uint8Array[] = []; let bytes = 0;
    if (map !== undefined && !(map instanceof Map)) return fail();
    if (map && map.size > 65536) return fail();
    for (const [key, visible] of map ?? []) {
      id(key); const encoded = write(entry, { id: key, visible }, `visibility/${key}`, extensions);
      bytes += encoded.length; if (bytes > 1024 * 1024) return fail(); entries.push(encoded);
    }
    fields.layerVisibility = write(visibility, { state: map === undefined ? 0 : 1, entries }, 'layerVisibility', extensions);
  }
  return write(page, fields, '', extensions);
}
export function decodeNativeLayoutPage(bytes: Uint8Array): { value: NativeLayoutPageRecord; extensions: LayoutPageExtensions } {
  const extensions: LayoutPageExtensions = new Map(), p = read(page, bytes, '', extensions), m = read(margin, p.margin as Uint8Array, 'margin', extensions),
    o = read(order, p.entityOrder as Uint8Array, 'entityOrder', extensions);
  const metadata: NativeLayoutPageMetadata = { id: p.id as number, name: p.name as string, size: decodeNativeNumbers(p.size as Uint8Array, 2) as [number, number],
    background: p.background as string, margin: { top: m.top as number, right: m.right as number, bottom: m.bottom as number, left: m.left as number } };
  if (Object.hasOwn(p, 'layerVisibility')) {
    const v = read(visibility, p.layerVisibility as Uint8Array, 'layerVisibility', extensions), entries = v.entries as Uint8Array[] | undefined;
    if (v.state === 0) {
      if (entries?.length) return fail();
      Object.defineProperty(metadata, 'layerVisibility', { value: undefined, enumerable: true, writable: true, configurable: true });
    } else if (v.state === 1) {
      const map = new Map<number, boolean>();
      for (const bytes of entries ?? []) {
        const e = entry.decode(bytes), key = e.fields.id as number; id(key); if (map.has(key)) return fail();
        map.set(key, e.fields.visible as boolean); if (e.unknownFields.length) extensions.set(`visibility/${key}`, e.unknownFields);
      }
      metadata.layerVisibility = map;
    } else return fail();
  }
  const value = { metadata, entityOrder: { count: o.count as number, chunks: decodeNativeIds(o.chunks as Uint8Array | undefined) } }; validate(value);
  return { value, extensions };
}
/** Entity order is a streamed numeric column, never a whole-page JSON list. */
export async function* streamNativeLayoutPage(value: LayoutPage, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutPageRecord> {
  const { entities: _entities, entityOrder, nativeUnknownFields: _extra, ...metadata } = value;
  const chunks = yield* streamNativeNumbers(entityOrder, 'uint32', entityOrder.length, nextId, options);
  const record = { metadata, entityOrder: { count: entityOrder.length, chunks } }; validate(record); return record;
}
/** Validate against fully staged page entities and document layers before installation. */
export async function readNativeLayoutPage(value: NativeLayoutPageRecord, columns: NativeColumnReader, layers: ReadonlyMap<number, unknown>, entities: ReadonlyMap<number, unknown>, signal?: AbortSignal) {
  validate(value);
  const order = await columns.read('uint32', value.entityOrder.count, value.entityOrder.chunks, signal); columns.validateUniqueIds(order, signal);
  if (order.length !== entities.size) return fail();
  for (const key of order) if (!entities.has(key)) return fail();
  for (const key of value.metadata.layerVisibility?.keys() ?? []) if (!layers.has(key)) return fail();
  return { metadata: value.metadata, order };
}
