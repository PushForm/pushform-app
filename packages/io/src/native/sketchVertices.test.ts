// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { Id } from '@pushform/core';
import type { SketchVertex } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeSketchVertices, readNativeSketchVertices, encodeNativeSketchVerticesReference, decodeNativeSketchVerticesReference } from './sketchVertices';
import type { NativeSketchVerticesReference } from './sketchVertices';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { writeNativeContainer, openNativeContainer } from './container';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
const schema = protobuf.parse(readFileSync(new URL('./sketchVertices.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.SketchVertices');
const vertices = (count: number): Map<Id, SketchVertex> => new Map(Array.from({ length: count }, (_, i) => {
  const id = (count - i) as Id; return [id, { id, p: [i, -0, i * 0.125] }] as const;
}));
describe('packed sketch vertex columns', () => {
  it('round trips IDs and exact Float64 positions through the real indexed container', async () => {
    const source = vertices(3000); let nextId = 1;
    let ref: NativeSketchVerticesReference = { count: 0, idChunks: [], positionChunks: [], unknownFields: [] };
    async function* records() {
      ref = yield* streamNativeSketchVertices(source, () => nextId++);
      for await (const chunk of encodeNativeChunks([encodeNativeSketchVerticesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
    }
    const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
    const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
    const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
    const budget = new NativeColumnBudget(84_000), packed = await readNativeSketchVertices(ref, new NativeColumnReader(opened, budget));
    expect(budget.usedBytes).toBe(84_000); expect(packed.ids).toEqual(Uint32Array.from(source.keys()));
    let row = 0; for (const vertex of source.values()) {
      expect(Array.from(packed.positions.subarray(row * 3, row * 3 + 3))).toEqual(vertex.p); row++;
    }
    expect(ref.idChunks).toHaveLength(1); expect(ref.positionChunks).toHaveLength(2);
    const metadata = encodeNativeSketchVerticesReference(ref); expect(decodeNativeSketchVerticesReference(metadata)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(metadata)).finish())).toEqual(Array.from(metadata));
  });
  it('converts only the demanded page and closes source iteration on cancellation', async () => {
    const map = vertices(100), original = map[Symbol.iterator].bind(map); let reads = 0, closed = false;
    map[Symbol.iterator] = function* () { try { for (const entry of original()) { reads++; yield entry; } } finally { closed = true; } return undefined; };
    const stream = streamNativeSketchVertices(map, () => 1, { pageBytes: 32 });
    await stream.next(); expect(reads).toBe(8);
    await stream.return({ count: 0, idChunks: [], positionChunks: [], unknownFields: [] }); expect(reads).toBe(8); expect(closed).toBe(true);
  });
  it('rejects invalid source geometry and conflicting references and handles empty geometry', async () => {
    const source = vertices(1); source.get(1 as Id)!.p = [0, Infinity, 0];
    const stream = streamNativeSketchVertices(source, () => 1); await stream.next(); await expect(stream.next()).rejects.toThrow();
    source.get(1 as Id)!.id = 2 as Id; await expect(streamNativeSketchVertices(source, () => 1).next()).rejects.toThrow();
    expect(() => encodeNativeSketchVerticesReference({ count: 1, idChunks: [1], positionChunks: [1], unknownFields: [] })).toThrow();
    const empty = await streamNativeSketchVertices(new Map(), () => 1).next(); expect(empty.done).toBe(true);
    expect(empty.value).toEqual({ count: 0, idChunks: [], positionChunks: [], unknownFields: [] });
  });
  it('validates unique IDs with accounted numeric scratch and leaves source order unchanged', () => {
    const budget = new NativeColumnBudget(12), reader = new NativeColumnReader({ entries: [], read: async () => new Uint8Array() }, budget);
    const ids = new Uint32Array([9, 1, 5]); reader.validateUniqueIds(ids); expect(ids).toEqual(new Uint32Array([9, 1, 5])); expect(budget.usedBytes).toBe(0);
    expect(() => reader.validateUniqueIds(new Uint32Array([1, 1]))).toThrow('Duplicate'); expect(budget.usedBytes).toBe(0);
    expect(() => reader.validateUniqueIds(new Uint32Array(4))).toThrow('budget'); expect(budget.usedBytes).toBe(0);
  });
});
