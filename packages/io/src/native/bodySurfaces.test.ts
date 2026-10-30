// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { CurveId, FaceLocalId, SurfaceId } from '@pushform/core';
import type { SurfaceRecord } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeBodySurfaces, readNativeBodySurfaces, encodeNativeBodySurfacesReference, decodeNativeBodySurfacesReference } from './bodySurfaces';
import type { NativeBodySurfacesReference } from './bodySurfaces';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { openNativeContainer, writeNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./bodySurfaces.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.BodySurfaces');
function fixture(): Map<SurfaceId, SurfaceRecord> {
  return new Map([2, 0, 1].map((id, row) => [id as SurfaceId, { id: id as SurfaceId,
    curveId: row === 0 ? null : (row - 1) as CurveId, faceIds: (row === 2 ? [] : [3, 1, 3]) as FaceLocalId[] }]));
}
async function stored(surfaces = fixture()) {
  let id = 1, ref: NativeBodySurfacesReference | undefined;
  async function* chunks() {
    ref = yield* streamNativeBodySurfaces(surfaces, () => id++, { pageBytes: 32 });
    for await (const chunk of encodeNativeChunks([encodeNativeBodySurfacesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, chunks(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { opened, ref: ref! };
}
describe('packed body surfaces', () => {
  it('preserves order, repeated face IDs, empty groups and null versus zero curve IDs', async () => {
    const { opened, ref } = await stored(), budget = new NativeColumnBudget(67);
    const packed = await readNativeBodySurfaces(ref, new NativeColumnReader(opened, budget), id => id === 1 || id === 3, id => id < 2);
    expect(budget.usedBytes).toBe(67);
    expect(packed).toEqual({ ids: new Uint32Array([2, 0, 1]), curves: new Uint32Array([0, 0, 1]), flags: new Uint8Array([0, 1, 1]),
      offsets: new Uint32Array([0, 3, 6, 6]), faces: new Uint32Array([3, 1, 3, 3, 1, 3]) });
    const bytes = encodeNativeBodySurfacesReference(ref);
    expect(decodeNativeBodySurfacesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7]));
    expect(decodeNativeBodySurfacesReference(encodeNativeBodySurfacesReference(ref))).toEqual(ref);
    await expect(readNativeBodySurfaces(ref, new NativeColumnReader(opened, new NativeColumnBudget()), () => false, () => true)).rejects.toThrow();
    await expect(readNativeBodySurfaces(ref, new NativeColumnReader(opened, new NativeColumnBudget()), () => true, () => false)).rejects.toThrow();
  });
  it('rejects malformed column values before returning a table', async () => {
    const { opened, ref } = await stored();
    for (const name of ['ids', 'flags', 'curves', 'offsets'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry);
        if (entry.descriptor.id === ref.columns[name][0]) {
          if (name === 'flags') bytes[0] = 2;
          else new DataView(bytes.buffer, bytes.byteOffset).setUint32(name === 'offsets' ? 4 : 0, name === 'ids' ? 0 : 7, true);
        }
        return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeBodySurfaces(ref, reader, () => true, () => true)).rejects.toThrow();
    }
  });
  it('supports empty tables and rejects mismatched source IDs', async () => {
    const { opened, ref } = await stored(new Map()), budget = new NativeColumnBudget(4);
    const packed = await readNativeBodySurfaces(ref, new NativeColumnReader(opened, budget), () => false, () => false);
    expect(packed.offsets).toEqual(new Uint32Array([0])); expect(budget.usedBytes).toBe(4);
    const source = fixture(); source.get(2 as SurfaceId)!.id = 9 as SurfaceId;
    await expect(stored(source)).rejects.toThrow();
  });
});
