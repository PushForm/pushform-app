// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import { NATIVE_MAX_CHUNK_BYTES, NativeChunkError } from './chunks';
import type { NativeChunk } from './chunks';

/** Static codec for chunkDescriptor.proto: no reflection or runtime code generation. */
export interface ChunkDescriptor {
  id: number;
  kind: number;
  schemaId: number;
  required: boolean;
  codec: 0 | 1;
  decodedBytes: number;
  storedBytes: number;
  sha256: Uint8Array;
  /** Packed numeric page: logical ID, decoded offset, decoded length triples. */
  slices?: Uint32Array;
  /** Owned complete wire fields, preserved when descriptors are re-encoded. */
  unknownFields: readonly Uint8Array[];
}
export const MAX_CHUNK_DESCRIPTOR_BYTES = 4096;
const fail = (): never => { throw new NativeChunkError('Invalid native chunk descriptor'); };
function uint32(reader: protobuf.Reader): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (reader.pos >= reader.len) return fail();
    const byte = reader.buf[reader.pos++]!;
    if (i === 4 && byte > 15) return fail();
    value += (byte & 127) * 2 ** (i * 7);
    if (!(byte & 128)) return value;
  }
  return fail();
}
function validate(value: ChunkDescriptor): void {
  for (const n of [value.id, value.kind, value.schemaId, value.decodedBytes, value.storedBytes])
    if (!Number.isInteger(n) || n < 1 || n > 0xffff_ffff) fail();
  if (value.kind > 65535 || typeof value.required !== 'boolean' || (value.codec !== 0 && value.codec !== 1) ||
      value.decodedBytes > NATIVE_MAX_CHUNK_BYTES || value.storedBytes > NATIVE_MAX_CHUNK_BYTES + 1024 ||
      (value.codec === 0 && value.decodedBytes !== value.storedBytes) || value.sha256.length !== 32) fail();
  if (value.slices) {
    const s = value.slices;
    if (value.kind !== 2 || value.schemaId !== 2 || !value.required || !s.length || s.length % 3 || s.length > 768 || s[0] !== value.id) fail();
    let end = 0, previous = 0;
    for (let i = 0; i < s.length; i += 3) {
      if (s[i]! <= previous || s[i]! >= 0xffffffff || s[i + 1] !== end || !s[i + 2]) fail();
      previous = s[i]!; end += s[i + 2]!;
    }
    if (end !== value.decodedBytes) fail();
  } else if (value.kind === 2 && value.schemaId === 2) fail();
}

export function decodeChunkDescriptor(bytes: Uint8Array): ChunkDescriptor {
  if (bytes.length > MAX_CHUNK_DESCRIPTOR_BYTES) return fail();
  const reader = protobuf.Reader.create(bytes), seen = new Set<number>();
  const numbers: number[] = [], unknownFields: Uint8Array[] = [];
  let sha256: Uint8Array | undefined;
  let slices: Uint32Array | undefined;
  try {
    while (reader.pos < reader.len) {
      const start = reader.pos, tag = uint32(reader), field = tag >>> 3, wire = tag & 7;
      if (!field || ![0, 1, 2, 5].includes(wire)) return fail();
      if (field <= 8) {
        if (seen.has(field) || wire !== (field === 8 ? 2 : 0)) return fail();
        seen.add(field);
        if (field === 8) {
          const length = uint32(reader);
          if (length !== 32 || length > reader.len - reader.pos) return fail();
          sha256 = new Uint8Array(bytes.subarray(reader.pos, reader.pos + length)); reader.pos += length;
        } else numbers[field] = uint32(reader);
      } else if (field === 9) {
        if (wire !== 2 || slices) return fail();
        const length = uint32(reader), end = reader.pos + length, values: number[] = [];
        if (end > reader.len) return fail();
        while (reader.pos < end) { values.push(uint32(reader)); if (values.length > 768) return fail(); }
        if (reader.pos !== end) return fail();
        slices = new Uint32Array(values);
      } else {
        reader.skipType(wire);
        if (reader.pos > reader.len) return fail();
        unknownFields.push(new Uint8Array(bytes.subarray(start, reader.pos)));
      }
    }
  } catch { return fail(); }
  if (seen.size !== 8 || !sha256 || numbers[4]! > 1) return fail();
  const value: ChunkDescriptor = { id: numbers[1]!, kind: numbers[2]!, schemaId: numbers[3]!, required: numbers[4] === 1,
    codec: numbers[5]! as 0 | 1, decodedBytes: numbers[6]!, storedBytes: numbers[7]!, sha256, unknownFields, ...(slices ? { slices } : {}) };
  validate(value); return value;
}

export function encodeChunkDescriptor(value: ChunkDescriptor): Uint8Array {
  validate(value);
  const writer = protobuf.Writer.create();
  writer.uint32(8).uint32(value.id).uint32(16).uint32(value.kind).uint32(24).uint32(value.schemaId)
    .uint32(32).bool(value.required).uint32(40).uint32(value.codec).uint32(48).uint32(value.decodedBytes)
    .uint32(56).uint32(value.storedBytes).uint32(66).bytes(value.sha256);
  if (value.slices) { writer.uint32(74).fork(); for (const n of value.slices) writer.uint32(n); writer.ldelim(); }
  const known = writer.finish();
  let length = known.length;
  for (const field of value.unknownFields) {
    // A retained fragment must begin with an unknown field, never override known semantics.
    if (!field.length || (uint32(protobuf.Reader.create(field)) >>> 3) <= 9) return fail();
    length += field.length;
    if (length > MAX_CHUNK_DESCRIPTOR_BYTES) return fail();
  }
  const result = new Uint8Array(length); result.set(known); let offset = known.length;
  for (const field of value.unknownFields) { result.set(field, offset); offset += field.length; }
  // Validate appended wire data as well; this catches malformed or embedded known fields.
  decodeChunkDescriptor(result);
  return result;
}

export function describeNativeChunk(id: number, kind: number, schemaId: number, required: boolean, chunk: NativeChunk): ChunkDescriptor {
  const value: ChunkDescriptor = { id, kind, schemaId, required, codec: chunk.codec, decodedBytes: chunk.decodedBytes,
    storedBytes: chunk.data.length, sha256: new Uint8Array(chunk.digest), unknownFields: [] };
  validate(value); return value;
}
