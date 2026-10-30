// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { Id, TagId, MaterialId } from '@pushform/core';
import type { SketchFace } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeSketchFaces, readNativeSketchFaces, encodeNativeSketchFacesReference, decodeNativeSketchFacesReference } from './sketchFaces';
import type { NativeSketchFacesReference } from './sketchFaces';
import { nativeFaceUvAt } from './faceUv';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { NativeCommonPropertyWriter, NativeCommonPropertyReader } from './commonProperty';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.loadSync(fileURLToPath(new URL('./sketchFaces.proto', import.meta.url))).resolveAll().lookupType('pushform.native.SketchFaces');
function fixture(): Map<Id, SketchFace> {
  const face: SketchFace = { id: 100 as Id, plane: { n: [0, 0, 1], d: -0 }, basis: { origin: [1e10, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
    tagId: 1 as TagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
    frontMaterialId: null, backMaterialId: 0 as MaterialId, uv: { kind: 'auto' },
    loops: [[1, 2, 3].map(id => ({ edgeId: id as Id, forward: true })), [4, 5, 6].map(id => ({ edgeId: id as Id, forward: false }))] };
  return new Map([[face.id, face], [200 as Id, { ...face, id: 200 as Id, frontMaterialId: 7 as MaterialId, backMaterialId: null, uvBack: undefined,
    loops: [[7, 8, 9].map(id => ({ edgeId: id as Id, forward: id !== 8 }))] }]]);
}
async function stored(faces = fixture()) {
  const pool = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader(); let id = 1, ref: NativeSketchFacesReference | undefined;
  async function* records() {
    ref = yield* streamNativeSketchFaces(faces, face => pool.intern(face).id, () => id++, { pageBytes: 64 });
    for await (const chunk of encodeNativeChunks([encodeNativeSketchFacesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  for (let n = 1; n <= pool.size; n++) properties.add(pool.encodeRecord(n));
  return { faces, opened, ref: ref!, properties, pool };
}
describe('packed sketch faces', () => {
  it('preserves holes, oriented references, material presence and exact geometry without face objects', async () => {
    const { faces, opened, ref, properties, pool } = await stored(), budget = new NativeColumnBudget(387);
    const table = await readNativeSketchFaces(ref, new NativeColumnReader(opened, budget), properties, id => id >= 1 && id <= 9, id => id === 0 || id === 7);
    expect(budget.usedBytes).toBe(387); expect(pool.size).toBe(1);
    expect(table.ids).toEqual(new Uint32Array([100, 200])); expect(table.faceOffsets).toEqual(new Uint32Array([0, 2, 3]));
    expect(table.loopOffsets).toEqual(new Uint32Array([0, 3, 6, 9])); expect(table.edgeIds).toEqual(new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(table.forward).toEqual(new Uint8Array([1, 1, 1, 0, 0, 0, 1, 0, 1])); expect(table.materialFlags).toEqual(new Uint8Array([2, 1]));
    expect(table.properties).toEqual(new Uint32Array([1, 0, 0, 1, 7, 0]));
    let row = 0; for (const face of faces.values()) {
      expect(Array.from(table.geometry.subarray(row * 16, row * 16 + 16))).toEqual([...face.plane.n, face.plane.d, ...face.basis.origin, ...face.basis.u, ...face.basis.v, ...face.basis.n]);
      const uv = nativeFaceUvAt(table.uv, row++); expect(uv.uv).toEqual(face.uv); expect(Object.hasOwn(uv, 'uvBack')).toBe(Object.hasOwn(face, 'uvBack'));
    }
    const bytes = encodeNativeSketchFacesReference(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); ref.uv.unknownFields.push(new Uint8Array([0x98, 6, 8]));
    expect(decodeNativeSketchFacesReference(encodeNativeSketchFacesReference(ref))).toEqual(ref);
  });
  it('rejects dangling edge, material and property references', async () => {
    const { opened, ref, properties } = await stored(), reader = () => new NativeColumnReader(opened, new NativeColumnBudget());
    await expect(readNativeSketchFaces(ref, reader(), properties, () => false, () => true)).rejects.toThrow();
    await expect(readNativeSketchFaces(ref, reader(), properties, () => true, () => false)).rejects.toThrow();
    await expect(readNativeSketchFaces(ref, reader(), new NativeCommonPropertyReader(), () => true, () => true)).rejects.toThrow();
  });
  it('rejects malformed decoded ranges, flags, geometry and duplicate face IDs', async () => {
    const { opened, ref, properties } = await stored();
    for (const [column, mutate] of [
      ['faceOffsets', (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 3, true)],
      ['materialFlags', (bytes: Uint8Array) => { bytes[0] = 4; }],
      ['forward', (bytes: Uint8Array) => { bytes[0] = 2; }],
      ['geometry', (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).setFloat64(0, NaN, true)],
      ['ids', (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 100, true)],
    ] as const) {
      // Supply malformed decoded content to isolate structural checks from container hashing.
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry); if (entry.descriptor.id === ref.columns[column][0]) mutate(bytes); return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeSketchFaces(ref, reader, properties, () => true, () => true)).rejects.toThrow();
    }
  });
  it('rejects empty face boundaries before emitting any chunks', async () => {
    const faces = fixture(); faces.get(100 as Id)!.loops = [[]];
    await expect(streamNativeSketchFaces(faces, () => 1, () => 1).next()).rejects.toThrow();
  });
  it('represents an empty face table using only three zero offset sentinels', async () => {
    const { opened, ref, properties } = await stored(new Map()), budget = new NativeColumnBudget(12);
    const table = await readNativeSketchFaces(ref, new NativeColumnReader(opened, budget), properties, () => false, () => false);
    expect(table.ids.length).toBe(0); expect(table.geometry.length).toBe(0); expect(table.edgeIds.length).toBe(0);
    expect(table.faceOffsets).toEqual(new Uint32Array([0])); expect(table.loopOffsets).toEqual(new Uint32Array([0]));
    expect(table.uv.offsets).toEqual(new Uint32Array([0])); expect(budget.usedBytes).toBe(12);
  });
});
