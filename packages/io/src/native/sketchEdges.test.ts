// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { Id, TagId, CurveId } from '@pushform/core';
import type { SketchEdge } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeSketchEdges, readNativeSketchEdges, encodeNativeSketchEdgesReference, decodeNativeSketchEdgesReference } from './sketchEdges';
import type { NativeSketchEdgesReference } from './sketchEdges';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { NativeCommonPropertyWriter, NativeCommonPropertyReader } from './commonProperty';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./sketchEdges.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.SketchEdges');
function fixture(count: number): Map<Id, SketchEdge> {
  return new Map(Array.from({ length: count }, (_, i) => {
    const id = (100 + i) as Id;
    return [id, { id, a: 1 as Id, b: 2 as Id, soft: !!(i & 1), smooth: !!(i & 2), curveId: i & 4 ? 0 as CurveId : null,
      tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} }] as const;
  }));
}
async function stored(edges: Map<Id, SketchEdge>) {
  const writer = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader(); let id = 1;
  let ref: NativeSketchEdgesReference = { count: 0, idChunks: [], rowChunks: [], flagChunks: [], unknownFields: [] };
  async function* records() {
    ref = yield* streamNativeSketchEdges(edges, edge => writer.intern(edge).id, () => id++, { pageBytes: 32 });
    for await (const chunk of encodeNativeChunks([encodeNativeSketchEdgesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  for (let n = 1; n <= writer.size; n++) properties.add(writer.encodeRecord(n));
  return { opened, ref, properties, writer };
}
describe('packed sketch edge columns', () => {
  it('restores exact topology, all flags and curve-zero presence while sharing common properties', async () => {
    const edges = fixture(32), { opened, ref, properties, writer } = await stored(edges), budget = new NativeColumnBudget(32 * 21);
    const packed = await readNativeSketchEdges(ref, new NativeColumnReader(opened, budget), properties, id => id === 1 || id === 2, id => id === 0);
    expect(budget.usedBytes).toBe(672); expect(writer.size).toBe(1);
    let i = 0; for (const edge of edges.values()) {
      expect(packed.ids[i]).toBe(edge.id); expect(Array.from(packed.rows.subarray(i * 4, i * 4 + 4))).toEqual([edge.a, edge.b, 1, edge.curveId ?? 0]);
      expect(packed.flags[i]).toBe(Number(edge.soft) | (Number(edge.smooth) << 1) | (edge.curveId !== null ? 4 : 0)); i++;
    }
    const bytes = encodeNativeSketchEdgesReference(ref); expect(decodeNativeSketchEdgesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  });
  it('rejects dangling vertex, curve and property references', async () => {
    const { opened, ref, properties } = await stored(fixture(8));
    const reader = () => new NativeColumnReader(opened, new NativeColumnBudget());
    await expect(readNativeSketchEdges(ref, reader(), properties, () => false, () => true)).rejects.toThrow();
    await expect(readNativeSketchEdges(ref, reader(), properties, () => true, () => false)).rejects.toThrow();
    await expect(readNativeSketchEdges(ref, reader(), new NativeCommonPropertyReader(), () => true, () => true)).rejects.toThrow();
  });
  it('bounds traversal, invokes property interning only in its column and cancels the iterator', async () => {
    const map = fixture(100), original = map[Symbol.iterator].bind(map); let reads = 0, calls = 0, closed = false;
    map[Symbol.iterator] = function* () { try { for (const entry of original()) { reads++; yield entry; } } finally { closed = true; } return undefined; };
    let id = 1; const stream = streamNativeSketchEdges(map, () => { calls++; return 1; }, () => id++, { pageBytes: 32 });
    await stream.next(); expect(reads).toBe(8); expect(calls).toBe(0);
    await stream.return({ count: 0, idChunks: [], rowChunks: [], flagChunks: [], unknownFields: [] }); expect(closed).toBe(true); expect(reads).toBe(8);
  });
  it('rejects invalid IDs and property assignments and handles empty tables', async () => {
    const stream = streamNativeSketchEdges(fixture(1), () => 0, () => 1); await stream.next(); await expect(stream.next()).rejects.toThrow();
    const bad = fixture(1); bad.get(100 as Id)!.a = -1 as Id;
    const invalid = streamNativeSketchEdges(bad, () => 1, () => 1); await invalid.next(); await expect(invalid.next()).rejects.toThrow();
    expect((await streamNativeSketchEdges(new Map(), () => 1, () => 1).next()).value).toEqual({ count: 0, idChunks: [], rowChunks: [], flagChunks: [], unknownFields: [] });
  });
});
