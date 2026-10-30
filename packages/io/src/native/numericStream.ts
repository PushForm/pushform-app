// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeChunkError, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { encodeNativeColumn } from './columns';
import type { NativeColumnType } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';

/** Convert a lazy numeric traversal into owned storage chunks with one conversion page. */
export async function* streamNativeNumbers(
  values: Iterable<number>, type: NativeColumnType, count: number, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, number[]> {
  const width = type === 'float64' ? 8 : type === 'uint32' ? 4 : 1, pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!Number.isSafeInteger(count) || count < 0 || count * width > NATIVE_MAX_DECODED_BYTES || !Number.isInteger(pageBytes) ||
      pageBytes < width || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % width || Math.ceil(count * width / pageBytes) > NATIVE_MAX_CHUNKS)
    throw new NativeChunkError('Invalid native numeric stream size');
  options.signal?.throwIfAborted();
  const length = Math.min(count, pageBytes / width), page = type === 'float64' ? new Float64Array(length) : type === 'uint32' ? new Uint32Array(length) : new Uint8Array(length);
  const ids: number[] = [], used = new Set<number>(); let filled = 0, seen = 0;
  async function* emit(): AsyncGenerator<NativeStoredChunk> {
    for await (const chunk of encodeNativeColumn(page.subarray(0, filled), options)) {
      const id = nextId(); if (used.has(id) || id >= 0xffff_ffff) throw new NativeChunkError('Invalid native numeric stream chunk ID');
      const descriptor = describeNativeChunk(id, 2, 1, true, chunk); used.add(id); ids.push(id); yield { descriptor, data: chunk.data };
    }
  }
  for (const n of values) {
    if (++seen > count || !Number.isFinite(n) || (type !== 'float64' && (!Number.isInteger(n) || n < 0 || n > (type === 'uint32' ? 0xffff_ffff : 255))))
      throw new NativeChunkError('Invalid native numeric stream value/count');
    page[filled++] = n;
    if (filled === length) { yield* emit(); options.signal?.throwIfAborted(); filled = 0; }
  }
  if (seen !== count) throw new NativeChunkError('Truncated native numeric stream');
  if (filled) yield* emit(); options.signal?.throwIfAborted(); return ids;
}
