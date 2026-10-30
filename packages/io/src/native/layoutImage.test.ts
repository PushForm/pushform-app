// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { LayoutImage } from '@pushform/layout';
import { encodeNativeLayoutImage, decodeNativeLayoutImage, streamNativeLayoutImage, readNativeLayoutImage, materializeNativeLayoutImage } from './layoutImage';
import { streamNativeLayoutAsset, readNativeLayoutAsset, materializeNativeLayoutAsset } from './layoutAsset';
import { NativeColumnBudget, NativeColumnReader } from './columns';
import { decodeNativeChunks } from './chunks';
import type { NativeStoredChunk } from './container';
const schema = protobuf.parse(readFileSync(new URL('./layoutImage.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.LayoutImage');
function fixture(): LayoutImage {
  return { src: 'data:image/png;base64,AQID', clip: { points: [[-0, 0], [1, 0], [1, 1], [0, 1]], handles: [{ out: [0.5, -0.25] }, {}, {}, { in: undefined }] },
    viewport: { source: { referenceId: 10 }, templateId: null, originalId: null, camera: { eye: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fov: 45, scale: 1 },
      scene: null, background: null, cache: null } };
}
async function stored(source: LayoutImage) {
  let id = 1; const chunks: NativeStoredChunk[] = [];
  async function drain<T>(stream: AsyncGenerator<NativeStoredChunk, T>): Promise<T> {
    let step = await stream.next(); while (!step.done) { chunks.push(step.value); step = await stream.next(); } return step.value;
  }
  const assetRef = await drain(streamNativeLayoutAsset(source.src, 'image', () => id++, { pageBytes: 16 }));
  const reference = decodeNativeLayoutImage(encodeNativeLayoutImage(await drain(streamNativeLayoutImage(source, 1, () => id++, { pageBytes: 16 }))));
  const budget = new NativeColumnBudget(), entries = chunks.map(c => ({ descriptor: c.descriptor, offset: 0 }));
  const reader = new NativeColumnReader({ entries, read: async entry => {
    const c = chunks.find(c => c.descriptor === entry.descriptor)!;
    for await (const bytes of decodeNativeChunks([{ codec: c.descriptor.codec, decodedBytes: c.descriptor.decodedBytes, digest: c.descriptor.sha256, data: c.data }])) return bytes;
    throw new Error('missing chunk');
  } }, budget);
  const asset = await readNativeLayoutAsset(assetRef, reader), assets = new Map([[1, asset]]);
  return { reference, reader, budget, assets, sourceStrings: new Map([[1, materializeNativeLayoutAsset(asset)]]) };
}
it('composes exact crop geometry, source asset and editable viewport metadata with schema interoperability', async () => {
  const source = fixture(), s = await stored(source), bytes = encodeNativeLayoutImage(s.reference);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const packed = await readNativeLayoutImage(s.reference, s.assets, s.reader);
  expect(materializeNativeLayoutImage(packed, s.sourceStrings)).toEqual(source);
  expect(s.budget.usedBytes).toBe(3 + 64 + 4 + 16);
  expect(Object.is(packed.clip!.points[0], -0)).toBe(true);
});
it('shares staged binary assets across image records without charging or copying their payload twice', async () => {
  const s = await stored({ src: fixture().src });
  const a = await readNativeLayoutImage(s.reference, s.assets, s.reader), b = await readNativeLayoutImage(s.reference, s.assets, s.reader);
  expect(a.asset).toBe(b.asset); expect(a.asset.bytes).toBe(b.asset.bytes); expect(s.budget.usedBytes).toBe(3);
  expect(materializeNativeLayoutImage(a, s.sourceStrings)).toEqual(materializeNativeLayoutImage(b, s.sourceStrings));
});
it('preserves absence, explicit undefined and empty crop points', async () => {
  for (const source of [{ src: '' }, { src: '', clip: undefined, viewport: undefined }, { src: '', clip: { points: [] } } satisfies LayoutImage]) {
    const s = await stored(source), next = materializeNativeLayoutImage(await readNativeLayoutImage(s.reference, s.assets, s.reader), s.sourceStrings);
    expect(next).toEqual(source); expect(Object.hasOwn(next, 'clip')).toBe(Object.hasOwn(source, 'clip'));
    expect(Object.hasOwn(next, 'viewport')).toBe(Object.hasOwn(source, 'viewport'));
  }
});
it('owns future fields at image, crop, viewport-wrapper and nested viewport scopes', async () => {
  const s = await stored(fixture()), fields = [new Uint8Array([0x98, 6, 7])];
  s.reference.extensions = new Map(['', 'clip', 'viewport'].map(key => [key, fields]));
  s.reference.clip!.extensions.set('points', fields); s.reference.viewportExtensions.records.set('camera', fields);
  const bytes = encodeNativeLayoutImage(s.reference), next = decodeNativeLayoutImage(bytes); bytes.fill(0); next.viewport!.scene = 'New scene';
  const rewritten = decodeNativeLayoutImage(encodeNativeLayoutImage(next));
  expect(rewritten.extensions).toEqual(s.reference.extensions); expect(rewritten.clip!.extensions).toEqual(s.reference.clip!.extensions);
  expect(rewritten.viewportExtensions).toEqual(s.reference.viewportExtensions);
});
it('rejects missing assets and malformed wrappers before installing an image', async () => {
  const s = await stored(fixture()), plain = schema.toObject(schema.decode(encodeNativeLayoutImage(s.reference)));
  for (const patch of [{ assetId: 0 }, { clip: { state: 0, value: new Uint8Array() } }, { viewport: { state: 1 } }, { clip: { state: 2 } }]) {
    expect(() => decodeNativeLayoutImage(schema.encode({ ...plain, ...patch }).finish())).toThrow();
  }
  await expect(readNativeLayoutImage(s.reference, new Map(), s.reader)).rejects.toThrow(); expect(s.budget.usedBytes).toBe(3);
  s.reference.clip!.closed = true; expect(() => encodeNativeLayoutImage(s.reference)).toThrow();
});
