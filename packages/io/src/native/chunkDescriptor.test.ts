// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeChunkDescriptor, describeNativeChunk, encodeChunkDescriptor } from './chunkDescriptor';
import { encodeNativeChunks } from './chunks';
const type = protobuf.parse(readFileSync(new URL('./chunkDescriptor.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.ChunkDescriptor');
const fixture = () => ({ id: 1, kind: 2, schemaId: 1, required: true, codec: 0 as const,
  decodedBytes: 3, storedBytes: 3, sha256: new Uint8Array(32), unknownFields: [] });

describe('native Protobuf chunk descriptors', () => {
  it('interoperates byte-for-byte with the .proto schema', () => {
    const value = fixture(), bytes = encodeChunkDescriptor(value);
    expect(Array.from(type.encode(value).finish())).toEqual(Array.from(bytes));
    expect(decodeChunkDescriptor(type.encode(value).finish())).toEqual(value);
  });
  it('preserves unknown fields with independent ownership across a known edit', () => {
    const value = { ...fixture(), unknownFields: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeChunkDescriptor(value), decoded = decodeChunkDescriptor(bytes); bytes.fill(0);
    decoded.id = 2;
    expect(decodeChunkDescriptor(encodeChunkDescriptor(decoded))).toEqual({ ...value, id: 2 });
  });
  it('rejects missing, duplicate, overflowing, wrongly typed and unsupported fields', () => {
    const valid = encodeChunkDescriptor(fixture());
    for (const suffix of [[8, 1], [8, 255, 255, 255, 255, 31], [10, 0]]) {
      const bad = new Uint8Array(valid.length + suffix.length); bad.set(valid); bad.set(suffix, valid.length);
      expect(() => decodeChunkDescriptor(bad)).toThrow();
    }
    expect(() => decodeChunkDescriptor(valid.subarray(2))).toThrow();
    const unsupported = type.encode({ ...fixture(), codec: 9 }).finish();
    expect(() => decodeChunkDescriptor(unsupported)).toThrow();
  });
  it('rejects malformed extension fragments and attempts to override known fields', () => {
    for (const field of [[8, 7], [0x98, 6], [0x98, 6, 7, 8, 9]])
      expect(() => encodeChunkDescriptor({ ...fixture(), unknownFields: [new Uint8Array(field)] })).toThrow();
  });
  it('describes actual bounded compressor output', async () => {
    let id = 1;
    for await (const chunk of encodeNativeChunks([new Uint8Array(150000)])) {
      const record = describeNativeChunk(id++, 2, 1, true, chunk);
      expect(decodeChunkDescriptor(encodeChunkDescriptor(record))).toEqual(record);
    }
    expect(id).toBe(4);
  });
  it('validates contiguous packed numeric slices and interoperates with Protobuf', () => {
    const value = { ...fixture(), schemaId: 2, slices: new Uint32Array([1, 0, 1, 7, 1, 2]) };
    const bytes = encodeChunkDescriptor(value);
    expect(Array.from(type.encode({ ...value, slices: Array.from(value.slices) }).finish())).toEqual(Array.from(bytes));
    expect(decodeChunkDescriptor(bytes)).toEqual(value);
    for (const slices of [[1, 1, 3], [1, 0, 2], [1, 0, 1, 1, 1, 2], [2, 0, 3], [1, 0, 0, 7, 0, 3]]) {
      expect(() => encodeChunkDescriptor({ ...value, slices: new Uint32Array(slices) })).toThrow();
    }
    expect(() => encodeChunkDescriptor({ ...fixture(), schemaId: 2 })).toThrow();
    expect(() => encodeChunkDescriptor({ ...value, schemaId: 1 })).toThrow();
  });
});
