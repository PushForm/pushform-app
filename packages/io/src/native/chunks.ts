// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { deflateSync, inflateSync } from 'fflate';

/** New native storage pipeline. These limits apply across one document stream. */
export const NATIVE_CHUNK_BYTES = 64 * 1024;
export const NATIVE_MAX_CHUNK_BYTES = 256 * 1024;
export const NATIVE_MAX_DECODED_BYTES = 512 * 1024 * 1024;
export const NATIVE_MAX_CHUNKS = 65536;

export interface NativeChunk {
  codec: 0 | 1;
  decodedBytes: number;
  data: Uint8Array;
  /** SHA-256 of stored bytes. Directory integrity also covers this descriptor. */
  digest: Uint8Array;
}
export interface NativeChunkOptions {
  pageBytes?: number;
  /** Encoded images/embedded packages can bypass redundant compression. */
  compression?: 'auto' | 'raw';
  signal?: AbortSignal;
}
export class NativeChunkError extends Error {}
const invalid = (reason: string): never => { throw new NativeChunkError(reason); };
async function hash(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
function checkBudget(count: number, total: number): void {
  if (count > NATIVE_MAX_CHUNKS || total > NATIVE_MAX_DECODED_BYTES) invalid('Native document exceeds decoding budget');
}

/**
 * Backpressure is supplied by the consumer: no queued compression jobs and no
 * archive-sized destination allocation. Input views are borrowed until next().
 * Every emitted payload owns its bytes. Empty input blocks carry no chunk.
 */
export async function* encodeNativeChunks(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options: NativeChunkOptions = {},
): AsyncGenerator<NativeChunk> {
  const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!Number.isInteger(pageBytes) || pageBytes < 1 || pageBytes > NATIVE_MAX_CHUNK_BYTES) invalid('Invalid native page size');
  let count = 0, total = 0;
  for await (const block of source) {
    options.signal?.throwIfAborted();
    for (let offset = 0; offset < block.length; offset += pageBytes) {
      options.signal?.throwIfAborted();
      const page = block.subarray(offset, Math.min(offset + pageBytes, block.length));
      checkBudget(++count, total += page.length);
      const compressed = options.compression === 'raw' ? null : deflateSync(page, { level: 1 });
      const codec = compressed && compressed.length < page.length ? 1 : 0;
      const data = codec === 1 ? compressed! : new Uint8Array(page);
      const digest = await hash(data);
      options.signal?.throwIfAborted();
      yield { codec, decodedBytes: page.length, data, digest };
    }
  }
}

/**
 * Validate and decode one bounded chunk at a time. A yielded page is owned by
 * its consumer. Do not install partial document state: the caller must finish
 * directory/reference validation and the full stream before publishing it.
 */
export async function* decodeNativeChunks(
  source: Iterable<NativeChunk> | AsyncIterable<NativeChunk>, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let count = 0, total = 0;
  for await (const chunk of source) {
    signal?.throwIfAborted();
    if (!Number.isInteger(chunk.decodedBytes) || chunk.decodedBytes < 1 || chunk.decodedBytes > NATIVE_MAX_CHUNK_BYTES ||
        !(chunk.data instanceof Uint8Array) || chunk.data.length < 1 || chunk.data.length > NATIVE_MAX_CHUNK_BYTES + 1024 ||
        !(chunk.digest instanceof Uint8Array) || chunk.digest.length !== 32 || (chunk.codec !== 0 && chunk.codec !== 1))
      invalid('Invalid native chunk descriptor');
    checkBudget(++count, total += chunk.decodedBytes);
    const digest = await hash(chunk.data);
    signal?.throwIfAborted();
    if (!digest.every((byte, i) => byte === chunk.digest[i])) invalid('Native chunk integrity check failed');
    let data: Uint8Array;
    if (chunk.codec === 0) {
      if (chunk.data.length !== chunk.decodedBytes) invalid('Native chunk length mismatch');
      data = new Uint8Array(chunk.data);
    } else {
      try {
        // The extra byte detects underdeclared expansion even if inflate clamps
        // output writes. No allocation follows an untrusted expanded-size claim.
        data = inflateSync(chunk.data, { out: new Uint8Array(chunk.decodedBytes + 1) });
      } catch { return invalid('Invalid native compressed chunk'); }
      if (data.length !== chunk.decodedBytes) invalid('Native chunk length mismatch');
    }
    yield data;
  }
}
