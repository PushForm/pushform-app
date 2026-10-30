// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutNativeRecordFields } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import { NativeRecordCodec } from './record';
import { encodeNativeLayoutEntityMetadata, decodeNativeLayoutEntityMetadata } from './layoutEntityMetadata';
import type { NativeLayoutEntityMetadata } from './layoutEntityMetadata';
import { streamNativeLayoutGeometry, encodeNativeLayoutGeometry, decodeNativeLayoutGeometry } from './layoutGeometry';
import { streamNativeLayoutImage, encodeNativeLayoutImage } from './layoutImage';
import { streamNativeLayoutTableRecords } from './layoutTable';
import { encodeNativeLayoutLinearDimension, encodeNativeLayoutAngularDimension, encodeNativeLayoutDimensionAnchor } from './layoutDimension';
import { encodeNativeLayoutText } from './layoutText';
import { encodeNativeLayoutModelAnnotation } from './layoutModelAnnotation';
import { referenceNativeLayoutConnections, encodeNativeLayoutConnections } from './layoutConnections';
const payloads = ['table', 'image', 'dimension', 'angularDimension', 'text', 'labelAnchor', 'modelAnnotation', 'preservedModelConnections'] as const;
export type NativeLayoutEntityPayload = typeof payloads[number];
export type NativeLayoutEntityRecordKind = 'header' | NativeLayoutEntityPayload | 'tableCell';
const kinds: readonly NativeLayoutEntityRecordKind[] = ['header', ...payloads, 'tableCell'];
const sections = { nativeUnknownFields: 'payload', id: 'metadata', kind: 'metadata', layerId: 'metadata', name: 'metadata', locked: 'metadata', hidden: 'metadata', groupId: 'metadata', nestedGroupIds: 'metadata', style: 'metadata',
  points: 'geometry', closed: 'geometry', handles: 'geometry', contourStarts: 'geometry', openContours: 'geometry',
  table: 'payload', image: 'payload', dimension: 'payload', angularDimension: 'payload', text: 'payload', labelAnchor: 'payload', modelAnnotation: 'payload', preservedModelConnections: 'payload' } as const satisfies Record<keyof LayoutEntity, 'metadata' | 'geometry' | 'payload'>;
const envelope = new NativeRecordCodec({ ownerId: { id: 1, kind: 'uint32', required: true }, kind: { id: 2, kind: 'uint32', required: true }, state: { id: 3, kind: 'uint32', required: true }, payload: { id: 4, kind: 'bytes', required: false } });
const header = new NativeRecordCodec({ metadata: { id: 1, kind: 'bytes', required: true }, geometry: { id: 2, kind: 'bytes', required: true }, payloadMask: { id: 3, kind: 'uint32', required: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout entity record'); };
export interface NativeLayoutEntityRecord { ownerId: number; kind: NativeLayoutEntityRecordKind; payload: Uint8Array | undefined; unknownFields: Uint8Array[]; outerUnknown?: Uint8Array[] }
export type NativeLayoutEntityOutput = { type: 'chunk'; chunk: NativeStoredChunk } | { type: 'record'; record: NativeLayoutEntityRecord };
export type NativeLayoutAssetKind = 'image' | 'archive' | 'text';
/** Keeps references to immutable source strings, not concatenated keys or additional encoded copies. */
export class NativeLayoutAssetCatalog {
  readonly #sources = { image: new Map<string, number>(), archive: new Map<string, number>(), text: new Map<string, number>() };
  readonly #entries: { id: number; kind: NativeLayoutAssetKind; source: string; fields?: LayoutNativeRecordFields; previous?: number }[] = [];
  register(source: string, kind: NativeLayoutAssetKind, fields?: LayoutNativeRecordFields): number {
    const found = this.#sources[kind].get(source);
    for (let candidate = found; candidate !== undefined;) {
      const entry = this.#entries[candidate - 1]!;
      if (entry.fields === fields) return candidate;
      const equal = (a: Uint8Array[] = [], b: Uint8Array[] = []) => a.length === b.length && a.every((bytes, i) => bytes.length === b[i]!.length && bytes.every((n, j) => n === b[i]![j]));
      if (equal(entry.fields?.unknownFields, fields?.unknownFields) && equal(entry.fields?.envelopeUnknown, fields?.envelopeUnknown)) return candidate;
      candidate = entry.previous;
    }
    const id = this.#entries.length + 1; if (id > 0xffffffff) return fail();
    this.#sources[kind].set(source, id); this.#entries.push({ id, kind, source, ...(fields ? { fields } : {}), ...(found !== undefined ? { previous: found } : {}) }); return id;
  }
  get size(): number { return this.#entries.length; }
  *entries(): IterableIterator<Readonly<{ id: number; kind: NativeLayoutAssetKind; source: string; fields?: LayoutNativeRecordFields }>> { yield* this.#entries; }
}
export function encodeNativeLayoutEntityRecord(value: NativeLayoutEntityRecord): Uint8Array {
  const kind = kinds.indexOf(value.kind);
  if (!Number.isInteger(value.ownerId) || value.ownerId < 1 || value.ownerId > 0xffffffff || kind < 0 || value.payload === undefined && (kind === 0 || kind === 9)) return fail();
  return envelope.encode({ fields: { ownerId: value.ownerId, kind, state: value.payload === undefined ? 0 : 1, ...(value.payload === undefined ? {} : { payload: value.payload }) }, unknownFields: value.unknownFields });
}
export function decodeNativeLayoutEntityRecord(bytes: Uint8Array): NativeLayoutEntityRecord {
  const r = envelope.decode(bytes), kind = kinds[r.fields.kind as number], has = Object.hasOwn(r.fields, 'payload');
  if (!kind || !(r.fields.ownerId as number) || !(r.fields.state === 0 && !has || r.fields.state === 1 && has) || r.fields.state === 0 && (kind === 'header' || kind === 'tableCell')) return fail();
  return { ownerId: r.fields.ownerId as number, kind, payload: r.fields.payload as Uint8Array | undefined, unknownFields: r.unknownFields };
}
export function decodeNativeLayoutEntityHeader(bytes: Uint8Array) {
  const r = header.decode(bytes), payloadMask = r.fields.payloadMask as number; if (payloadMask > 255) return fail();
  return { metadata: decodeNativeLayoutEntityMetadata(r.fields.metadata as Uint8Array), geometry: decodeNativeLayoutGeometry(r.fields.geometry as Uint8Array),
    payloads: payloads.filter((_, i) => payloadMask & 1 << i), unknownFields: r.unknownFields };
}
async function* chunks<T>(stream: AsyncGenerator<NativeStoredChunk, T>): AsyncGenerator<NativeLayoutEntityOutput, T> {
  let step = await stream.next(); while (!step.done) { yield { type: 'chunk', chunk: step.value }; step = await stream.next(); } return step.value;
}
/** One captured immutable entity; geometry is paged and table cells never accumulate into a whole-table encoding. */
export async function* streamNativeLayoutEntity(value: LayoutEntity, assets: NativeLayoutAssetCatalog, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeLayoutEntityOutput> {
  options.signal?.throwIfAborted();
  const metadata = Object.fromEntries((Object.keys(sections) as (keyof LayoutEntity)[]).filter(k => sections[k] === 'metadata' && Object.hasOwn(value, k)).map(k => [k, value[k]])) as NativeLayoutEntityMetadata;
  const metadataBytes = encodeNativeLayoutEntityMetadata(metadata, { records: value.nativeUnknownFields?.metadata ?? new Map(), style: new Map() }), geometry = yield* chunks(streamNativeLayoutGeometry(value, nextId, options));
  geometry.extensions = value.nativeUnknownFields?.geometry ?? new Map();
  const emit = (kind: NativeLayoutEntityRecordKind, payload: Uint8Array | undefined): NativeLayoutEntityOutput => ({ type: 'record', record: { ownerId: value.id, kind, payload, unknownFields: kind === 'header' ? value.nativeUnknownFields?.headerEnvelope ?? [] : kind === 'text' || kind === 'dimension' || kind === 'angularDimension' || kind === 'labelAnchor' || kind === 'modelAnnotation' || kind === 'preservedModelConnections' || kind === 'image' ? value[kind]?.nativeUnknownFields?.envelope ?? [] : [] } });
  let payloadMask = 0; for (const [i, key] of payloads.entries()) if (Object.hasOwn(value, key)) payloadMask |= 1 << i;
  yield emit('header', header.encode({ fields: { metadata: metadataBytes, geometry: encodeNativeLayoutGeometry(geometry), payloadMask }, unknownFields: value.nativeUnknownFields?.header ?? [] }));
  for (const key of payloads) if (Object.hasOwn(value, key)) {
    options.signal?.throwIfAborted(); if (value[key] === undefined) {
      const extra = value.nativeUnknownFields?.emptyPayloads?.get(key);
      yield { type: 'record', record: { ownerId: value.id, kind: key, payload: undefined, unknownFields: extra?.envelope ?? [], ...(extra?.outerEnvelope ? { outerUnknown: extra.outerEnvelope } : {}) } }; continue;
    }
    switch (key) {
      case 'table': for (const part of streamNativeLayoutTableRecords(value.table!, undefined, options.signal)) yield { type: 'record', record: { ownerId: value.id, kind: part.kind === 'header' ? 'table' : 'tableCell', payload: part.bytes, unknownFields: part.envelope ?? [], ...(part.outerEnvelope ? { outerUnknown: part.outerEnvelope } : {}) } }; break;
      case 'image': {
        const image = yield* chunks(streamNativeLayoutImage(value.image!, assets.register(value.image!.src, 'image', value.image!.nativeAssetFields), nextId, options));
        yield emit(key, encodeNativeLayoutImage(image)); break;
      }
      case 'dimension': yield emit(key, encodeNativeLayoutLinearDimension(value.dimension!)); break;
      case 'angularDimension': yield emit(key, encodeNativeLayoutAngularDimension(value.angularDimension!)); break;
      case 'text': yield emit(key, encodeNativeLayoutText(value.text!)); break;
      case 'labelAnchor': yield emit(key, encodeNativeLayoutDimensionAnchor(value.labelAnchor!)); break;
      case 'modelAnnotation': yield emit(key, encodeNativeLayoutModelAnnotation(value.modelAnnotation!)); break;
      case 'preservedModelConnections': {
        const c = value.preservedModelConnections!; yield emit(key, encodeNativeLayoutConnections(referenceNativeLayoutConnections(c, assets.register(c.snapshot, 'text', c.nativeAssetFields)))); break;
      }
    }
  }
}
