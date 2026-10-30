// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { streamNativeDefinitionOrder, readNativeDefinitionOrder } from './definitionOrder';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import type { NativeDefinitionRecord } from './definition';

describe('streamed definition order', () => {
  it('round trips boxed order through indexed chunks into one packed allocation', async () => {
    const values = Array.from({ length: 65_539 }, (_, i) => i === 0 ? 0xffff_ffff : i);
    let ref: NativeDefinitionRecord['entityOrder'] = { count: 0, chunks: [] }, nextId = 1;
    async function* records() {
      ref = yield* streamNativeDefinitionOrder(values, () => nextId++);
      for await (const chunk of encodeNativeChunks([new Uint8Array([1])])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
    }
    const parts: Uint8Array[] = [];
    const result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
    const bytes = new Uint8Array(result.storedBytes); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
    const budget = new NativeColumnBudget(values.length * 4), reader = new NativeColumnReader(opened, budget);
    const decoded = await readNativeDefinitionOrder(ref, reader);
    expect(decoded).toEqual(Uint32Array.from(values)); expect(ref.chunks).toHaveLength(5); expect(budget.usedBytes).toBe(262_156);
  });
  it('reads only the demanded page and stops conversion on consumer cancellation', async () => {
    let reads = 0;
    const values = new Proxy(new Array<number>(100_000), { get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) { reads++; return Number(key); } return Reflect.get(target, key, receiver);
    } });
    let id = 0; const source = streamNativeDefinitionOrder(values, () => ++id);
    expect(reads).toBe(0); await source.next(); expect(reads).toBe(16_384);
    await source.return({ count: 0, chunks: [] }); expect(reads).toBe(16_384);
  });
  it('preserves typed-array offsets and rejects malformed source IDs, chunk IDs and aborts', async () => {
    const source = streamNativeDefinitionOrder(new Uint32Array([99, 0, 0xffff_ffff, 99]).subarray(1, 3), () => 1, { compression: 'raw' });
    const first = await source.next(); if (first.done) throw new Error('Missing chunk');
    expect(Array.from(first.value.data)).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
    expect((await source.next()).value).toEqual({ count: 2, chunks: [1] });
    for (const value of [-1, 0.5, 0x1_0000_0000, NaN]) await expect(streamNativeDefinitionOrder([value], () => 1).next()).rejects.toThrow();
    const duplicate = streamNativeDefinitionOrder([1, 2], () => 1, { pageBytes: 4 }); await duplicate.next(); await expect(duplicate.next()).rejects.toThrow('Duplicate');
    const aborted = new AbortController(); aborted.abort(); await expect(streamNativeDefinitionOrder([], () => 1, { signal: aborted.signal }).next()).rejects.toThrow();
    expect((await streamNativeDefinitionOrder([], () => 1).next()).value).toEqual({ count: 0, chunks: [] });
  });
});
