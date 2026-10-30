// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeNativeDocumentRoot, encodeNativeDocumentRoot, NATIVE_ROOT_ID, openNativeDocumentIndex } from './documentRoot';
import type { NativeDocumentRoot } from './documentRoot';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer } from './container';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./documentRoot.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.DocumentRoot');
const root = (): NativeDocumentRoot => ({ schemaMajor: 1, documentKind: 1, metadataChunk: 1, recordChunks: [], requiredCapabilities: [], unknownFields: [] });
async function fixture(value: NativeDocumentRoot) {
  async function* records(): AsyncGenerator<NativeStoredChunk> {
    for await (const chunk of encodeNativeChunks([new Uint8Array([1])])) yield { descriptor: describeNativeChunk(1, 3, 1, true, chunk), data: chunk.data };
    for await (const chunk of encodeNativeChunks([encodeNativeDocumentRoot(value)])) yield { descriptor: describeNativeChunk(NATIVE_ROOT_ID, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [];
  const result = await writeNativeContainer({ kind: 1, root: NATIVE_ROOT_ID }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const reads: number[] = [];
  return { reads, size: bytes.length, read: async (offset: number, length: number) => { reads.push(offset); return bytes.subarray(offset, offset + length); } };
}
describe('native document root', () => {
  it('matches the Protobuf schema and preserves owned unknown fields', () => {
    const value = { ...root(), recordChunks: [2, 3], requiredCapabilities: [7] };
    expect(Array.from(encodeNativeDocumentRoot(value))).toEqual(Array.from(schema.encode(value).finish()));
    value.unknownFields.push(new Uint8Array([0x98, 6, 7]));
    const bytes = encodeNativeDocumentRoot(value), decoded = decodeNativeDocumentRoot(bytes); bytes.fill(0);
    expect(decoded).toEqual(value);
  });
  it('opens the root and checks capability support without reading metadata', async () => {
    const source = await fixture({ ...root(), requiredCapabilities: [7] });
    await expect(openNativeDocumentIndex(source, new Set(), () => true)).rejects.toThrow('capability: 7');
    expect(source.reads).not.toContain(32);
    const opened = await openNativeDocumentIndex(source, new Set([7]), () => true);
    expect(opened.metadata.descriptor.id).toBe(1); expect(source.reads).not.toContain(32);
  });
  it('rejects missing references and mismatched document kinds', async () => {
    await expect(openNativeDocumentIndex(await fixture({ ...root(), recordChunks: [2] }), new Set(), () => true)).rejects.toThrow();
    await expect(openNativeDocumentIndex(await fixture({ ...root(), documentKind: 2 }), new Set(), () => true)).rejects.toThrow();
  });
  it('rejects unsupported versions, repeated references and missing required fields', () => {
    expect(() => encodeNativeDocumentRoot({ ...root(), schemaMajor: 2 })).toThrow();
    expect(() => encodeNativeDocumentRoot({ ...root(), recordChunks: [2, 2] })).toThrow();
    expect(() => decodeNativeDocumentRoot(new Uint8Array([8, 1, 16, 1]))).toThrow();
  });
});
