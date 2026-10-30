// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { FaceLocalId, MaterialId, TagId, SurfaceId } from '@pushform/core';
import type { FaceRecord } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeBodyFaces, readNativeBodyFaces, encodeNativeBodyFacesReference, decodeNativeBodyFacesReference } from './bodyFaces';
import type { NativeBodyFacesReference } from './bodyFaces';
import { nativeFaceUvAt } from './faceUv';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.loadSync(fileURLToPath(new URL('./bodyFaces.proto', import.meta.url))).resolveAll().lookupType('pushform.native.BodyFaces');
function fixture(): Map<FaceLocalId, FaceRecord> {
  return new Map(Array.from({ length: 16 }, (_, flag) => {
    const id = flag as FaceLocalId;
    const face: FaceRecord = { id, plane: { n: [0, 0, 1], d: -0 }, basis: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
      frontMaterialId: flag & 1 ? 0 as MaterialId : null, backMaterialId: flag & 2 ? 0 as MaterialId : null, hidden: !!(flag & 4), surfaceId: flag & 8 ? 0 as SurfaceId : null,
      tagId: 0 as TagId, uv: { kind: 'auto' }, ...(flag & 1 ? { uvBack: undefined } : {}),
      loops: [[[0, -0, 0], [1, 0, 0], [0, 1, 0]], [[0.1, 0.1, 0], [0.1, 0.2, 0], [0.2, 0.1, 0]]] };
    return [id, face];
  }));
}
async function stored(faces = fixture()) {
  let id = 1, ref: NativeBodyFacesReference | undefined;
  async function* records() {
    ref = yield* streamNativeBodyFaces(faces, () => id++, { pageBytes: 64 });
    for await (const chunk of encodeNativeChunks([encodeNativeBodyFacesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { faces, opened, ref: ref! };
}
describe('packed body face decoration', () => {
  it('preserves all presence flags, holes, exact boundary points and UV presence', async () => {
    const { opened, ref, faces } = await stored(), budget = new NativeColumnBudget(5052);
    const table = await readNativeBodyFaces(ref, new NativeColumnReader(opened, budget), id => id === 0, id => id === 0, id => id === 0);
    expect(budget.usedBytes).toBe(5052); expect(table.flags).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
    let row = 0; for (const face of faces.values()) {
      expect(table.ids[row]).toBe(face.id); expect(Array.from(table.properties.subarray(row * 4, row * 4 + 4))).toEqual([0, 0, 0, 0]);
      expect(Array.from(table.geometry.subarray(row * 16, row * 16 + 16))).toEqual([...face.plane.n, face.plane.d, ...face.basis.origin, ...face.basis.u, ...face.basis.v, ...face.basis.n]);
      expect(table.faceOffsets[row + 1]! - table.faceOffsets[row]!).toBe(2);
      for (let loop = 0; loop < 2; loop++) {
        const index = table.faceOffsets[row]! + loop, start = table.loopOffsets[index]!, end = table.loopOffsets[index + 1]!;
        expect(Array.from(table.positions.subarray(start * 3, end * 3))).toEqual(face.loops[loop]!.flat());
      }
      expect(Object.hasOwn(nativeFaceUvAt(table.uv, row), 'uvBack')).toBe(Object.hasOwn(face, 'uvBack')); row++;
    }
    const bytes = encodeNativeBodyFacesReference(ref); expect(decodeNativeBodyFacesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); expect(decodeNativeBodyFacesReference(encodeNativeBodyFacesReference(ref))).toEqual(ref);
  });
  it('rejects missing material, tag and surface references', async () => {
    const { opened, ref } = await stored();
    for (const missing of [0, 1, 2]) await expect(readNativeBodyFaces(ref, new NativeColumnReader(opened, new NativeColumnBudget()),
      () => missing !== 0, () => missing !== 1, () => missing !== 2)).rejects.toThrow();
  });
  it('rejects malformed decoded ranges, flags and nonfinite boundary coordinates', async () => {
    const { opened, ref } = await stored();
    for (const column of ['faceOffsets', 'flags', 'positions'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry);
        if (entry.descriptor.id === ref.columns[column][0]) {
          if (column === 'flags') bytes[0] = 16;
          else if (column === 'positions') new DataView(bytes.buffer, bytes.byteOffset).setFloat64(0, NaN, true);
          else new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 0, true);
        } return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeBodyFaces(ref, reader, () => true, () => true, () => true)).rejects.toThrow();
    }
  });
  it('supports an empty decoration table without claiming it is a valid body', async () => {
    const { opened, ref } = await stored(new Map()), budget = new NativeColumnBudget(12);
    const table = await readNativeBodyFaces(ref, new NativeColumnReader(opened, budget), () => false, () => false, () => false);
    expect(table.ids.length).toBe(0); expect(table.positions.length).toBe(0); expect(budget.usedBytes).toBe(12);
  });
});
