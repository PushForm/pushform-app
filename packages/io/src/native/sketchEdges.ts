// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id } from '@pushform/core';
import type { CommonAttrs, SketchEdge } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { encodeNativeColumn } from './columns';
import type { NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';
import type { NativeCommonPropertyReader } from './commonProperty';

export interface NativeSketchEdgesReference { count: number; idChunks: number[]; rowChunks: number[]; flagChunks: number[]; unknownFields: Uint8Array[] }
export interface NativeSketchEdges { ids: Uint32Array; rows: Uint32Array; flags: Uint8Array }
// Compile-time coverage for edge-specific data; CommonAttrs is covered by its shared catalog codec.
const sourceFields = { id: 'ids', a: 'rows[0]', b: 'rows[1]', curveId: 'rows[3]/flags[2]', soft: 'flags[0]', smooth: 'flags[1]' } satisfies Record<keyof Omit<SketchEdge, keyof CommonAttrs>, string>;
void sourceFields;
const codec = new NativeRecordCodec({ count: { id: 1, kind: 'uint32', required: true }, idChunks: { id: 2, kind: 'bytes', required: false }, rowChunks: { id: 3, kind: 'bytes', required: false }, flagChunks: { id: 4, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native sketch edges'); };
function uint(value: number): number { if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) return fail(); return value; }
function validate(ref: NativeSketchEdgesReference): void {
  if (!Number.isInteger(ref.count) || ref.count < 0 || ref.count * 21 > NATIVE_MAX_DECODED_BYTES || ref.idChunks.length + ref.rowChunks.length + ref.flagChunks.length > NATIVE_MAX_CHUNKS) fail();
  const used = new Set<number>();
  for (const chunks of [ref.idChunks, ref.rowChunks, ref.flagChunks]) {
    if (!!chunks.length !== !!ref.count) fail();
    for (const id of chunks) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
}
export function encodeNativeSketchEdgesReference(ref: NativeSketchEdgesReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { count: ref.count, ...(ref.count ? { idChunks: encodeNativeIds(ref.idChunks), rowChunks: encodeNativeIds(ref.rowChunks), flagChunks: encodeNativeIds(ref.flagChunks) } : {}) }, unknownFields: ref.unknownFields });
}
export function decodeNativeSketchEdgesReference(bytes: Uint8Array): NativeSketchEdgesReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref = { count: f.count as number, idChunks: decodeNativeIds(f.idChunks as Uint8Array | undefined), rowChunks: decodeNativeIds(f.rowChunks as Uint8Array | undefined), flagChunks: decodeNativeIds(f.flagChunks as Uint8Array | undefined), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}

/** Property interning is invoked once per edge. All three source traversals are page-bounded. */
export async function* streamNativeSketchEdges(
  edges: ReadonlyMap<Id, SketchEdge>, propertyId: (edge: SketchEdge) => number, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeSketchEdgesReference> {
  const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES, count = edges.size;
  if (!Number.isInteger(pageBytes) || pageBytes < 4 || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % 4 || count * 21 > NATIVE_MAX_DECODED_BYTES ||
      Math.ceil(count * 4 / pageBytes) + Math.ceil(count * 16 / pageBytes) + Math.ceil(count / pageBytes) > NATIVE_MAX_CHUNKS) return fail();
  options.signal?.throwIfAborted();
  const ref: NativeSketchEdgesReference = { count, idChunks: [], rowChunks: [], flagChunks: [], unknownFields: [] }, used = new Set<number>();
  if (!count) return ref;
  for (const column of ['idChunks', 'rowChunks', 'flagChunks'] as const) {
    const capacity = column === 'flagChunks' ? pageBytes : pageBytes / 4;
    const page = column === 'flagChunks' ? new Uint8Array(capacity) : new Uint32Array(capacity);
    let filled = 0, seen = 0;
    async function* emit(): AsyncGenerator<NativeStoredChunk> {
      for await (const chunk of encodeNativeColumn(page.subarray(0, filled), options)) {
        const id = nextId(); if (used.has(id) || id >= 0xffff_ffff) return fail();
        const descriptor = describeNativeChunk(id, 2, 1, true, chunk); used.add(id); ref[column].push(id); yield { descriptor, data: chunk.data };
      }
    }
    for (const [key, edge] of edges) {
      if (++seen > count || edge.id !== key) return fail(); uint(key);
      if (column === 'rowChunks') {
        const property = uint(propertyId(edge)); if (!property) return fail();
        // Write directly; avoid a temporary boxed tuple per edge.
        for (let component = 0; component < 4; component++) {
          page[filled++] = uint(component === 0 ? edge.a : component === 1 ? edge.b : component === 2 ? property : edge.curveId === null ? 0 : edge.curveId);
          if (filled === capacity) { yield* emit(); options.signal?.throwIfAborted(); filled = 0; }
        }
      } else {
        if (typeof edge.soft !== 'boolean' || typeof edge.smooth !== 'boolean') return fail();
        page[filled++] = column === 'idChunks' ? edge.id : Number(edge.soft) | (Number(edge.smooth) << 1) | (edge.curveId !== null ? 4 : 0);
        if (filled === capacity) { yield* emit(); options.signal?.throwIfAborted(); filled = 0; }
      }
    }
    if (seen !== count) return fail(); if (filled) yield* emit();
  }
  validate(ref); return ref;
}

export async function readNativeSketchEdges(
  ref: NativeSketchEdgesReference, columns: NativeColumnReader, properties: NativeCommonPropertyReader,
  hasVertex: (id: number) => boolean, hasCurve: (id: number) => boolean, signal?: AbortSignal,
): Promise<NativeSketchEdges> {
  validate(ref);
  const ids = await columns.read('uint32', ref.count, ref.idChunks, signal); columns.validateUniqueIds(ids, signal);
  const rows = await columns.read('uint32', ref.count * 4, ref.rowChunks, signal), flags = await columns.read('uint8', ref.count, ref.flagChunks, signal);
  for (let i = 0; i < ref.count; i++) {
    const at = i * 4, flag = flags[i]!, curve = rows[at + 3]!;
    if (flag > 7 || !hasVertex(rows[at]!) || !hasVertex(rows[at + 1]!) || ((flag & 4) ? !hasCurve(curve) : curve !== 0)) return fail();
    properties.get(rows[at + 2]!);
  }
  return { ids, rows, flags };
}
