// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { decodeNativeChunks, encodeNativeChunks, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NativeChunkError } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';

/** Coalesce consecutive numeric chunks while preserving every logical column ID.
 * Retains one conversion page and at most 256 slice triples; sink backpressure propagates. */
export async function* packNativeNumericPages(source: AsyncIterable<NativeStoredChunk>, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk> {
  const size = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!Number.isInteger(size) || size < 1 || size > NATIVE_MAX_CHUNK_BYTES) throw new NativeChunkError('Invalid packed numeric page size');
  const page = new Uint8Array(size), slices: number[] = [];
  let used = 0;
  async function* flush(): AsyncGenerator<NativeStoredChunk> {
    if (!used) return;
    for await (const chunk of encodeNativeChunks([page.subarray(0, used)], options)) {
      const descriptor = { ...describeNativeChunk(slices[0]!, 2, 1, true, chunk), schemaId: 2, slices: new Uint32Array(slices) };
      yield { descriptor, data: chunk.data };
    }
    used = 0; slices.length = 0;
  }
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    const d = chunk.descriptor;
    if (d.kind !== 2 || d.schemaId !== 1 || !d.required || d.unknownFields.length || d.decodedBytes > size) {
      yield* flush(); yield chunk; continue;
    }
    if (used + d.decodedBytes > size || slices.length === 768) yield* flush();
    for await (const bytes of decodeNativeChunks([{ codec: d.codec, decodedBytes: d.decodedBytes, data: chunk.data, digest: d.sha256 }], options.signal)) {
      slices.push(d.id, used, bytes.length); page.set(bytes, used); used += bytes.length;
    }
  }
  yield* flush();
}
