// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id } from '@pushform/core';
import type { SketchVertex } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { encodeNativeColumn } from './columns';
import type { NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';

export interface NativeSketchVerticesReference { count: number; idChunks: number[]; positionChunks: number[]; unknownFields: Uint8Array[] }
export interface NativeSketchVertices { ids: Uint32Array; positions: Float64Array }
const codec = new NativeRecordCodec({ count: { id: 1, kind: 'uint32', required: true }, idChunks: { id: 2, kind: 'bytes', required: false }, positionChunks: { id: 3, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native sketch vertices'); };
function validate(ref: NativeSketchVerticesReference): void {
  if (!Number.isInteger(ref.count) || ref.count < 0 || ref.count * 28 > NATIVE_MAX_DECODED_BYTES || ref.idChunks.length + ref.positionChunks.length > NATIVE_MAX_CHUNKS) fail();
  const used = new Set<number>();
  for (const chunks of [ref.idChunks, ref.positionChunks]) {
    if (!!chunks.length !== !!ref.count) fail();
    for (const id of chunks) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
}
export function encodeNativeSketchVerticesReference(ref: NativeSketchVerticesReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { count: ref.count,
    ...(ref.count ? { idChunks: encodeNativeIds(ref.idChunks), positionChunks: encodeNativeIds(ref.positionChunks) } : {}) }, unknownFields: ref.unknownFields });
}
export function decodeNativeSketchVerticesReference(bytes: Uint8Array): NativeSketchVerticesReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref = { count: f.count as number, idChunks: decodeNativeIds(f.idChunks as Uint8Array | undefined), positionChunks: decodeNativeIds(f.positionChunks as Uint8Array | undefined), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}

/** Two lazy Map passes: at most one conversion page, no full ID/position replicas. */
export async function* streamNativeSketchVertices(
  vertices: ReadonlyMap<Id, SketchVertex>, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeSketchVerticesReference> {
  const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES, count = vertices.size;
  if (!Number.isInteger(pageBytes) || pageBytes < 8 || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % 8 || count * 28 > NATIVE_MAX_DECODED_BYTES ||
      Math.ceil(count * 4 / pageBytes) + Math.ceil(count * 24 / pageBytes) > NATIVE_MAX_CHUNKS) return fail();
  options.signal?.throwIfAborted();
  const ref: NativeSketchVerticesReference = { count, idChunks: [], positionChunks: [], unknownFields: [] }, used = new Set<number>();
  if (!count) return ref;
  for (const type of ['uint32', 'float64'] as const) {
    const width = type === 'uint32' ? 4 : 8, length = pageBytes / width;
    let page = type === 'uint32' ? new Uint32Array(length) : new Float64Array(length), filled = 0, seen = 0;
    async function* emit(): AsyncGenerator<NativeStoredChunk> {
      for await (const chunk of encodeNativeColumn(page.subarray(0, filled), options)) {
        const id = nextId(); if (used.has(id) || id >= 0xffff_ffff) return fail();
        const descriptor = describeNativeChunk(id, 2, 1, true, chunk); used.add(id);
        (type === 'uint32' ? ref.idChunks : ref.positionChunks).push(id); yield { descriptor, data: chunk.data };
      }
    }
    for (const [key, vertex] of vertices) {
      if (++seen > count || vertex.id !== key || !Number.isInteger(key) || key < 0 || key > 0xffff_ffff) return fail();
      if (type === 'float64' && vertex.p.length !== 3) return fail();
      const components = type === 'uint32' ? 1 : 3;
      for (let component = 0; component < components; component++) {
        const n = type === 'uint32' ? vertex.id : vertex.p[component]!; if (!Number.isFinite(n)) return fail();
        page[filled++] = n;
        if (filled === length) { yield* emit(); options.signal?.throwIfAborted(); filled = 0; }
      }
    }
    if (seen !== count) return fail(); if (filled) yield* emit();
    // Drop the conversion page before starting the next column.
    page = new Uint32Array(0);
  }
  validate(ref); return ref;
}

export async function readNativeSketchVertices(ref: NativeSketchVerticesReference, columns: NativeColumnReader, signal?: AbortSignal): Promise<NativeSketchVertices> {
  validate(ref);
  const ids = await columns.read('uint32', ref.count, ref.idChunks, signal);
  columns.validateUniqueIds(ids, signal);
  const positions = await columns.read('float64', ref.count * 3, ref.positionChunks, signal);
  for (const value of positions) if (!Number.isFinite(value)) return fail();
  return { ids, positions };
}
