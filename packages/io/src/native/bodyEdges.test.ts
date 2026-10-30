// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { FaceLocalId, TagId, CurveId } from '@pushform/core';
import type { EdgeKey, EdgeRecord } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeBodyEdges, readNativeBodyEdges, encodeNativeBodyEdgesReference, decodeNativeBodyEdgesReference } from './bodyEdges';
import type { NativeBodyEdgesReference } from './bodyEdges';
import { NativeEdgeIndex, parseNativeEdgeKey } from './edgeKey';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./bodyEdges.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.BodyEdges');
function fixture(): Map<EdgeKey, EdgeRecord> {
  return new Map(Array.from({ length: 16 }, (_, flag) => {
    const key: EdgeKey = `0:1:${15 - flag}`;
    return [key, { key, faceA: 0 as FaceLocalId, faceB: 1 as FaceLocalId, tagId: 0 as TagId, curveId: flag & 8 ? 0 as CurveId : null,
      soft: !!(flag & 1), smooth: !!(flag & 2), hidden: !!(flag & 4), polyline: [[0, -0, 0], [1e12, flag, 0.25]] }];
  }));
}
async function stored(edges = fixture()) {
  let id = 1, ref: NativeBodyEdgesReference | undefined;
  async function* records() {
    ref = yield* streamNativeBodyEdges(edges, () => id++, { pageBytes: 64 });
    for await (const chunk of encodeNativeChunks([encodeNativeBodyEdgesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { edges, opened, ref: ref! };
}
describe('packed body edges and numeric keys', () => {
  it('preserves every flag combination, key run and exact polyline with a compact lookup index', async () => {
    const { opened, ref, edges } = await stored(), budget = new NativeColumnBudget(1236);
    const table = await readNativeBodyEdges(ref, new NativeColumnReader(opened, budget), id => id === 0 || id === 1, id => id === 0, id => id === 0);
    expect(budget.usedBytes).toBe(1236); expect(table.flags).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
    let row = 0; for (const edge of edges.values()) {
      const [a, b, run] = parseNativeEdgeKey(edge.key); expect(table.index.find(a, b, run)).toBe(row);
      expect(Array.from(table.rows.subarray(row * 5, row * 5 + 5))).toEqual([a, b, run, 0, 0]);
      expect(Array.from(table.positions.subarray(table.offsets[row]! * 3, table.offsets[row + 1]! * 3))).toEqual(edge.polyline.flat()); row++;
    }
    const bytes = encodeNativeBodyEdgesReference(ref); expect(decodeNativeBodyEdgesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); expect(decodeNativeBodyEdgesReference(encodeNativeBodyEdgesReference(ref))).toEqual(ref);
  });
  it('rejects missing faces, tags and curves and supports empty edge tables', async () => {
    const { opened, ref } = await stored();
    for (const missing of [0, 1, 2]) await expect(readNativeBodyEdges(ref, new NativeColumnReader(opened, new NativeColumnBudget()),
      () => missing !== 0, () => missing !== 1, () => missing !== 2)).rejects.toThrow();
    const empty = await stored(new Map()), budget = new NativeColumnBudget(4);
    const table = await readNativeBodyEdges(empty.ref, new NativeColumnReader(empty.opened, budget), () => false, () => false, () => false);
    expect(table.offsets).toEqual(new Uint32Array([0])); expect(table.index.find(0, 1, 0)).toBe(-1); expect(budget.usedBytes).toBe(4);
  });
  it('rejects malformed keys, duplicate numeric keys and inconsistent face pairs', async () => {
    for (const key of ['1:0:0', '01:2:0', '0:0:0', '0:1:-1', '0:1:4294967296', '0:1:1.0', '0:1:1e2']) expect(() => parseNativeEdgeKey(key as EdgeKey)).toThrow();
    expect(parseNativeEdgeKey('4294967294:4294967295:4294967295')).toEqual([4294967294, 4294967295, 4294967295]);
    const budget = new NativeColumnBudget(8); expect(() => new NativeEdgeIndex(new Uint32Array([0, 1, 0, 0, 0, 0, 1, 0, 0, 0]), budget)).toThrow('Duplicate'); expect(budget.usedBytes).toBe(0);
    expect(() => new NativeEdgeIndex(new Uint32Array([1, 0, 0, 0, 0]), budget)).toThrow(); expect(budget.usedBytes).toBe(0);
    const edges = fixture(); edges.get('0:1:15')!.faceB = 2 as FaceLocalId; await expect(stored(edges)).rejects.toThrow();
  });
  it('rejects malformed decoded flags, short polyline ranges and nonfinite positions', async () => {
    const { opened, ref } = await stored();
    for (const column of ['flags', 'offsets', 'positions'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry); if (entry.descriptor.id === ref.columns[column][0]) {
          if (column === 'flags') bytes[0] = 16;
          else if (column === 'offsets') new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 1, true);
          else new DataView(bytes.buffer, bytes.byteOffset).setFloat64(0, NaN, true);
        } return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeBodyEdges(ref, reader, () => true, () => true, () => true)).rejects.toThrow();
    }
  });
});
