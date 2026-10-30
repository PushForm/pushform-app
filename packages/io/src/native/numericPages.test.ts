// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { encodeNativeChunks, NATIVE_MAX_CHUNKS } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { openNativeContainer, writeNativeContainer } from './container';
import type { NativeStoredChunk } from './container';
import { packNativeNumericPages } from './numericPages';

async function fragment(): Promise<NativeStoredChunk> {
  for await (const chunk of encodeNativeChunks([new Uint8Array([1, 2, 3, 4])])) return { descriptor: describeNativeChunk(1, 2, 1, true, chunk), data: chunk.data };
  throw new Error('missing chunk');
}
async function file(count: number, pageBytes = 64 * 1024) {
  const base = await fragment();
  async function* chunks() {
    for (let id = 1; id <= count; id++) yield { ...base, descriptor: { ...base.descriptor, id } };
    yield { ...base, descriptor: { ...base.descriptor, id: 0xffffffff, kind: 1 } };
  }
  const parts: Uint8Array[] = [];
  const info = await writeNativeContainer({ kind: 1, root: 0xffffffff }, packNativeNumericPages(chunks(), { pageBytes }), { write: async b => { parts.push(b.slice()); } });
  const bytes = new Uint8Array(info.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return { bytes, info };
}
const supports = (kind: number, schema: number) => (kind === 1 && schema === 1) || (kind === 2 && schema === 2);
it('opens logical slices without eager payload reads and reuses one verified page', async () => {
  const { bytes, info } = await file(4, 8); let reads = 0;
  expect(info.chunks).toBe(3);
  const opened = await openNativeContainer({ size: bytes.length, read: async (at, n) => { reads++; return bytes.subarray(at, at + n); } }, supports);
  expect(reads).toBe(3); expect(opened.entries.map(e => e.descriptor.id)).toEqual([1, 2, 3, 4, 0xffffffff]);
  const a = await opened.read(opened.entries[0]!); a.fill(9);
  expect(await opened.read(opened.entries[1]!)).toEqual(new Uint8Array([1, 2, 3, 4])); expect(reads).toBe(4);
  await opened.read(opened.entries[2]!); expect(reads).toBe(5);
  expect(await opened.read(opened.entries[0]!)).toEqual(new Uint8Array([1, 2, 3, 4])); expect(reads).toBe(6);
});
it('keeps more than 65,536 logical fragments below the physical chunk limit', async () => {
  const { bytes, info } = await file(NATIVE_MAX_CHUNKS + 1);
  expect(info.chunks).toBe(258);
  const opened = await openNativeContainer({ size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) }, supports);
  expect(opened.entries).toHaveLength(NATIVE_MAX_CHUNKS + 2);
  expect(await opened.read(opened.entries[NATIVE_MAX_CHUNKS]!)).toEqual(new Uint8Array([1, 2, 3, 4]));
}, 30_000);
it('checks physical page integrity and rejects unsupported packed pages', async () => {
  const { bytes } = await file(2);
  await expect(openNativeContainer({ size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) }, (_kind, schema) => schema === 1)).rejects.toThrow('Unsupported');
  bytes[32] = bytes[32]! ^ 1;
  const opened = await openNativeContainer({ size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) }, supports);
  await expect(opened.read(opened.entries[1]!)).rejects.toThrow('integrity');
});
it('rejects collisions with IDs inside an earlier packed page', async () => {
  const base = await fragment();
  const packed = { ...base, descriptor: { ...base.descriptor, schemaId: 2, slices: new Uint32Array([1, 0, 2, 3, 2, 2]) } };
  await expect(writeNativeContainer({ kind: 1, root: 2 }, [packed, { ...base, descriptor: { ...base.descriptor, id: 2, kind: 1 } }],
    { write: async () => {} })).rejects.toThrow('strictly increasing');
});
it('preserves extended numeric descriptors without grouping them and honors cancellation', async () => {
  const base = await fragment(), extended = { ...base, descriptor: { ...base.descriptor, unknownFields: [new Uint8Array([0x98, 6, 7])] } };
  async function* source() { yield extended; }
  const result = []; for await (const chunk of packNativeNumericPages(source())) result.push(chunk);
  expect(result).toEqual([extended]);
  const controller = new AbortController(); controller.abort();
  await expect(packNativeNumericPages(source(), { signal: controller.signal }).next()).rejects.toThrow();
});
