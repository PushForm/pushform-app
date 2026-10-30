// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { ImageId } from '@pushform/core';
import { ImageStore, RUNTIME_IMAGE_ID_BASE, base64ToBytes, bytesToBase64, fastHash, hashImageBytes, imageSizeFromHeader } from './images';
import { uvAffineFromPoints, uvAffineLeastSquares, uvApply, uvAutoAffine, uvCompose, uvInvert, uvToAffine } from './uv';

/** Minimal PNG header: signature + IHDR chunk with the given size (no image data). */
function pngHeader(width: number, height: number, tail = 0): Uint8Array {
  const b = new Uint8Array(33 + tail);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  for (let i = 0; i < tail; i++) b[33 + i] = (i * 7) & 255;
  return b;
}

describe('ImageStore', () => {
  it('dedupes identical bytes by content hash and allocates runtime ids otherwise', async () => {
    const store = new ImageStore();
    const a = await store.put(pngHeader(64, 32), 'image/png', 'a.png');
    const again = await store.put(pngHeader(64, 32), 'image/png', 'other-name.png');
    expect(again).toBe(a);
    expect(store.size).toBe(1);
    expect(a.width).toBe(64);
    expect(a.height).toBe(32);
    expect(a.id).toBeGreaterThanOrEqual(RUNTIME_IMAGE_ID_BASE);
    const b = await store.put(pngHeader(64, 32, 4), 'image/png', 'b.png');
    expect(b.id).not.toBe(a.id);
    expect(b.sha256).not.toBe(a.sha256);
    expect(store.findByHash(b.sha256)).toBe(b.id);
    expect(store.size).toBe(2);
  });

  it('registers document assets under their id, serves data URLs and removes them', async () => {
    const store = new ImageStore();
    const bytes = pngHeader(8, 8);
    const asset = await store.put(bytes, 'image/png', 'doc.png', { id: 42 as ImageId });
    expect(asset.id).toBe(42);
    expect(store.has(42 as ImageId)).toBe(true);
    expect(store.get(42 as ImageId)?.mime).toBe('image/png');
    const url = store.dataUrl(42 as ImageId)!;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(base64ToBytes(url)).toEqual(bytes);
    expect(store.objectUrl(42 as ImageId)).toBeTruthy();
    expect(store.remove(42 as ImageId)).toBe(true);
    expect(store.has(42 as ImageId)).toBe(false);
    expect(store.findByHash(asset.sha256)).toBeUndefined();
  });

  it('hashes with SHA-256 when WebCrypto exists and falls back to the fast hash', async () => {
    const bytes = pngHeader(1, 1);
    const sha = await hashImageBytes(bytes);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(fastHash(bytes)).toMatch(/^[0-9a-f]{16}$/);
    expect(fastHash(bytes)).toBe(fastHash(new Uint8Array(bytes)));
    expect(fastHash(pngHeader(1, 2))).not.toBe(fastHash(bytes));
  });

  it('reads sizes from PNG, GIF, JPEG and BMP headers', () => {
    expect(imageSizeFromHeader(pngHeader(300, 200))).toEqual({ width: 300, height: 200 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x01, 0x20, 0x00]);
    expect(imageSizeFromHeader(gif)).toEqual({ width: 272, height: 32 });
    // JPEG: SOI, then an APP0 segment, then SOF0 with height 48, width 96
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x60, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSizeFromHeader(jpeg)).toEqual({ width: 96, height: 48 });
    // BMP: 'BM' file header, then a BITMAPINFOHEADER with width 256 and height -64 (top-down)
    const bmp = new Uint8Array(54);
    const bmpView = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]);
    bmpView.setUint32(2, 54, true);
    bmpView.setUint32(14, 40, true);
    bmpView.setInt32(18, 256, true);
    bmpView.setInt32(22, -64, true);
    expect(imageSizeFromHeader(bmp)).toEqual({ width: 256, height: 64 });
    expect(imageSizeFromHeader(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});

describe('uv affine helpers', () => {
  it('auto mapping divides by the texture size; inverse and compose round-trip', () => {
    const m = uvAutoAffine(2, 0.5);
    expect(uvApply(m, 1, 1)).toEqual([0.5, 2]);
    expect(uvToAffine({ kind: 'auto' }, 2, 0.5)).toEqual(m);
    expect(uvToAffine({ kind: 'affine', matrix: [1, 2, 3, 4, 5, 6] }, 2, 0.5)).toEqual([1, 2, 3, 4, 5, 6]);
    const a: readonly [number, number, number, number, number, number] = [2, 1, 3, -1, 0.5, 1];
    const inv = uvInvert(a)!;
    const id = uvCompose(a, inv);
    expect(id[0]).toBeCloseTo(1);
    expect(id[1]).toBeCloseTo(0);
    expect(id[2]).toBeCloseTo(0);
    expect(id[4]).toBeCloseTo(1);
    expect(uvInvert([1, 2, 0, 2, 4, 0])).toBeNull();
  });

  it('affineFromPoints maps the three points exactly and least squares reproduces an affine map', () => {
    const src: [[number, number], [number, number], [number, number]] = [[0, 0], [1, 0], [0, 1]];
    const dst: [[number, number], [number, number], [number, number]] = [[1, 1], [3, 2], [0, 3]];
    const m = uvAffineFromPoints(src, dst)!;
    for (let i = 0; i < 3; i++) {
      const p = uvApply(m, src[i]![0], src[i]![1]);
      expect(p[0]).toBeCloseTo(dst[i]![0]);
      expect(p[1]).toBeCloseTo(dst[i]![1]);
    }
    const ls = uvAffineLeastSquares([...src, [1, 1]], [...dst, uvApply(m, 1, 1)])!;
    for (let i = 0; i < 6; i++) expect(ls[i]).toBeCloseTo(m[i]!);
  });
});
