// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { meshBox } from '@pushform/core';
import { bodyFromMesh, createDocument } from '@pushform/model';
import { meshTopologyProblems } from '@pushform/kernel';
import { streamNativeBody, readNativeBody, encodeNativeBodyReference, decodeNativeBodyReference } from './body';
import type { NativeBodyReference } from './body';
import { NativeCommonPropertyWriter, NativeCommonPropertyReader } from './commonProperty';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
import { encodeNativeModelRecord, decodeNativeModelRecord } from './modelRecord';
import type { DefId } from '@pushform/core';
async function fixture() {
  const doc = createDocument(), body = doc.transact('box', draft => bodyFromMesh(draft, meshBox([0, 0, 0], [2, 1, 1]))).value;
  const writer = new NativeCommonPropertyWriter(), properties = new NativeCommonPropertyReader();
  let id = 1, ref: NativeBodyReference | undefined;
  async function* chunks() {
    ref = yield* streamNativeBody(body, value => writer.intern(value).id, () => id++, { pageBytes: 64 }, new Map([['faces', [new Uint8Array([0x98, 6, 7])]]]));
    for await (const chunk of encodeNativeChunks([encodeNativeBodyReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, chunks(), { write: async bytes => { parts.push(bytes.slice()); } });
  properties.add(writer.encodeRecord(1));
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { body, ref: ref!, opened, properties };
}
describe('complete packed body staging', () => {
  it('round trips a closed box and validates its cross-table references', async () => {
    const { body, ref, opened, properties } = await fixture(), budget = new NativeColumnBudget(); let validated = 0;
    const packed = await readNativeBody(ref, new NativeColumnReader(opened, budget), properties, () => false, id => id === body.tagId,
      async mesh => { expect(meshTopologyProblems(mesh)).toEqual([]); validated++; });
    expect(validated).toBe(1); expect(packed.mesh).toEqual(body.mesh); expect(packed.props).toEqual(body.props);
    expect(packed.id).toBe(body.id); expect(packed.common).toMatchObject({ tagId: body.tagId, hidden: body.hidden, attributes: body.attributes });
    expect(Array.from(packed.faces.ids)).toEqual([...body.faces.keys()]); expect(packed.edges.rows.length / 5).toBe(12);
    expect(packed.nextFaceId).toBe(body.nextFaceId); expect(packed.imprints).toEqual([]);
    expect(packed.extensions.get('faces')).toEqual(ref.faces.unknownFields);
    expect(decodeNativeBodyReference(encodeNativeBodyReference(ref))).toEqual(ref);
    const envelope = encodeNativeModelRecord({ kind: 'body', ownerDefinitionId: 1 as DefId, value: ref });
    const decoded = decodeNativeModelRecord(envelope); expect(decoded.kind).toBe('body');
    expect(encodeNativeModelRecord(decoded)).toEqual(envelope);
    expect(budget.usedBytes).toBe(2934);
    const schema = (await protobuf.load(fileURLToPath(new URL('./body.proto', import.meta.url)))).lookupType('pushform.native.Body');
    const encoded = encodeNativeBodyReference(ref);
    // Reflection drops nested unknown fields, so test wire equivalence on the known schema here.
    const known = decodeNativeBodyReference(encoded); known.faces.unknownFields = [];
    const knownBytes = encodeNativeBodyReference(known);
    expect(Array.from(schema.encode(schema.decode(knownBytes)).finish())).toEqual(Array.from(knownBytes));
  });
  it('propagates kernel rejection and cancellation before reading decoration tables', async () => {
    const { ref, opened, properties } = await fixture();
    await expect(readNativeBody(ref, new NativeColumnReader(opened, new NativeColumnBudget()), properties, () => true, () => true,
      async () => { throw new Error('not a solid'); })).rejects.toThrow('not a solid');
    const controller = new AbortController();
    await expect(readNativeBody(ref, new NativeColumnReader(opened, new NativeColumnBudget()), properties, () => true, () => true,
      async () => { controller.abort(); }, controller.signal)).rejects.toThrow();
  });
  it('rejects chunk aliasing, stale allocators and missing global references', async () => {
    const { ref, opened, properties } = await fixture();
    const bad = decodeNativeBodyReference(encodeNativeBodyReference(ref)); bad.mesh.vertexChunks[0] = bad.faces.columns.ids[0]!;
    expect(() => encodeNativeBodyReference(bad)).toThrow();
    await expect(readNativeBody({ ...ref, nextFaceId: 0 }, new NativeColumnReader(opened, new NativeColumnBudget()), properties, () => true, () => true, async () => {})).rejects.toThrow();
    await expect(readNativeBody(ref, new NativeColumnReader(opened, new NativeColumnBudget()), properties, () => true, () => false, async () => {})).rejects.toThrow();
  });
});
