// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decodeNativeMeshReference, encodeNativeMeshReference, readNativeMesh, streamNativeMesh, validateNativeMesh, writeNativeMesh } from './mesh';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks, encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { openNativeContainer, writeNativeContainer } from './container';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./meshReference.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.MeshReference');
const mesh = () => ({ verts: new Float64Array([-0, 0, 0, 1, 0, 0, 0, 1, 0]), tris: new Uint32Array([0, 1, 2]), faceId: new Uint32Array([42]) });

describe('native mesh adapter', () => {
  it('streams a mesh, encodes its Protobuf reference, and restores exact geometry', async () => {
    const input = mesh(), records: NativeStoredChunk[] = []; let id = 1;
    const ref = await writeNativeMesh(input, () => id++, async chunk => { records.push(chunk); }, { pageBytes: 16 });
    const wire = encodeNativeMeshReference(ref);
    expect(Array.from(wire)).toEqual(Array.from(schema.encode(ref).finish()));
    const entries = records.map(record => ({ descriptor: record.descriptor, offset: 0 }));
    const reader = new NativeColumnReader({ entries, read: async entry => {
      const record = records.find(r => r.descriptor.id === entry.descriptor.id)!;
      for await (const bytes of decodeNativeChunks([{ codec: record.descriptor.codec, decodedBytes: record.descriptor.decodedBytes, data: record.data, digest: record.descriptor.sha256 }])) return bytes;
      throw new Error('missing chunk');
    } }, new NativeColumnBudget());
    const restored = await readNativeMesh(decodeNativeMeshReference(wire), reader);
    expect(restored).toEqual(input); expect(Object.is(restored.verts[0], -0)).toBe(true);
  });
  it('preserves unknown mesh metadata across a known-field edit', () => {
    const ref = { vertexCount: 1, triangleCount: 0, vertexChunks: [1], triangleChunks: [], faceIdChunks: [], unknownFields: [new Uint8Array([0x98, 6, 7])] };
    const bytes = encodeNativeMeshReference(ref), decoded = decodeNativeMeshReference(bytes); bytes.fill(0);
    decoded.vertexChunks[0] = 2;
    expect(decodeNativeMeshReference(encodeNativeMeshReference(decoded)).unknownFields).toEqual(ref.unknownFields);
  });
  it('rejects duplicate IDs, missing counts, unsupported wire shapes and bad packed lengths', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([8, 1, 16, 0, 26, 2, 1, 1]),
      new Uint8Array([8, 1, 16, 0, 26, 1, 128]), new Uint8Array([10, 0, 16, 0])])
      expect(() => decodeNativeMeshReference(bytes)).toThrow();
  });
  it('rejects invalid geometry before writing chunks', async () => {
    const bad = mesh(); bad.tris[2] = 3;
    let writes = 0;
    await expect(writeNativeMesh(bad, () => 1, async () => { writes++; })).rejects.toThrow(); expect(writes).toBe(0);
    const nonfinite = mesh(); nonfinite.verts[0] = Infinity; expect(() => validateNativeMesh(nonfinite)).toThrow();
    expect(() => validateNativeMesh({ ...mesh(), faceId: new Uint32Array() })).toThrow();
  });
  it('streams geometry followed by its metadata into an append-only container', async () => {
    const input = mesh(), rootId = 0xffff_ffff; let id = 1;
    async function* records(): AsyncGenerator<NativeStoredChunk> {
      const reference = yield* streamNativeMesh(input, () => id++, { pageBytes: 16 });
      for await (const chunk of encodeNativeChunks([encodeNativeMeshReference(reference)]))
        yield { descriptor: describeNativeChunk(rootId, 1, 1, true, chunk), data: chunk.data };
    }
    // Only this test sink collects file bytes; the producer never collects chunks.
    const parts: Uint8Array[] = [];
    const written = await writeNativeContainer({ kind: 1, root: rootId }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
    const bytes = new Uint8Array(written.storedBytes); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const opened = await openNativeContainer({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) }, () => true);
    const root = opened.entries.find(e => e.descriptor.id === rootId)!;
    const reference = decodeNativeMeshReference(await opened.read(root));
    expect(await readNativeMesh(reference, new NativeColumnReader(opened, new NativeColumnBudget()))).toEqual(input);
  });
  it('does not allocate further chunk IDs after its consumer fails', async () => {
    let id = 0;
    await expect(writeNativeMesh(mesh(), () => ++id, async () => { throw new Error('sink failed'); }, { pageBytes: 8 })).rejects.toThrow('sink failed');
    expect(id).toBe(1);
  });
});
