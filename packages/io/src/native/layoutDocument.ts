// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState, LayoutPageNumbering } from '@pushform/layout';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { streamNativeNumbers } from './numericStream';
import { encodeNativeLayoutMetadata, decodeNativeLayoutMetadata } from './layoutMetadata';
import type { NativeLayoutMetadata, LayoutMetadataExtensions } from './layoutMetadata';
export interface NativeLayoutOrder { count: number; chunks: number[] }
const orderNames = ['pageOrder', 'layerOrder', 'sharedEntityOrder'] as const;
export interface NativeLayoutDocumentHeader {
  metadata: NativeLayoutMetadata;
  orders: Record<typeof orderNames[number], NativeLayoutOrder>;
  archivesState: 0 | 1 | 2; numberingState: 0 | 1 | 2;
  referenceCount: number; archiveCount: number; customFieldCount: number; numberingCount: number; assetCount: number;
}
export interface LayoutDocumentExtensions { records: Map<string, Uint8Array[]>; metadata: LayoutMetadataExtensions }
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const header = new NativeRecordCodec({ metadata: f(1, 'bytes'), pageOrder: f(2, 'bytes'), layerOrder: f(3, 'bytes'), sharedEntityOrder: f(4, 'bytes'), archivesState: f(5, 'uint32'), numberingState: f(6, 'uint32'),
  referenceCount: f(7, 'uint32'), archiveCount: f(8, 'uint32'), customFieldCount: f(9, 'uint32'), numberingCount: f(10, 'uint32'), assetCount: f(11, 'uint32') });
const order = new NativeRecordCodec({ count: f(1, 'uint32'), chunks: f(2, 'bytes', false) });
const custom = new NativeRecordCodec({ name: f(1, 'string'), value: f(2, 'string') });
const numbering = new NativeRecordCodec({ name: f(1, 'string'), startPageId: f(2, 'double', false), startNumber: f(3, 'double'), style: f(4, 'uint32') } satisfies Record<keyof LayoutPageNumbering | 'name', NativeField>);
const styles = ['arabic', 'two-digit', 'upper-letter', 'lower-letter', 'upper-roman', 'lower-roman'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout document header'); };
function validate(r: NativeLayoutDocumentHeader): void {
  const seen = new Set<number>(); let bytes = 0;
  for (const key of orderNames) {
    const o = r.orders[key]; if (!Number.isInteger(o.count) || o.count < 0 || !!o.count !== !!o.chunks.length || o.chunks.length > NATIVE_MAX_CHUNKS) fail(); bytes += o.count * 4;
    for (const id of o.chunks) { if (!Number.isInteger(id) || id < 1 || id >= 0xffffffff || seen.has(id)) fail(); seen.add(id); }
  }
  if (bytes > NATIVE_MAX_DECODED_BYTES || ![0, 1, 2].includes(r.archivesState) || ![0, 1, 2].includes(r.numberingState) ||
    r.archivesState !== 2 && r.archiveCount !== 0 || r.numberingState !== 2 && r.numberingCount !== 0) fail();
  for (const key of ['referenceCount', 'archiveCount', 'customFieldCount', 'numberingCount', 'assetCount'] as const) if (!Number.isInteger(r[key]) || r[key] < 0 || r[key] > 0xffffffff) fail();
}
export function encodeNativeLayoutDocumentHeader(value: NativeLayoutDocumentHeader, ext: LayoutDocumentExtensions = { records: new Map(), metadata: { records: new Map(), settings: new Map(), style: new Map() } }): Uint8Array {
  validate(value); const fields: Record<string, NativeScalar> = { metadata: encodeNativeLayoutMetadata(value.metadata, ext.metadata), archivesState: value.archivesState, numberingState: value.numberingState,
    referenceCount: value.referenceCount, archiveCount: value.archiveCount, customFieldCount: value.customFieldCount, numberingCount: value.numberingCount, assetCount: value.assetCount };
  for (const key of orderNames) { const o = value.orders[key]; fields[key] = order.encode({ fields: { count: o.count, ...(o.chunks.length ? { chunks: encodeNativeIds(o.chunks) } : {}) }, unknownFields: ext.records.get(key) ?? [] }); }
  return header.encode({ fields, unknownFields: ext.records.get('') ?? [] });
}
export function decodeNativeLayoutDocumentHeader(bytes: Uint8Array): { value: NativeLayoutDocumentHeader; extensions: LayoutDocumentExtensions } {
  const r = header.decode(bytes), metadata = decodeNativeLayoutMetadata(r.fields.metadata as Uint8Array), records = new Map<string, Uint8Array[]>();
  if (r.unknownFields.length) records.set('', r.unknownFields);
  const orders = {} as NativeLayoutDocumentHeader['orders'];
  for (const key of orderNames) { const o = order.decode(r.fields[key] as Uint8Array); orders[key] = { count: o.fields.count as number, chunks: decodeNativeIds(o.fields.chunks as Uint8Array | undefined) }; if (o.unknownFields.length) records.set(key, o.unknownFields); }
  const value: NativeLayoutDocumentHeader = { metadata: metadata.value, orders, archivesState: r.fields.archivesState as 0 | 1 | 2, numberingState: r.fields.numberingState as 0 | 1 | 2,
    referenceCount: r.fields.referenceCount as number, archiveCount: r.fields.archiveCount as number, customFieldCount: r.fields.customFieldCount as number, numberingCount: r.fields.numberingCount as number, assetCount: r.fields.assetCount as number };
  validate(value); return { value, extensions: { records, metadata: metadata.extensions } };
}
export async function* streamNativeLayoutDocumentHeader(state: LayoutDocumentState, assetCount: number, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutDocumentHeader> {
  const orders = {} as NativeLayoutDocumentHeader['orders'];
  for (const key of orderNames) orders[key] = { count: state[key].length, chunks: yield* streamNativeNumbers(state[key], 'uint32', state[key].length, nextId, options) };
  const value: NativeLayoutDocumentHeader = { metadata: { meta: state.meta, settings: state.settings, defaultStyle: state.defaultStyle, activeLayerId: state.activeLayerId }, orders,
    archivesState: !Object.hasOwn(state, 'modelArchives') ? 0 : state.modelArchives === undefined ? 1 : 2,
    numberingState: !Object.hasOwn(state, 'pageNumberFields') ? 0 : state.pageNumberFields === undefined ? 1 : 2,
    referenceCount: state.references.size, archiveCount: state.modelArchives?.size ?? 0, customFieldCount: state.customFields.size, numberingCount: state.pageNumberFields?.size ?? 0, assetCount };
  validate(value); return value;
}
/** Complete order membership is checked after the corresponding catalogs have been staged. */
export async function readNativeLayoutDocumentOrders(value: NativeLayoutDocumentHeader, columns: NativeColumnReader,
  catalogs: { pages: ReadonlyMap<number, unknown>; layers: ReadonlyMap<number, unknown>; sharedEntities: ReadonlyMap<number, unknown> }, signal?: AbortSignal) {
  validate(value); const result = {} as Record<typeof orderNames[number], Uint32Array>;
  const tables = { pageOrder: catalogs.pages, layerOrder: catalogs.layers, sharedEntityOrder: catalogs.sharedEntities };
  for (const key of orderNames) {
    const ref = value.orders[key]; if (ref.count !== tables[key].size) return fail();
    const ids = await columns.read('uint32', ref.count, ref.chunks, signal); columns.validateUniqueIds(ids, signal);
    for (const id of ids) if (!id || !tables[key].has(id)) return fail(); result[key] = ids;
  }
  return result;
}
export function encodeNativeLayoutCustomField(name: string, value: string, unknownFields: Uint8Array[] = []): Uint8Array { return custom.encode({ fields: { name, value }, unknownFields }); }
export function decodeNativeLayoutCustomField(bytes: Uint8Array) { const r = custom.decode(bytes); return { name: r.fields.name as string, value: r.fields.value as string, unknownFields: r.unknownFields }; }
function validateNumbering(name: string, value: LayoutPageNumbering): void {
  if (!name || !Number.isSafeInteger(value.startNumber) || value.startPageId !== null && !Number.isSafeInteger(value.startPageId) || !styles.includes(value.style)) fail();
}
export function encodeNativeLayoutPageNumberField(name: string, value: LayoutPageNumbering, unknownFields: Uint8Array[] = []): Uint8Array {
  validateNumbering(name, value); return numbering.encode({ fields: { name, startNumber: value.startNumber, style: styles.indexOf(value.style), ...(value.startPageId === null ? {} : { startPageId: value.startPageId }) }, unknownFields });
}
export function decodeNativeLayoutPageNumberField(bytes: Uint8Array) {
  const r = numbering.decode(bytes), style = styles[r.fields.style as number]; if (!style) return fail();
  const name = r.fields.name as string, value = { startPageId: r.fields.startPageId as number | undefined ?? null, startNumber: r.fields.startNumber as number, style }; validateNumbering(name, value);
  return { name, value, unknownFields: r.unknownFields };
}
