// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import type { CurveId, FaceLocalId, Id, SurfaceId, TagId } from '@pushform/core';
import { bodyFromMesh, createDocument, createSketch } from '@pushform/model';
import { streamPackedBody, streamPackedSketch } from './packedGeometryWriter';
import { streamNativeBody, readNativeBody } from './body';
import { streamNativeSketch, readNativeSketch } from './sketch';
import { NativeCommonPropertyReader, NativeCommonPropertyWriter } from './commonProperty';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { decodeNativeChunks } from './chunks';
import { nativeBodyState, nativeSketchState } from './modelState';
import type { NativeStoredChunk } from './container';
async function store<T>(generator: AsyncGenerator<NativeStoredChunk, T>) {
  const chunks: NativeStoredChunk[] = []; let ref: T;
  for (;;) { const item = await generator.next(); if (item.done) { ref = item.value; break; } chunks.push(item.value); }
  const entries = chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const chunk = chunks.find(c => c.descriptor.id === entry.descriptor.id)!;
    const parts = []; for await (const bytes of decodeNativeChunks([{ ...chunk.descriptor, digest: chunk.descriptor.sha256, data: chunk.data }])) parts.push(bytes);
    return parts[0]!;
  } }, new NativeColumnBudget());
  return { ref, reader, chunks };
}
describe('direct packed geometry writing', () => {
  it('rewrites vertex/edge/face/curve columns and unknown fields with fresh chunk IDs', async () => {
    const source = createSketch(), pool = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader();
    const attrs = { tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    for (const [i, p] of [[0, 0, 0], [1, 0, 0], [0, 1, 0]].entries()) source.vertices.set((i + 1) as Id, { id: (i + 1) as Id, p: p as [number, number, number] });
    for (let i = 0; i < 3; i++) source.edges.set((10 + i) as Id, { ...attrs, id: (10 + i) as Id, a: (i + 1) as Id, b: ((i + 1) % 3 + 1) as Id, soft: false, smooth: true, curveId: 0 as CurveId });
    source.curves.set(0 as CurveId, { id: 0 as CurveId, kind: 'freehand', center: [0, 0, 0], normal: [0, 0, 1], radius: 0, startAngle: -0, endAngle: 0, segments: 3, edgeRefs: [10, 11, 12] as Id[] });
    source.faces.set(20 as Id, { ...attrs, id: 20 as Id, plane: { n: [0, 0, 1], d: 0 }, basis: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
      loops: [[10, 11, 12].map(edgeId => ({ edgeId: edgeId as Id, forward: true }))], frontMaterialId: null, backMaterialId: null, uv: { kind: 'auto' }, uvBack: undefined });
    let id = 1; const first = await store(streamNativeSketch(source, attrs => pool.intern(attrs).id, () => id++, {}, new Map([['faces.uv', [new Uint8Array([0x98, 6, 7])]]])));
    properties.add(pool.encodeRecord(1)); const packed = await readNativeSketch(first.ref, first.reader, properties, () => false);
    id = 1000; const rewritten = await store(streamPackedSketch(packed, () => id++, { pageBytes: 32 }));
    expect(rewritten.chunks.every(c => c.descriptor.id >= 1000)).toBe(true);
    const reopened = await readNativeSketch(rewritten.ref, rewritten.reader, properties, () => false);
    const editable = nativeSketchState(reopened, properties);
    const { packedVertexIndex: _index, ...editableFields } = editable;
    expect({ ...editableFields, vertexHash: new Map() }).toEqual({ ...source, nativeUnknownFields: { extensions: packed.extensions } });
    expect(reopened).toEqual(packed); expect([...reopened.vertexSpatial.within([1, 0, 0])]).toEqual([1]);
  });
  it('rewrites body decorations including curves, surfaces and imprints without object reconstruction', async () => {
    const doc = createDocument(); const body = doc.transact('body', d => {
      const b = bodyFromMesh(d, meshBox([0, 0, 0], [1, 2, 3]));
      const key = b.edges.keys().next().value!, face = b.faces.keys().next().value!;
      b.curves.set(0 as CurveId, { id: 0 as CurveId, kind: 'freehand', center: [0, 0, 0], normal: [0, 0, 1], radius: 0, startAngle: 0, endAngle: 0, segments: 1, edgeRefs: [key] }); b.edges.get(key)!.curveId = 0 as CurveId;
      b.surfaces.set(0 as SurfaceId, { id: 0 as SurfaceId, faceIds: [face], curveId: 0 as CurveId }); b.faces.get(face)!.surfaceId = 0 as SurfaceId;
      b.imprints.set(face as FaceLocalId, { nextId: 4, version: 2, vertices: new Map([[1, [-0, 0]], [2, [1, 1]]]), edges: new Map([[3, { id: 3, a: 1, b: 2, soft: true, smooth: false, hidden: false, curveId: null }]]) }); return b;
    }).value;
    const pool = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader(); let id = 1;
    const first = await store(streamNativeBody(body, attrs => pool.intern(attrs).id, () => id++, {}, new Map([['surfaces', [new Uint8Array([0x98, 6, 7])]]]))); properties.add(pool.encodeRecord(1));
    const packed = await readNativeBody(first.ref, first.reader, properties, () => true, () => true);
    id = 1000; const rewritten = await store(streamPackedBody(packed, 1, () => id++, { pageBytes: 32 }));
    const reopened = await readNativeBody(rewritten.ref, rewritten.reader, properties, () => true, () => true);
    expect(nativeBodyState(reopened)).toEqual({ ...body, nativeUnknownFields: { extensions: packed.extensions } });
    expect(reopened).toEqual(packed); expect(rewritten.ref.mesh.vertexChunks[0]).toBeGreaterThanOrEqual(1000);
  });
});
