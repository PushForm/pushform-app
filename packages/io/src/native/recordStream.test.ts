// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { decodeNativeRecordChunks, encodeNativeRecordChunks, packNativeRecords, unpackNativeRecords } from './recordStream';
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
describe('bounded Protobuf-delimited record streams', () => {
  it('round trips large records spanning chunks and coalesces tiny records', async () => {
    const records = [0, 1, 127, 128, 65535, 65536, 250000].map(n => new Uint8Array(n).map((_, i) => i % 251));
    const chunks = await collect(encodeNativeRecordChunks(records));
    expect(await collect(decodeNativeRecordChunks(chunks))).toEqual(records);
    expect(chunks.length).toBe(6);
    expect((await collect(encodeNativeRecordChunks(Array.from({ length: 100 }, () => new Uint8Array([1]))))).length).toBe(1);
  });
  it('handles length prefixes split across pages and owns assembled records', async () => {
    const records = [new Uint8Array([1]), new Uint8Array(128).fill(7)];
    const pages = await collect(packNativeRecords(records, { pageBytes: 3 }));
    const decoded = await collect(unpackNativeRecords(pages)); for (const page of pages) page.fill(0);
    expect(decoded).toEqual(records);
  });
  it('rejects truncated prefixes, truncated payloads and oversized records before allocation', async () => {
    for (const bytes of [[128], [2, 1], [255, 255, 255, 127]])
      await expect(collect(unpackNativeRecords([new Uint8Array(bytes)]))).rejects.toThrow();
    await expect(collect(packNativeRecords([new Uint8Array(1024 * 1024 + 1)]))).rejects.toThrow();
  });
  it('stops pulling records when the consumer stops and honors cancellation', async () => {
    let produced = 0;
    function* records() { for (let i = 0; i < 10; i++) { produced++; yield new Uint8Array(32); } }
    const stream = packNativeRecords(records(), { pageBytes: 8 }); await stream.next(); expect(produced).toBe(1);
    await stream.return(undefined); expect(produced).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(collect(unpackNativeRecords([new Uint8Array([0])], abort.signal))).rejects.toThrow();
  });
});
