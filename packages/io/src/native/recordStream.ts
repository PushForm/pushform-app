// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { decodeNativeChunks, encodeNativeChunks, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';
import type { NativeChunk, NativeChunkOptions } from './chunks';
export const NATIVE_MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 1_000_000;
const fail = (): never => { throw new NativeChunkError('Invalid native metadata record stream'); };

/** Protobuf-delimited records coalesced into pages; never collect the catalog. */
export async function* packNativeRecords(
  records: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options: NativeChunkOptions = {},
): AsyncGenerator<Uint8Array> {
  const size = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!Number.isInteger(size) || size < 1 || size > NATIVE_MAX_CHUNK_BYTES) return fail();
  let page = new Uint8Array(size), used = 0, total = 0, count = 0;
  for await (const record of records) {
    options.signal?.throwIfAborted();
    if (!(record instanceof Uint8Array) || record.length > NATIVE_MAX_RECORD_BYTES || ++count > MAX_RECORDS) return fail();
    const prefix = new Uint8Array(4); let value = record.length, length = 0;
    do { const rest = Math.floor(value / 128); prefix[length++] = (value % 128) | (rest ? 128 : 0); value = rest; } while (value);
    total += length + record.length; if (total > NATIVE_MAX_DECODED_BYTES) return fail();
    for (const bytes of [prefix.subarray(0, length), record]) {
      let at = 0;
      while (at < bytes.length) {
        options.signal?.throwIfAborted();
        const take = Math.min(size - used, bytes.length - at); page.set(bytes.subarray(at, at + take), used); used += take; at += take;
        if (used === size) { yield page; page = new Uint8Array(size); used = 0; }
      }
    }
  }
  options.signal?.throwIfAborted(); if (used) yield page.subarray(0, used);
}

/** Records own their exact-sized buffers; only the active record is assembled. */
export async function* unpackNativeRecords(
  pages: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let record: Uint8Array | undefined, at = 0, length = 0, shift = 0, total = 0, count = 0;
  for await (const page of pages) {
    signal?.throwIfAborted();
    if (!(page instanceof Uint8Array) || page.length > NATIVE_MAX_CHUNK_BYTES) return fail();
    total += page.length; if (total > NATIVE_MAX_DECODED_BYTES) return fail();
    let pos = 0;
    while (pos < page.length) {
      signal?.throwIfAborted();
      if (!record) {
        const byte = page[pos++]!; length += (byte & 127) * 2 ** shift;
        if (length > NATIVE_MAX_RECORD_BYTES || shift > 21) return fail();
        if (byte & 128) { shift += 7; if (shift > 21) return fail(); continue; }
        if (++count > MAX_RECORDS) return fail();
        record = new Uint8Array(length); at = 0; length = 0; shift = 0;
        if (!record.length) { yield record; record = undefined; }
      } else {
        const take = Math.min(record.length - at, page.length - pos); record.set(page.subarray(pos, pos + take), at); at += take; pos += take;
        if (at === record.length) { yield record; record = undefined; }
      }
    }
  }
  signal?.throwIfAborted(); if (record || shift || length) return fail();
}

export function encodeNativeRecordChunks(records: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options: NativeChunkOptions = {}): AsyncGenerator<NativeChunk> {
  return encodeNativeChunks(packNativeRecords(records, options), options);
}
export function decodeNativeRecordChunks(chunks: Iterable<NativeChunk> | AsyncIterable<NativeChunk>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  return unpackNativeRecords(decodeNativeChunks(chunks, signal), signal);
}
