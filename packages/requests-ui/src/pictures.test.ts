// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { imageFiles, preparePicture, PICTURE_MAX_BYTES, type PictureScaler } from './pictures';

const scaler = (width: number, height: number, scaled: Blob | null = new Blob(['small'], { type: 'image/jpeg' })): PictureScaler & { scale: ReturnType<typeof vi.fn> } =>
  ({ size: async () => ({ width, height }), scale: vi.fn(async () => scaled) });

describe('preparePicture', () => {
  it('keeps a small PNG, JPEG or WebP as it is', async () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const file = new File(['pixels'], 'door.img', { type });
      const s = scaler(800, 600);
      const result = await preparePicture(file, 'door.img', s);
      expect(result).toEqual({ ok: true, file: { kind: 'screenshot', name: 'door.img', mime: type, blob: file } });
      expect(s.scale).not.toHaveBeenCalled();
    }
  });
  it('scales a picture whose longer side exceeds 1568 pixels, PNG as PNG and anything else as JPEG', async () => {
    const png = scaler(4000, 3000, new Blob(['small'], { type: 'image/png' }));
    const fromPng = await preparePicture(new File(['big'], 'kitchen.png', { type: 'image/png' }), 'kitchen.png', png);
    expect(png.scale).toHaveBeenCalledWith(expect.any(Blob), 'image/png');
    expect(fromPng.ok && fromPng.file).toMatchObject({ name: 'kitchen.png', mime: 'image/png' });
    const webp = scaler(1000, 3000);
    const fromWebp = await preparePicture(new File(['big'], 'pantry.webp', { type: 'image/webp' }), 'pantry.webp', webp);
    expect(webp.scale).toHaveBeenCalledWith(expect.any(Blob), 'image/jpeg');
    expect(fromWebp.ok && fromWebp.file).toMatchObject({ name: 'pantry.jpg', mime: 'image/jpeg' });
  });
  it('refuses other types, empty files and pictures over 5 MB after scaling, saying why', async () => {
    expect(await preparePicture(new File(['<svg/>'], 'plan.svg', { type: 'image/svg+xml' }), 'plan.svg', scaler(10, 10))).toEqual({ ok: false, reason: 'plan.svg is not a PNG, JPEG or WebP image.' });
    expect(await preparePicture(new File([], 'empty.png', { type: 'image/png' }), 'empty.png', scaler(10, 10))).toEqual({ ok: false, reason: 'empty.png is empty.' });
    const huge = new File([new Uint8Array(PICTURE_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' });
    expect(await preparePicture(huge, 'huge.png', scaler(1000, 800))).toEqual({ ok: false, reason: 'huge.png is larger than 5 MB, even scaled down.' });
  });
  it('keeps the original when the browser cannot decode or scale it', async () => {
    const file = new File(['pixels'], 'shot.jpg', { type: 'image/jpeg' });
    const result = await preparePicture(file, 'shot.jpg', { size: async () => null, scale: async () => null });
    expect(result.ok && result.file.blob).toBe(file);
  });
});

describe('imageFiles', () => {
  it('keeps only image files from a drop or paste', () => {
    const files = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.txt', { type: 'text/plain' })];
    expect(imageFiles(files).map(f => f.name)).toEqual(['a.png']);
    expect(imageFiles(null)).toEqual([]);
  });
});
