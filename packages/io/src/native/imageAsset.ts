// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import type { ImageId } from '@pushform/core';
import type { ImageAsset, ImageBlob } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeChunks, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
const codec = new NativeRecordCodec({
  id: { id: 1, kind: 'uint32', required: true }, name: { id: 2, kind: 'string', required: true }, mime: { id: 3, kind: 'string', required: true },
  width: { id: 4, kind: 'uint32', required: true }, height: { id: 5, kind: 'uint32', required: true }, sourceHash: { id: 6, kind: 'string', required: true },
  payloadChunks: { id: 7, kind: 'bytes', required: false }, byteLength: { id: 8, kind: 'uint32', required: false },
});
export interface NativeImageRecord {
  asset: ImageAsset;
  payload?: { chunks: number[]; byteLength: number };
  unknownFields: Uint8Array[];
}
const fail = (): never => { throw new NativeChunkError('Invalid native image asset'); };
function validate(record: NativeImageRecord): void {
  if (!record.payload) return;
  const { chunks, byteLength } = record.payload;
  if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > NATIVE_MAX_DECODED_BYTES ||
      chunks.length > NATIVE_MAX_CHUNKS || new Set(chunks).size !== chunks.length || !!byteLength !== !!chunks.length) fail();
  for (const id of chunks) if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff) fail();
}
export function encodeNativeImageAsset(record: NativeImageRecord): Uint8Array {
  validate(record);
  const a = record.asset, fields = { id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height, sourceHash: a.sha256 };
  if (!record.payload) return codec.encode({ fields, unknownFields: record.unknownFields });
  const writer = protobuf.Writer.create(); for (const id of record.payload.chunks) writer.uint32(id);
  return codec.encode({ fields: { ...fields, byteLength: record.payload.byteLength,
    ...(record.payload.chunks.length ? { payloadChunks: new Uint8Array(writer.finish()) } : {}) }, unknownFields: record.unknownFields });
}
export function decodeNativeImageAsset(bytes: Uint8Array): NativeImageRecord {
  const { fields: f, unknownFields } = codec.decode(bytes);
  const result: NativeImageRecord = { asset: { id: f.id as ImageId, name: f.name as string, mime: f.mime as string,
    width: f.width as number, height: f.height as number, sha256: f.sourceHash as string }, unknownFields };
  if (Object.hasOwn(f, 'byteLength')) {
    const reader = protobuf.Reader.create((f.payloadChunks as Uint8Array | undefined) ?? new Uint8Array()), chunks: number[] = [];
    while (reader.pos < reader.len) {
      let value = 0, done = false;
      for (let i = 0; i < 5; i++) {
        if (reader.pos >= reader.len) return fail(); const byte = reader.buf[reader.pos++]!;
        if (i === 4 && byte > 15) return fail(); value += (byte & 127) * 2 ** (7 * i);
        if (!(byte & 128)) { done = true; break; }
      }
      if (!done || chunks.length >= NATIVE_MAX_CHUNKS) return fail(); chunks.push(value);
    }
    result.payload = { byteLength: f.byteLength as number, chunks };
  } else if (Object.hasOwn(f, 'payloadChunks')) return fail();
  validate(result); return result;
}

/** Called once per image asset, independently of its material/placement references. */
export async function* streamNativeImageAsset(
  asset: ImageAsset, blob: ImageBlob | undefined, nextId: () => number, signal?: AbortSignal,
): AsyncGenerator<NativeStoredChunk, NativeImageRecord> {
  const result: NativeImageRecord = { asset, unknownFields: [] };
  if (!blob) return result;
  if (blob.mime !== asset.mime) return fail();
  result.payload = { chunks: [], byteLength: blob.bytes.length };
  for await (const chunk of encodeNativeChunks([blob.bytes], { compression: 'raw', ...(signal ? { signal } : {}) })) {
    const id = nextId(); result.payload.chunks.push(id);
    yield { descriptor: describeNativeChunk(id, 4, 1, true, chunk), data: chunk.data };
  }
  validate(result); return result;
}

/** Read once per asset into the future document's image store; placements use its ID. */
export async function readNativeImageAsset(record: NativeImageRecord, reader: NativeColumnReader, signal?: AbortSignal): Promise<ImageBlob | undefined> {
  validate(record);
  if (!record.payload) return undefined;
  const bytes = await reader.readAsset(record.payload.byteLength, record.payload.chunks, signal);
  return { bytes, mime: record.asset.mime };
}
