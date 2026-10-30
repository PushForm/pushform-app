// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { decodeNativeColumn, encodeNativeColumn, NativeColumnBudget, NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
import type { NativeChunk } from './chunks';
async function collect(source: AsyncIterable<NativeChunk>): Promise<NativeChunk[]> {
  const result: NativeChunk[] = []; for await (const chunk of source) result.push(chunk); return result;
}

describe('native typed columns', () => {
  it('preserves exact Float64 bits, signed zero, and subarray offsets across pages', async () => {
    const values = new Float64Array([99, -0, Number.MIN_VALUE, Number.MAX_VALUE, Math.PI, -123.456, 99]).subarray(1, 6);
    const chunks = await collect(encodeNativeColumn(values, { pageBytes: 16 }));
    const budget = new NativeColumnBudget();
    const decoded = await decodeNativeColumn('float64', values.length, chunks, budget);
    expect(new Uint8Array(decoded.buffer)).toEqual(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    expect(Object.is(decoded[0], -0)).toBe(true); expect(decoded.buffer).not.toBe(values.buffer);
    expect(budget.usedBytes).toBe(40);
  });
  it('round trips Uint32 limits and byte columns without number arrays', async () => {
    const integers = new Uint32Array([0, 0xffff_ffff, 0x8000_0000]), bytes = new Uint8Array([0, 255, 128]);
    const budget = new NativeColumnBudget(15);
    expect(await decodeNativeColumn('uint32', 3, await collect(encodeNativeColumn(integers)), budget)).toEqual(integers);
    expect(await decodeNativeColumn('uint8', 3, await collect(encodeNativeColumn(bytes)), budget)).toEqual(bytes);
    expect(budget.usedBytes).toBe(15);
  });
  it('shares a cumulative allocation budget and refuses excess before reading input', async () => {
    const budget = new NativeColumnBudget(8), chunks = await collect(encodeNativeColumn(new Float64Array([1])));
    await decodeNativeColumn('float64', 1, chunks, budget);
    let read = false;
    async function* input() { read = true; yield chunks[0]!; }
    await expect(decodeNativeColumn('float64', 1, input(), budget)).rejects.toThrow('budget'); expect(read).toBe(false);
  });
  it('rejects truncation and excess, restoring the allocation budget', async () => {
    const chunks = await collect(encodeNativeColumn(new Uint8Array([1, 2, 3]))), budget = new NativeColumnBudget();
    await expect(decodeNativeColumn('uint8', 4, chunks, budget)).rejects.toThrow('truncated');
    expect(budget.usedBytes).toBe(0);
    await expect(decodeNativeColumn('uint8', 2, chunks, budget)).rejects.toThrow('excess');
    expect(budget.usedBytes).toBe(0);
  });
  it('rejects invalid element counts and supports empty columns', async () => {
    const budget = new NativeColumnBudget();
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER]) await expect(decodeNativeColumn('float64', count, [], budget)).rejects.toThrow();
    expect(await decodeNativeColumn('float64', 0, [], budget)).toEqual(new Float64Array());
    expect(() => encodeNativeColumn(new Float64Array(1), { pageBytes: 7 })).toThrow('alignment');
  });
  it('reads numeric columns through the real indexed container and rejects bad references', async () => {
    const values = new Float64Array([1, -0, Math.PI]), chunks = await collect(encodeNativeColumn(values, { pageBytes: 8 }));
    const root = (await collect(encodeNativeColumn(new Uint8Array([1]))))[0]!;
    const records = [{ descriptor: describeNativeChunk(1, 1, 1, true, root), data: root.data },
      ...chunks.map((chunk, i) => ({ descriptor: describeNativeChunk(i + 2, 2, 1, true, chunk), data: chunk.data }))];
    const parts: Uint8Array[] = [];
    const result = await writeNativeContainer({ kind: 1, root: 1 }, records, { write: async bytes => { parts.push(bytes.slice()); } });
    const bytes = new Uint8Array(result.storedBytes); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
    const budget = new NativeColumnBudget(), reader = new NativeColumnReader(opened, budget);
    expect(await reader.read('float64', 3, [2, 3, 4])).toEqual(values); expect(budget.usedBytes).toBe(24);
    await expect(reader.read('float64', 3, [2, 2, 4])).rejects.toThrow('reference');
    await expect(reader.read('uint8', 1, [1])).rejects.toThrow('reference');
    await expect(reader.read('float64', 4, [2, 3, 4])).rejects.toThrow('size');
    expect(budget.usedBytes).toBe(24);
  });
});
