// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { CurveId } from '@pushform/core';
import type { ImprintGraph } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeImprint, readNativeImprint, encodeNativeImprintReference, decodeNativeImprintReference } from './imprint';
import type { NativeImprintReference } from './imprint';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { openNativeContainer, writeNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./imprint.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.Imprint');
function fixture(): ImprintGraph {
  return { nextId: 40, version: 2 ** 40, vertices: new Map([[3, [-0, 1e12]], [1, [1.123456789, -4]]]),
    edges: new Map(Array.from({ length: 16 }, (_, flags) => {
      const id = 30 - flags; return [id, { id, a: flags % 2 ? 1 : 3, b: flags % 2 ? 3 : 1,
        soft: !!(flags & 1), smooth: !!(flags & 2), hidden: !!(flags & 4), curveId: flags & 8 ? 0 as CurveId : null }];
    })) };
}
async function stored(graph = fixture()) {
  let id = 1, ref: NativeImprintReference | undefined;
  async function* chunks() {
    ref = yield* streamNativeImprint(7, graph, () => id++, { pageBytes: 32 });
    for await (const chunk of encodeNativeChunks([encodeNativeImprintReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, chunks(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { opened, ref: ref! };
}
describe('packed face imprint', () => {
  it('preserves every flag, null versus zero curves, source order, precision and allocator state', async () => {
    const source = fixture(), { opened, ref } = await stored(source), budget = new NativeColumnBudget(384);
    const packed = await readNativeImprint(ref, new NativeColumnReader(opened, budget), id => id === 7, id => id === 0);
    expect(budget.usedBytes).toBe(384); expect(packed.version).toBe(2 ** 40); expect(packed.nextId).toBe(40);
    expect(Array.from(packed.vertexIds)).toEqual([...source.vertices.keys()]);
    expect(Array.from(packed.positions)).toEqual([...source.vertices.values()].flat());
    let row = 0;
    for (const [id, edge] of source.edges) {
      expect(packed.edgeIndex.find(id)).toBe(row); expect(packed.edgeIds[row]).toBe(id);
      expect(Array.from(packed.endpoints.subarray(row * 2, row * 2 + 2))).toEqual([edge.a, edge.b]);
      expect(packed.flags[row]).toBe(row); expect(packed.curves[row]).toBe(0); row++;
    }
    expect(packed.vertexIndex.find(3)).toBe(0);
    const bytes = encodeNativeImprintReference(ref); expect(decodeNativeImprintReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); expect(decodeNativeImprintReference(encodeNativeImprintReference(ref))).toEqual(ref);
    await expect(readNativeImprint(ref, new NativeColumnReader(opened, new NativeColumnBudget()), () => false, () => true)).rejects.toThrow();
    await expect(readNativeImprint(ref, new NativeColumnReader(opened, new NativeColumnBudget()), () => true, () => false)).rejects.toThrow();
  });
  it('rejects bad IDs, endpoints, flags, null encodings and nonfinite coordinates', async () => {
    const { opened, ref } = await stored();
    for (const name of ['vertexIds', 'edgeIds', 'endpoints', 'flags', 'curves', 'positions'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry);
        if (entry.descriptor.id === ref.columns[name][0]) {
          const view = new DataView(bytes.buffer, bytes.byteOffset);
          if (name === 'flags') bytes[0] = 16;
          else if (name === 'positions') view.setFloat64(0, NaN, true);
          else view.setUint32(0, name === 'vertexIds' ? 1 : name === 'edgeIds' ? 3 : 39, true);
        }
        return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeImprint(ref, reader, () => true, () => true)).rejects.toThrow();
    }
    await expect(readNativeImprint({ ...ref, nextId: 30 }, new NativeColumnReader(opened, new NativeColumnBudget()), () => true, () => true)).rejects.toThrow();
  });
  it('supports empty graphs and rejects dangling source edges', async () => {
    const { opened, ref } = await stored({ nextId: 1, version: 0, vertices: new Map(), edges: new Map() }), budget = new NativeColumnBudget(0);
    const packed = await readNativeImprint(ref, new NativeColumnReader(opened, budget), () => true, () => false);
    expect(packed.vertexIds.length).toBe(0); expect(packed.edgeIds.length).toBe(0); expect(budget.usedBytes).toBe(0);
    const graph = fixture(); graph.edges.get(30)!.a = 99; await expect(stored(graph)).rejects.toThrow();
  });
});
