// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutPathHandle } from '@pushform/layout';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { streamNativeNumbers } from './numericStream';
import { NativeRecordCodec } from './record';
import type { NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';

export type LayoutGeometry = Pick<LayoutEntity, 'points' | 'closed' | 'handles' | 'contourStarts' | 'openContours'>;
interface Column { state: number; count: number; chunks: number[] }
const names = ['points', 'handleFlags', 'handleValues', 'contourStarts', 'openContours'] as const;
type Name = typeof names[number];
export interface NativeLayoutGeometryReference {
  closed: boolean;
  columns: Partial<Record<Name, Column>> & { points: Column };
  extensions: Map<string, Uint8Array[]>;
}
export interface NativePackedLayoutGeometry {
  reference: NativeLayoutGeometryReference;
  points: Float64Array;
  handleFlags?: Uint8Array;
  handleValues?: Float64Array;
  contourStarts?: Uint32Array;
  openContours?: Uint32Array;
}
const column = new NativeRecordCodec({ state: { id: 1, kind: 'uint32', required: true }, count: { id: 2, kind: 'uint32', required: true }, chunks: { id: 3, kind: 'bytes', required: false } });
const record = new NativeRecordCodec({ points: { id: 1, kind: 'bytes', required: true }, closed: { id: 2, kind: 'bool', required: true },
  handleFlags: { id: 3, kind: 'bytes', required: false }, handleValues: { id: 4, kind: 'bytes', required: false },
  contourStarts: { id: 5, kind: 'bytes', required: false }, openContours: { id: 6, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout geometry'); };
function validate(r: NativeLayoutGeometryReference): void {
  const seen = new Set<number>(); let bytes = 0;
  for (const key of names) {
    const c = r.columns[key]; if (!c) continue;
    if (c.state !== 0 && c.state !== 1 || !Number.isInteger(c.count) || c.count < 0 ||
      c.state === 0 && (c.count || c.chunks.length) || !!c.count !== !!c.chunks.length || c.chunks.length > NATIVE_MAX_CHUNKS) fail();
    bytes += c.count * (key === 'handleFlags' ? 1 : key === 'points' || key === 'handleValues' ? 8 : 4);
    for (const id of c.chunks) {
      if (!Number.isInteger(id) || id < 1 || id >= 0xffffffff || seen.has(id)) fail(); seen.add(id);
    }
  }
  if (bytes > NATIVE_MAX_DECODED_BYTES || r.columns.points.state !== 1 || r.columns.points.count % 2 ||
    (r.columns.handleFlags?.state === 1 ? r.columns.handleValues?.state !== 1 : !!r.columns.handleValues) ||
    (r.columns.handleValues?.count ?? 0) % 2) fail();
}
export function encodeNativeLayoutGeometry(r: NativeLayoutGeometryReference): Uint8Array {
  validate(r); const fields: Record<string, NativeScalar> = { closed: r.closed };
  for (const key of names) {
    const c = r.columns[key]; if (!c) continue;
    fields[key] = column.encode({ fields: { state: c.state, count: c.count, ...(c.chunks.length ? { chunks: encodeNativeIds(c.chunks) } : {}) }, unknownFields: r.extensions.get(key) ?? [] });
  }
  return record.encode({ fields, unknownFields: r.extensions.get('') ?? [] });
}
export function decodeNativeLayoutGeometry(bytes: Uint8Array): NativeLayoutGeometryReference {
  const decoded = record.decode(bytes), extensions = new Map<string, Uint8Array[]>();
  if (decoded.unknownFields.length) extensions.set('', decoded.unknownFields);
  const columns: Partial<Record<Name, Column>> = {};
  for (const key of names) if (Object.hasOwn(decoded.fields, key)) {
    const c = column.decode(decoded.fields[key] as Uint8Array);
    columns[key] = { state: c.fields.state as number, count: c.fields.count as number, chunks: decodeNativeIds(c.fields.chunks as Uint8Array | undefined) };
    if (c.unknownFields.length) extensions.set(key, c.unknownFields);
  }
  const r = { closed: decoded.fields.closed as boolean, columns: columns as NativeLayoutGeometryReference['columns'], extensions }; validate(r); return r;
}
function* pairs(points: readonly [number, number][]): Generator<number> {
  for (const p of points) { if (!Array.isArray(p) || p.length !== 2) fail(); yield p[0]; yield p[1]; }
}
function state(handle: LayoutPathHandle, key: 'in' | 'out'): number {
  if (!handle || typeof handle !== 'object') return fail();
  return !Object.hasOwn(handle, key) ? 0 : handle[key] === undefined ? 1 : 2;
}
export async function* streamNativeLayoutGeometry(value: LayoutGeometry, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutGeometryReference> {
  const points = { state: 1, count: value.points.length * 2, chunks: yield* streamNativeNumbers(pairs(value.points), 'float64', value.points.length * 2, nextId, options) };
  const r: NativeLayoutGeometryReference = { closed: value.closed, columns: { points }, extensions: new Map() };
  if (Object.hasOwn(value, 'handles')) {
    const handles = value.handles;
    if (handles === undefined) r.columns.handleFlags = { state: 0, count: 0, chunks: [] };
    else {
      if (!Array.isArray(handles)) return fail(); let count = 0;
      function* flags() { for (const h of handles!) { const a = state(h, 'in'), b = state(h, 'out'); count += (Number(a === 2) + Number(b === 2)) * 2; yield a | b << 2; } }
      function* values() { for (const h of handles!) for (const key of ['in', 'out'] as const) if (state(h, key) === 2) yield* pairs([h[key]!]); }
      r.columns.handleFlags = { state: 1, count: handles.length, chunks: yield* streamNativeNumbers(flags(), 'uint8', handles.length, nextId, options) };
      r.columns.handleValues = { state: 1, count, chunks: yield* streamNativeNumbers(values(), 'float64', count, nextId, options) };
    }
  }
  for (const key of ['contourStarts', 'openContours'] as const) if (Object.hasOwn(value, key)) {
    const values = value[key]; if (values !== undefined && !Array.isArray(values)) return fail();
    r.columns[key] = { state: values === undefined ? 0 : 1, count: values?.length ?? 0,
      chunks: yield* streamNativeNumbers(values ?? [], 'uint32', values?.length ?? 0, nextId, options) };
  }
  validate(r); return r;
}
/** Retain packed columns. Entity-kind and contour semantics are checked by document assembly. */
export async function readNativeLayoutGeometry(reference: NativeLayoutGeometryReference, reader: NativeColumnReader, signal?: AbortSignal): Promise<NativePackedLayoutGeometry> {
  validate(reference); const c = reference.columns;
  const result: NativePackedLayoutGeometry = { reference, points: await reader.read('float64', c.points.count, c.points.chunks, signal) };
  for (const key of ['handleValues', 'handleFlags', 'contourStarts', 'openContours'] as const) {
    const column = c[key]; if (column?.state !== 1) continue;
    if (key === 'handleValues') result.handleValues = await reader.read('float64', column.count, column.chunks, signal);
    else if (key === 'handleFlags') result.handleFlags = await reader.read('uint8', column.count, column.chunks, signal);
    else result[key] = await reader.read('uint32', column.count, column.chunks, signal);
  }
  for (const n of result.points) if (!Number.isFinite(n)) fail();
  for (const n of result.handleValues ?? []) if (!Number.isFinite(n)) fail();
  let count = 0;
  for (const flags of result.handleFlags ?? []) {
    if (flags > 10 || (flags & 3) === 3 || (flags >> 2) === 3) fail();
    count += (Number((flags & 3) === 2) + Number((flags >> 2) === 2)) * 2;
  }
  if (count !== (result.handleValues?.length ?? 0)) fail();
  return result;
}
/** Bridge for the existing editor; callers retain the packed representation until installation. */
export function materializeNativeLayoutGeometry(packed: NativePackedLayoutGeometry): LayoutGeometry {
  const value: LayoutGeometry = { closed: packed.reference.closed, points: [] };
  for (let i = 0; i < packed.points.length; i += 2) value.points.push([packed.points[i]!, packed.points[i + 1]!]);
  for (const key of ['contourStarts', 'openContours'] as const) if (packed.reference.columns[key]) {
    Object.defineProperty(value, key, { value: packed[key] === undefined ? undefined : Array.from(packed[key]!), enumerable: true, writable: true, configurable: true });
  }
  if (packed.reference.columns.handleFlags) {
    let handles: LayoutPathHandle[] | undefined;
    if (packed.handleFlags) {
      handles = []; let at = 0;
      for (const flags of packed.handleFlags) {
        const h: LayoutPathHandle = {};
        for (const [key, s] of [['in', flags & 3], ['out', flags >> 2]] as const) {
          if (s === 1) h[key] = undefined;
          else if (s === 2) { h[key] = [packed.handleValues![at++]!, packed.handleValues![at++]!]; }
        }
        handles.push(h);
      }
    }
    value.handles = handles;
  }
  return value;
}
