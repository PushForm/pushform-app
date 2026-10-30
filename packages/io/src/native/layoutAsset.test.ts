// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { streamNativeLayoutAsset, encodeNativeLayoutAssetReference, decodeNativeLayoutAssetReference, readNativeLayoutAsset, materializeNativeLayoutAsset } from './layoutAsset';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./layoutAsset.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutAsset');
async function stored(source: string, kind: 'image' | 'archive' | 'text', pageBytes = 64 * 1024) {
  let id = 1; const chunks: NativeStoredChunk[] = [], stream = streamNativeLayoutAsset(source, kind, () => id++, { pageBytes });
  let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
  const reference = decodeNativeLayoutAssetReference(encodeNativeLayoutAssetReference(step.value)), budget = new NativeColumnBudget();
  const entries = chunks.map(chunk => ({ descriptor: chunk.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const c = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  return { reference, budget, reader, chunks };
}
it('stores canonical image/archive payloads as bounded binary chunks with exact raw bytes', async () => {
  const raw = Uint8Array.from({ length: 200003 }, (_, i) => i * 17 % 251), b64 = Buffer.from(raw).toString('base64');
  for (const kind of ['image', 'archive'] as const) {
    const source = (kind === 'image' ? 'data:image/png;base64,' : '') + b64;
    const s = await stored(source, kind), result = await readNativeLayoutAsset(s.reference, s.reader);
    expect(s.reference.encoding).toBe(1); expect(result.bytes).toEqual(raw);
    expect(s.budget.usedBytes).toBe(200003); expect(s.chunks).toHaveLength(4);
    expect(s.chunks.every(c => c.descriptor.kind === 4 && c.descriptor.decodedBytes <= 65536)).toBe(true);
    expect(materializeNativeLayoutAsset(result)).toBe(source);
    const bytes = encodeNativeLayoutAssetReference(s.reference);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  }
});
it('handles every padding length and tiny page boundaries without interior base64 padding', async () => {
  for (const length of [0, 1, 2, 3, 4, 5, 3071, 3072, 3073]) {
    const raw = Buffer.alloc(length, 253), source = raw.toString('base64'), s = await stored(source, 'archive', length < 10 ? 2 : 64);
    const asset = await readNativeLayoutAsset(s.reference, s.reader);
    expect(asset.bytes).toEqual(new Uint8Array(raw)); expect(materializeNativeLayoutAsset(asset)).toBe(source);
  }
});
it('preserves noncanonical or non-base64 authored strings exactly as UTF-16LE, including isolated surrogates', async () => {
  for (const source of ['data:image/svg+xml,%3Csvg%3E', 'data:text/plain,\ud800🙂\udfff', 'data:text/plain;name=\ud800;base64,YQ==', 'YQ', 'YR==', 'YWJ=', 'YQ==\n', '====', 'a===', 'YQ== extra']) {
    const s = await stored(source, source.startsWith('data:') ? 'image' : 'archive', 8);
    expect(s.reference.encoding).toBe(0); expect(s.reference.byteLength).toBe(source.length * 2);
    expect(materializeNativeLayoutAsset(await readNativeLayoutAsset(s.reference, s.reader))).toBe(source);
  }
});
it('owns unknown reference fields and rejects malformed payload references before allocation', async () => {
  const s = await stored('YWJj', 'archive'); s.reference.unknownFields = [new Uint8Array([0x98, 6, 7])];
  const bytes = encodeNativeLayoutAssetReference(s.reference), next = decodeNativeLayoutAssetReference(bytes); bytes.fill(0);
  expect(next.unknownFields).toEqual(s.reference.unknownFields);
  for (const patch of [{ encoding: 2 }, { chunks: [1, 1] }, { byteLength: 0 }, { encoding: 0, prefix: '' }, { prefix: 'https://bad' }]) {
    const plain = schema.toObject(schema.decode(encodeNativeLayoutAssetReference(s.reference)));
    expect(() => decodeNativeLayoutAssetReference(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
  const bad = { ...s.reference, byteLength: 4 };
  await expect(readNativeLayoutAsset(bad, s.reader)).rejects.toThrow('size mismatch'); expect(s.budget.usedBytes).toBe(0);
});
it('cancels between emitted chunks and rejects invalid chunk IDs', async () => {
  const controller = new AbortController(); let id = 1;
  const stream = streamNativeLayoutAsset('YWJj'.repeat(100), 'archive', () => id++, { pageBytes: 8, signal: controller.signal });
  expect((await stream.next()).done).toBe(false); controller.abort(); await expect(stream.next()).rejects.toThrow();
  const duplicate = streamNativeLayoutAsset('YWJj'.repeat(10), 'archive', () => 1, { pageBytes: 8 });
  await expect((async () => { while (!(await duplicate.next()).done) { /* drain */ } })()).rejects.toThrow();
});
it('keeps opaque text assets exact even when their contents resemble encoded image data', async () => {
  const source = 'data:image/png;base64,YQ==', s = await stored(source, 'text');
  expect(s.reference.encoding).toBe(0); expect(s.reference.byteLength).toBe(source.length * 2);
  expect(materializeNativeLayoutAsset(await readNativeLayoutAsset(s.reference, s.reader))).toBe(source);
});
