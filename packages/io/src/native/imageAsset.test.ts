// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { ImageId } from '@pushform/core';
import { describe, expect, it } from 'vitest';
import { decodeNativeImageAsset, encodeNativeImageAsset, readNativeImageAsset, streamNativeImageAsset } from './imageAsset';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { openNativeContainer, writeNativeContainer } from './container';
import type { NativeStoredChunk } from './container';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
const schema = protobuf.parse(readFileSync(new URL('./imageAsset.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.ImageAsset');
const asset = { id: 1 as ImageId, name: 'brick', mime: 'image/png', width: 64, height: 64, sha256: 'source-hash' };
describe('native image assets', () => {
  it('preserves unavailable versus empty payloads and matches Protobuf wire bytes', () => {
    for (const payload of [undefined, { chunks: [], byteLength: 0 }, { chunks: [2, 3], byteLength: 70000 }]) {
      const record = { asset, ...(payload ? { payload } : {}), unknownFields: [] };
      const bytes = encodeNativeImageAsset(record); expect(decodeNativeImageAsset(bytes)).toEqual(record);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
  });
  it('streams encoded images as owned raw pages without recompressing', async () => {
    const bytes = new Uint8Array(70000), stream = streamNativeImageAsset(asset, { bytes, mime: asset.mime }, (() => { let id = 1; return () => ++id; })());
    let chunks = 0;
    for (;;) {
      const item = await stream.next();
      if (item.done) { expect(item.value.payload).toEqual({ chunks: [2, 3], byteLength: 70000 }); break; }
      expect(item.value.descriptor.codec).toBe(0); expect(item.value.descriptor.kind).toBe(4);
      expect(item.value.data.buffer).not.toBe(bytes.buffer); chunks++;
    }
    expect(chunks).toBe(2);
  });
  it('rejects missing lengths, repeated chunk IDs and MIME mismatches', async () => {
    const wire = { ...asset, sourceHash: asset.sha256, payloadChunks: [2] };
    expect(() => decodeNativeImageAsset(schema.encode(wire).finish())).toThrow();
    expect(() => encodeNativeImageAsset({ asset, payload: { chunks: [2, 2], byteLength: 2 }, unknownFields: [] })).toThrow();
    await expect(streamNativeImageAsset(asset, { bytes: new Uint8Array(), mime: 'image/jpeg' }, () => 2).next()).rejects.toThrow();
  });
  it('loads an asset through the indexed container within the shared allocation budget', async () => {
    const original = new Uint8Array(70000).map((_, i) => i % 251); let id = 1;
    async function* records(): AsyncGenerator<NativeStoredChunk> {
      const ref = yield* streamNativeImageAsset(asset, { bytes: original, mime: asset.mime }, () => id++);
      for await (const chunk of encodeNativeChunks([encodeNativeImageAsset(ref)]))
        yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
    }
    const parts: Uint8Array[] = [];
    const result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
    const file = new Uint8Array(result.storedBytes); let at = 0;
    for (const part of parts) { file.set(part, at); at += part.length; }
    const opened = await openNativeContainer({ size: file.length, read: async (offset, length) => file.subarray(offset, offset + length) }, () => true);
    const ref = decodeNativeImageAsset(await opened.read(opened.entries.at(-1)!));
    const budget = new NativeColumnBudget(original.length), reader = new NativeColumnReader(opened, budget);
    const restored = await readNativeImageAsset(ref, reader);
    expect(restored?.bytes).toEqual(original); expect(restored?.mime).toBe(asset.mime); expect(budget.usedBytes).toBe(original.length);
    await expect(readNativeImageAsset(ref, reader)).rejects.toThrow('budget');
    const bad = { ...ref, payload: { chunks: [0xffff_ffff], byteLength: 1 } };
    await expect(readNativeImageAsset(bad, reader)).rejects.toThrow();
    expect(await readNativeImageAsset({ asset, unknownFields: [] }, reader)).toBeUndefined();
  });
});
