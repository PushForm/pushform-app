// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { encodeNativeColumn } from './columns';
import type { NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';
import { validateNativeDefinitionOrder } from './definition';
import type { NativeDefinitionRecord } from './definition';

/** Borrow an immutable captured revision. Convert at most one page of boxed IDs at a time. */
export async function* streamNativeDefinitionOrder(
  values: readonly number[] | Uint32Array, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeDefinitionRecord['entityOrder']> {
  const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES, count = values.length;
  if (!Number.isInteger(pageBytes) || pageBytes < 4 || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % 4 ||
      !Number.isSafeInteger(count) || count < 0 || count * 4 > NATIVE_MAX_DECODED_BYTES || Math.ceil(count * 4 / pageBytes) > NATIVE_MAX_CHUNKS)
    throw new NativeChunkError('Invalid native definition order size');
  options.signal?.throwIfAborted();
  const ref: NativeDefinitionRecord['entityOrder'] = { count, chunks: [] }, ids = new Set<number>();
  const pageCount = pageBytes / 4;
  for (let at = 0; at < count; at += pageCount) {
    options.signal?.throwIfAborted();
    const length = Math.min(pageCount, count - at);
    const page = values instanceof Uint32Array ? values.subarray(at, at + length) : new Uint32Array(length);
    if (!(values instanceof Uint32Array)) for (let i = 0; i < length; i++) {
      const value = values[at + i]!;
      if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new NativeChunkError('Invalid native entity order ID');
      page[i] = value;
    }
    for await (const chunk of encodeNativeColumn(page, options)) {
      const id = nextId();
      if (ids.has(id)) throw new NativeChunkError('Duplicate native order chunk ID');
      const descriptor = describeNativeChunk(id, 2, 1, true, chunk);
      ids.add(id); ref.chunks.push(id); yield { descriptor, data: chunk.data };
    }
  }
  validateNativeDefinitionOrder(ref); return ref;
}

/** Returns the canonical packed column, without allocating a boxed number-array replica. */
export async function readNativeDefinitionOrder(
  ref: NativeDefinitionRecord['entityOrder'], columns: NativeColumnReader, signal?: AbortSignal,
): Promise<Uint32Array> {
  validateNativeDefinitionOrder(ref);
  return columns.read('uint32', ref.count, ref.chunks, signal);
}
