// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { decodeNativeLayoutGeometry, encodeNativeLayoutGeometry, streamNativeLayoutGeometry, readNativeLayoutGeometry, materializeNativeLayoutGeometry } from './layoutGeometry';
import type { LayoutGeometry, NativeLayoutGeometryReference } from './layoutGeometry';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./layoutGeometry.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutGeometry');
function fixture(): LayoutGeometry {
  return { points: [[-0, 1e12], [1, 2], [3, 4], [5, 6], [7, 8]], closed: true,
    handles: [{}, { in: undefined }, { out: undefined }, { in: [-0, 2] }, { in: [3, 4], out: [5, 6] }], contourStarts: [0, 3], openContours: [1] };
}
async function stored(value: LayoutGeometry, limit = 1024 * 1024) {
  let id = 1; const chunks: NativeStoredChunk[] = [], stream = streamNativeLayoutGeometry(value, () => id++, { pageBytes: 16 });
  let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); }
  const reference = decodeNativeLayoutGeometry(encodeNativeLayoutGeometry(step.value)), budget = new NativeColumnBudget(limit);
  const entries = chunks.map(chunk => ({ descriptor: chunk.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const chunk = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const page of decodeNativeChunks([{ codec: chunk.descriptor.codec, decodedBytes: chunk.descriptor.decodedBytes, data: chunk.data, digest: chunk.descriptor.sha256 }])) return page;
    throw new Error('missing page');
  } }, budget);
  return { reference, reader, budget, chunks };
}
it('streams exact paper geometry and sparse handles with predictable retained column bytes', async () => {
  const source = fixture(), s = await stored(source), bytes = encodeNativeLayoutGeometry(s.reference);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const packed = await readNativeLayoutGeometry(s.reference, s.reader);
  expect(materializeNativeLayoutGeometry(packed)).toEqual(source);
  expect(Object.is(packed.points[0], -0)).toBe(true); expect(Object.is(packed.handleValues![0], -0)).toBe(true);
  expect(Array.from(packed.handleFlags!)).toEqual([0, 1, 4, 2, 10]);
  expect(s.budget.usedBytes).toBe(80 + 5 + 48 + 8 + 4);
  expect(s.chunks.every(c => c.descriptor.decodedBytes <= 16)).toBe(true);
});
it('retains absent, undefined, and empty arrays independently', async () => {
  for (const state of ['absent', 'undefined', 'empty']) {
    const source: LayoutGeometry = { points: [], closed: false };
    for (const key of ['handles', 'contourStarts', 'openContours'] as const) if (state !== 'absent') {
      Object.defineProperty(source, key, { value: state === 'undefined' ? undefined : [], enumerable: true });
    }
    const s = await stored(source), next = materializeNativeLayoutGeometry(await readNativeLayoutGeometry(s.reference, s.reader));
    expect(next).toEqual(source); expect(s.budget.usedBytes).toBe(0);
    for (const key of ['handles', 'contourStarts', 'openContours'] as const) expect(Object.hasOwn(next, key)).toBe(state !== 'absent');
  }
});
it('owns and rewrites future header and column fields', async () => {
  const s = await stored(fixture()), fields = [new Uint8Array([0x98, 6, 7])];
  for (const key of ['', 'points', 'handleFlags', 'handleValues', 'contourStarts', 'openContours']) s.reference.extensions.set(key, fields);
  const bytes = encodeNativeLayoutGeometry(s.reference), next = decodeNativeLayoutGeometry(bytes); bytes.fill(0); next.closed = false;
  const rewritten = decodeNativeLayoutGeometry(encodeNativeLayoutGeometry(next));
  expect(rewritten.extensions).toEqual(s.reference.extensions); expect(rewritten.closed).toBe(false);
});
it('rejects aliased, truncated and ambiguous references before allocating geometry', async () => {
  const s = await stored(fixture()), base = schema.toObject(schema.decode(encodeNativeLayoutGeometry(s.reference)));
  expect(() => decodeNativeLayoutGeometry(new Uint8Array())).toThrow('Invalid native metadata record');
  for (const patch of [{ points: { state: 1, count: 1, chunks: [1] } }, { handleFlags: { state: 0, count: 1, chunks: [1] } },
    { handleValues: { state: 0, count: 0 } }, { handleValues: { state: 1, count: 2, chunks: [1] } },
    { points: { state: 2, count: 0 } }, { points: { count: 0 } }]) expect(() => decodeNativeLayoutGeometry(schema.encode({ ...base, ...patch }).finish())).toThrow();
  const bad: NativeLayoutGeometryReference = structuredClone(s.reference); bad.columns.points.count += 2;
  await expect(readNativeLayoutGeometry(bad, s.reader)).rejects.toThrow('size mismatch'); expect(s.budget.usedBytes).toBe(0);
  const small = await stored(fixture(), 79); await expect(readNativeLayoutGeometry(small.reference, small.reader)).rejects.toThrow('budget'); expect(small.budget.usedBytes).toBe(0);
  const controller = new AbortController(); controller.abort();
  await expect(readNativeLayoutGeometry(s.reference, s.reader, controller.signal)).rejects.toThrow(); expect(s.budget.usedBytes).toBe(0);
});
it('rejects nonfinite coordinates and malformed tuples instead of coercing them', async () => {
  for (const source of [{ ...fixture(), points: [[NaN, 0]] }, { ...fixture(), points: [[1]] },
    { ...fixture(), handles: [{ out: [Infinity, 0] }] }, { ...fixture(), handles: new Array(2) }]) {
    await expect(stored(source as LayoutGeometry)).rejects.toThrow();
  }
});
it('validates packed handle flags and value counts from untrusted columns', async () => {
  const s = await stored(fixture());
  for (const badFlags of [new Uint8Array([3, 1, 4, 2, 10]), new Uint8Array([0, 1, 4, 2, 2]), new Uint8Array([16, 1, 4, 2, 10])]) {
    const reader = { read: async (type: string, count: number) => type === 'uint8' ? badFlags : new Float64Array(count) } as unknown as NativeColumnReader;
    await expect(readNativeLayoutGeometry(s.reference, reader)).rejects.toThrow('Invalid native Layout geometry');
  }
});
