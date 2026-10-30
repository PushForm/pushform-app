// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { decodeNativeChunks, encodeNativeChunks, NATIVE_MAX_CHUNK_BYTES } from './chunks';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []; for await (const item of source) result.push(item); return result;
}

describe('native chunk storage', () => {
  it('round trips across page boundaries, including nonzero-offset inputs', async () => {
    const source = new Uint8Array(200003).map((_, i) => i % 251).subarray(3);
    const chunks = await collect(encodeNativeChunks([source]));
    expect(chunks).toHaveLength(4);
    const pages = await collect(decodeNativeChunks(chunks));
    const restored = new Uint8Array(source.length); let at = 0;
    for (const page of pages) { restored.set(page, at); at += page.length; }
    expect(restored).toEqual(source);
    expect(chunks.every(c => c.codec === 1)).toBe(true);
  });
  it('stores short incompressible data raw and owns output bytes', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const chunks = await collect(encodeNativeChunks([source])); source.fill(0);
    expect(chunks[0]!.codec).toBe(0);
    const pages = await collect(decodeNativeChunks(chunks)); chunks[0]!.data.fill(0);
    expect(pages[0]).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('does not pull the next input block until the consumer requests it', async () => {
    let pulled = 0;
    function* source() { for (let i = 0; i < 3; i++) { pulled++; yield new Uint8Array([i]); } }
    const stream = encodeNativeChunks(source());
    expect(pulled).toBe(0); await stream.next(); expect(pulled).toBe(1);
    await stream.return(undefined); expect(pulled).toBe(1);
  });
  it('rejects payload corruption before returning a page', async () => {
    const chunks = await collect(encodeNativeChunks([new Uint8Array(1000)]));
    chunks[0]!.data[0] = chunks[0]!.data[0]! ^ 1;
    await expect(collect(decodeNativeChunks(chunks))).rejects.toThrow('integrity');
  });
  it('rejects underdeclared expansion and invalid sizes', async () => {
    const chunks = await collect(encodeNativeChunks([new Uint8Array(1000)]));
    chunks[0]!.decodedBytes = 10;
    await expect(collect(decodeNativeChunks(chunks))).rejects.toThrow('length');
    chunks[0]!.decodedBytes = NATIVE_MAX_CHUNK_BYTES + 1;
    await expect(collect(decodeNativeChunks(chunks))).rejects.toThrow('descriptor');
  });
  it('honors cancellation before pulling more data and accepts empty streams', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(collect(encodeNativeChunks([new Uint8Array([1])], { signal: abort.signal }))).rejects.toThrow();
    expect(await collect(encodeNativeChunks([new Uint8Array()]))).toEqual([]);
    expect(await collect(decodeNativeChunks([]))).toEqual([]);
  });
});
