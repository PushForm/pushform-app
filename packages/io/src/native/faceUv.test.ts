// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { Id } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { streamNativeFaceUv, readNativeFaceUv, nativeFaceUvAt, encodeNativeFaceUvReference, decodeNativeFaceUvReference } from './faceUv';
import type { NativeFaceUvReference, NativeFaceUvSource } from './faceUv';
import { streamNativeNumbers } from './numericStream';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./faceUv.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.FaceUv');
function fixture(): Map<Id, NativeFaceUvSource> {
  const affine = { kind: 'affine', matrix: [1, -0, 3, 4, 5, 6] } as const;
  return new Map<Id, NativeFaceUvSource>([
    [1 as Id, { uv: { kind: 'auto' } }], [2 as Id, { uv: affine, uvBack: undefined }],
    [3 as Id, { uv: { kind: 'projective', matrix: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, uvBack: { kind: 'auto' } }],
    [4 as Id, { uv: { kind: 'sized', matrix: [1, 2, 3, 4, 5, 6] }, uvBack: affine }],
  ]);
}
async function stored(source: AsyncGenerator<NativeStoredChunk, NativeFaceUvReference>) {
  let ref: NativeFaceUvReference | undefined;
  async function* records() {
    ref = yield* source;
    for await (const chunk of encodeNativeChunks([encodeNativeFaceUvReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { opened, ref: ref! };
}
describe('packed face UV columns', () => {
  it('preserves all mapping kinds, back-side presence and exact coefficients across page boundaries', async () => {
    const faces = fixture(); let nextId = 1;
    const { opened, ref } = await stored(streamNativeFaceUv(faces, () => nextId++, { pageBytes: 32 }));
    const budget = new NativeColumnBudget(260), table = await readNativeFaceUv(ref, new NativeColumnReader(opened, budget));
    expect(budget.usedBytes).toBe(260); expect(ref.valueCount).toBe(27);
    let row = 0; for (const face of faces.values()) {
      const decoded = nativeFaceUvAt(table, row++); expect(decoded).toEqual(face); expect(Object.hasOwn(decoded, 'uvBack')).toBe(Object.hasOwn(face, 'uvBack'));
    }
    expect(Object.is(table.values[1], -0)).toBe(true);
    const bytes = encodeNativeFaceUvReference(ref); expect(decodeNativeFaceUvReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    expect(() => nativeFaceUvAt(table, 4)).toThrow();
  });
  it('rejects inconsistent offsets and unsupported or absent front mapping kinds', async () => {
    for (const [kinds, offsets] of [[[0, 0], [0, 0, 0]], [[6, 0], [0, 0, 0]], [[3, 0], [0, 0, 0]], [[2, 0], [1, 1, 0]]]) {
      async function* raw(): AsyncGenerator<NativeStoredChunk, NativeFaceUvReference> {
        let id = 1; const next = () => id++;
        const kindChunks = yield* streamNativeNumbers(kinds!, 'uint8', 2, next);
        const offsetChunks = yield* streamNativeNumbers(offsets!, 'uint32', 3, next);
        return { faceCount: 1, valueCount: 0, kindChunks, offsetChunks, valueChunks: [], unknownFields: [] };
      }
      const { opened, ref } = await stored(raw());
      await expect(readNativeFaceUv(ref, new NativeColumnReader(opened, new NativeColumnBudget()))).rejects.toThrow();
    }
  });
  it('handles empty faces and rejects nonfinite coefficients before finishing the stream', async () => {
    let id = 1; const { opened, ref } = await stored(streamNativeFaceUv(new Map(), () => id++));
    const budget = new NativeColumnBudget(4), table = await readNativeFaceUv(ref, new NativeColumnReader(opened, budget));
    expect(table.offsets).toEqual(new Uint32Array([0])); expect(table.kinds.length).toBe(0); expect(table.values.length).toBe(0);
    const bad = new Map<Id, NativeFaceUvSource>([[1 as Id, { uv: { kind: 'affine', matrix: [Infinity, 0, 0, 0, 0, 0] } }]]);
    await expect(stored(streamNativeFaceUv(bad, () => id++))).rejects.toThrow();
  });
});
