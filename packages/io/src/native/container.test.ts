// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { describeNativeChunk } from './chunkDescriptor';
import { encodeNativeChunks } from './chunks';
import { nativeBlobSource, openNativeContainer, writeNativeContainer } from './container';
import type { NativeStoredChunk } from './container';

async function fixture(): Promise<NativeStoredChunk[]> {
  const result: NativeStoredChunk[] = []; let id = 1;
  for await (const chunk of encodeNativeChunks([new Uint8Array([1, 2, 3]), new Uint8Array(150000)])) {
    result.push({ descriptor: describeNativeChunk(id, id === 1 ? 1 : 99, 1, id === 1, chunk), data: chunk.data }); id++;
  }
  return result;
}
async function encode(chunks: NativeStoredChunk[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const result = await writeNativeContainer({ kind: 1, root: 1 }, chunks, { write: async bytes => { parts.push(new Uint8Array(bytes)); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes;
}
const source = (bytes: Uint8Array) => ({ size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) });
const supports = (kind: number, schema: number) => kind === 1 && schema === 1;

describe('incremental native container', () => {
  it('opens the index without reading payloads and reads independently owned pages', async () => {
    const bytes = await encode(await fixture()), calls: [number, number][] = [], input = source(bytes);
    const opened = await openNativeContainer({ size: input.size, read: async (offset, length) => { calls.push([offset, length]); return input.read(offset, length); } }, supports);
    expect(calls).toHaveLength(3); expect(opened.entries).toHaveLength(4);
    const page = await opened.read(opened.entries[0]!); expect(page).toEqual(new Uint8Array([1, 2, 3]));
    page.fill(0); expect(await opened.read(opened.entries[0]!)).toEqual(new Uint8Array([1, 2, 3]));
    expect((await opened.read(opened.entries[3]!)).length).toBe(18928);
  });
  it('supports Blob slice reads and unknown optional descriptors', async () => {
    const bytes = await encode(await fixture());
    const opened = await openNativeContainer(nativeBlobSource(new Blob([bytes as Uint8Array<ArrayBuffer>])), supports);
    expect(opened.entries[1]!.descriptor.kind).toBe(99);
    expect((await opened.read(opened.entries[1]!)).every(v => v === 0)).toBe(true);
  });
  it('does not consume another source chunk while the sink is waiting', async () => {
    const chunks = await fixture(); let consumed = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    async function* input() { for (const chunk of chunks) { consumed++; yield chunk; } }
    let writes = 0;
    const writing = writeNativeContainer({ kind: 1, root: 1 }, input(), { write: async () => { if (++writes === 1) await held; } });
    await Promise.resolve(); expect(consumed).toBe(0); release(); await writing; expect(consumed).toBe(4);
  });
  it('rejects unsupported required records, duplicate IDs and missing roots', async () => {
    const chunks = await fixture(); chunks[1]!.descriptor.required = true;
    await expect(openNativeContainer(source(await encode(chunks)), supports)).rejects.toThrow('Unsupported');
    chunks[1]!.descriptor.id = 1; await expect(encode(chunks)).rejects.toThrow('strictly increasing');
    await expect(encode([])).rejects.toThrow('root');
  });
  it('reports a stored-length mismatch before writing its payload', async () => {
    const chunks = await fixture(); chunks[0]!.data = new Uint8Array(1);
    await expect(encode(chunks)).rejects.toThrow('stored length mismatch');
  });
  it('rejects header, directory, footer and truncation damage', async () => {
    const original = await encode(await fixture());
    for (const at of [12, original.length - 65, original.length - 64, original.length - 1]) {
      const bytes = original.slice(); bytes[at] = bytes[at]! ^ 1;
      await expect(openNativeContainer(source(bytes), supports)).rejects.toThrow();
    }
    await expect(openNativeContainer(source(original.subarray(0, original.length - 1)), supports)).rejects.toThrow();
  });
  it('checks payload integrity before handing data to the document adapter', async () => {
    const bytes = await encode(await fixture()); bytes[32] = bytes[32]! ^ 1;
    const opened = await openNativeContainer(source(bytes), supports);
    await expect(opened.read(opened.entries[0]!)).rejects.toThrow('integrity');
  });
  it('does not publish a footer after sink failure or cancellation', async () => {
    const chunks = await fixture(); let calls = 0;
    await expect(writeNativeContainer({ kind: 1, root: 1 }, chunks, { write: async () => { if (++calls === 2) throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(calls).toBe(2);
    const abort = new AbortController(); abort.abort();
    await expect(openNativeContainer(source(await encode(chunks)), supports, abort.signal)).rejects.toThrow();
  });
});
