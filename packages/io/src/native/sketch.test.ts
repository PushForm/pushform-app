// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, CurveId, TagId, DefId } from '@pushform/core';
import { createSketch } from '@pushform/model';
import type { CommonAttrs, Sketch } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeSketch, readNativeSketch, encodeNativeSketchReference, decodeNativeSketchReference } from './sketch';
import type { NativeSketchReference } from './sketch';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { NativeCommonPropertyWriter, NativeCommonPropertyReader } from './commonProperty';
import { writeNativeContainer, openNativeContainer } from './container';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
function fixture(): Sketch {
  const sketch = createSketch(), common: CommonAttrs = { tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
  sketch.vertices.set(1 as Id, { id: 1 as Id, p: [0, 0, 0] }); sketch.vertices.set(2 as Id, { id: 2 as Id, p: [1, 0, 0] }); sketch.vertices.set(3 as Id, { id: 3 as Id, p: [0, 1, 0] });
  for (let i = 0; i < 3; i++) { const id = (10 + i) as Id; sketch.edges.set(id, { ...common, id, a: (i + 1) as Id, b: ((i + 1) % 3 + 1) as Id, soft: false, smooth: true, curveId: 30 as CurveId }); }
  sketch.curves.set(30 as CurveId, { id: 30 as CurveId, kind: 'freehand', center: [0, 0, 0], normal: [0, 0, 1], radius: 0, startAngle: 0, endAngle: 0, segments: 3, edgeRefs: [10, 11, 12] as Id[] });
  sketch.faces.set(20 as Id, { ...common, id: 20 as Id, plane: { n: [0, 0, 1], d: 0 }, basis: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
    loops: [[10, 11, 12].map(id => ({ edgeId: id as Id, forward: true }))], frontMaterialId: null, backMaterialId: null, uv: { kind: 'auto' } });
  return sketch;
}
async function stored(sketch = fixture()) {
  const pool = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader(); let id = 1, ref: NativeSketchReference | undefined;
  async function* records() {
    ref = yield* streamNativeSketch(sketch, attrs => pool.intern(attrs).id, () => id++, { pageBytes: 64 }, new Map([['faces', [new Uint8Array([0x98, 6, 7])]]]));
    for await (const chunk of encodeNativeChunks([encodeNativeSketchReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  for (let n = 1; n <= pool.size; n++) properties.add(pool.encodeRecord(n));
  return { opened, ref: ref!, properties };
}
describe('complete packed sketch staging', () => {
  it('loads all geometry tables and typed indexes through the real container', async () => {
    const { opened, ref, properties } = await stored(), budget = new NativeColumnBudget(482);
    const packed = await readNativeSketch(ref, new NativeColumnReader(opened, budget), properties, () => false);
    expect(budget.usedBytes).toBe(482); expect(packed.indexes.vertices.find(2)).toBe(1); expect(packed.indexes.edges.find(12)).toBe(2);
    expect([...packed.vertexSpatial.within([1, 0, 0])]).toEqual([1]);
    expect(packed.indexes.faces.find(20)).toBe(0); expect(packed.indexes.curves.find(30)).toBe(0);
    expect(packed.faces.edgeIds).toEqual(new Uint32Array([10, 11, 12])); expect(packed.extensions.get('faces')).toEqual([new Uint8Array([0x98, 6, 7])]);
    expect(decodeNativeSketchReference(encodeNativeSketchReference(ref))).toEqual(ref);
    const record = decodeNativeModelRecord(encodeNativeModelRecord({ kind: 'sketch', ownerDefinitionId: 100 as DefId, value: ref }));
    expect(record.kind).toBe('sketch'); if (record.kind === 'sketch') { expect(record.ownerDefinitionId).toBe(100); expect(record.value).toEqual(ref); }
  });
  it('rejects discontinuous/open rings, dangling curve refs and cross-table entity collisions', async () => {
    const changes: ((s: Sketch) => void)[] = [
      s => { s.edges.get(11 as Id)!.a = 1 as Id; }, s => { s.edges.get(12 as Id)!.b = 2 as Id; },
      s => { s.curves.get(30 as CurveId)!.edgeRefs = [99 as Id]; },
      s => { const face = s.faces.get(20 as Id)!; s.faces.delete(20 as Id); s.faces.set(1 as Id, { ...face, id: 1 as Id }); },
    ];
    for (const change of changes) {
      const sketch = fixture(); change(sketch); const { opened, ref, properties } = await stored(sketch);
      await expect(readNativeSketch(ref, new NativeColumnReader(opened, new NativeColumnBudget()), properties, () => false)).rejects.toThrow();
    }
  });
  it('supports empty sketches without constructing legacy Maps', async () => {
    const { opened, ref, properties } = await stored(createSketch()), budget = new NativeColumnBudget(16);
    const packed = await readNativeSketch(ref, new NativeColumnReader(opened, budget), properties, () => false);
    expect(budget.usedBytes).toBe(16); expect(packed.vertices.ids.length).toBe(0); expect(packed.indexes.vertices.has(1)).toBe(false);
  });
});
