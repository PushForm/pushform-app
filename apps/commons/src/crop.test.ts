// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { clampCrop, initialCrop, panCrop, renderCrop, sourceRect, zoomCrop, type CanvasLike } from './crop';

const photo = { width: 4000, height: 3000 };
const avatar = { width: 512, height: 512 }, banner = { width: 1500, height: 500 };

it('fills the frame with the short side and keeps the crop inside the image', () => {
  expect(sourceRect(photo, avatar, initialCrop(photo))).toEqual({ x: 500, y: 0, width: 3000, height: 3000 });
  expect(sourceRect(photo, banner, initialCrop(photo))).toEqual({ x: 0, y: 833.3333333333334, width: 4000, height: 1333.3333333333333 });
  expect(sourceRect(photo, avatar, { zoom: 2, centerX: 0, centerY: 0 })).toEqual({ x: 0, y: 0, width: 1500, height: 1500 });
  expect(sourceRect(photo, avatar, { zoom: 2, centerX: 99999, centerY: 99999 })).toEqual({ x: 2500, y: 1500, width: 1500, height: 1500 });
  expect(clampCrop(photo, avatar, { zoom: 40, centerX: 2000, centerY: 1500 }).zoom).toBe(4);
  expect(clampCrop(photo, avatar, { zoom: 0.1, centerX: 2000, centerY: 1500 }).zoom).toBe(1);
});

it('drags and zooms in screen pixels relative to the displayed frame', () => {
  const zoomed = zoomCrop(photo, avatar, initialCrop(photo), 2);
  // At zoom 2 the 300-pixel-wide frame shows 1500 source pixels, so 30 screen pixels move 150 source pixels.
  const moved = panCrop(photo, avatar, zoomed, 30, -30, 300);
  expect(moved.centerX).toBeCloseTo(2000 - 150); expect(moved.centerY).toBeCloseTo(1500 + 150);
  expect(panCrop(photo, avatar, initialCrop(photo), 0, 500, 300).centerY).toBe(1500);
});

function fakeCanvas(options: { alpha?: number; pngSize?: number; jpegSizes?: number[] } = {}) {
  const canvases: (CanvasLike & { drawImage: ReturnType<typeof vi.fn>; encoded: { type?: string | undefined; quality?: number | undefined }[] })[] = [];
  const jpegSizes = [...(options.jpegSizes ?? [1000])];
  const create = () => {
    const drawImage = vi.fn(); const encoded: { type?: string | undefined; quality?: number | undefined }[] = [];
    const canvas = {
      width: 0, height: 0, drawImage, encoded,
      getContext: () => ({ drawImage, fillRect: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' as ImageSmoothingQuality, fillStyle: '',
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, options.alpha ?? 255]) }) as unknown as ImageData }),
      toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => {
        encoded.push({ type, quality });
        const size = type === 'image/png' ? options.pngSize ?? 1000 : jpegSizes.shift() ?? 1000;
        callback(new Blob([new Uint8Array(size)], { type: type ?? 'image/png' }));
      },
    };
    canvases.push(canvas as never); return canvas as unknown as CanvasLike;
  };
  return { create, canvases };
}

it('renders the avatar at exactly 512 by 512 from the cropped source area as JPEG', async () => {
  const { create, canvases } = fakeCanvas(); const image = {} as CanvasImageSource;
  const blob = await renderCrop(image, photo, 'avatar', { zoom: 2, centerX: 0, centerY: 0 }, create);
  expect(blob.type).toBe('image/jpeg'); expect(canvases[0]).toMatchObject({ width: 512, height: 512 });
  expect(canvases[0]!.drawImage).toHaveBeenCalledWith(image, 0, 0, 1500, 1500, 0, 0, 512, 512);
});

it('renders the banner at exactly 1500 by 500 and keeps transparent images as PNG', async () => {
  const { create, canvases } = fakeCanvas({ alpha: 0 });
  const blob = await renderCrop({} as CanvasImageSource, photo, 'banner', initialCrop(photo), create);
  expect(blob.type).toBe('image/png'); expect(canvases[0]).toMatchObject({ width: 1500, height: 500 });
  expect(canvases[0]!.drawImage.mock.calls[0]!.slice(5)).toEqual([0, 0, 1500, 500]);
});

it('flattens an over-limit transparent image and lowers JPEG quality until it fits', async () => {
  const { create, canvases } = fakeCanvas({ alpha: 0, pngSize: 3 * 1024 * 1024, jpegSizes: [3 * 1024 * 1024, 1000] });
  const blob = await renderCrop({} as CanvasImageSource, photo, 'banner', initialCrop(photo), create);
  expect(blob.type).toBe('image/jpeg'); expect(canvases).toHaveLength(2); expect(canvases[1]).toMatchObject({ width: 1500, height: 500 });
  expect(canvases[1]!.encoded.map(value => value.quality)).toEqual([0.9, 0.8]);
  const huge = fakeCanvas({ jpegSizes: [3e6, 3e6, 3e6, 3e6] });
  await expect(renderCrop({} as CanvasImageSource, photo, 'avatar', initialCrop(photo), huge.create)).rejects.toThrow('2 MiB');
});
