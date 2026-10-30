// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Draw a picture (data: URL, including SVG) onto a canvas of the given size and return PNG bytes. */
export async function rasterizeImage(src: string, width: number, height: number): Promise<Uint8Array> {
  return encodeImage(src, { width, height, mime: 'image/png' });
}

/**
 * Re-encode a picture (data: URL) through a canvas: at its own pixel size unless a size is given, as PNG or as JPEG at
 * `quality` (0–1) over a `fill` color, since JPEG has no transparency.
 */
export async function encodeImage(src: string, options: { width?: number; height?: number; mime: 'image/png' | 'image/jpeg'; quality?: number; fill?: string }): Promise<Uint8Array> {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, options.width ?? image.naturalWidth);
  canvas.height = Math.max(1, options.height ?? image.naturalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  if (options.fill) { ctx.fillStyle = options.fill; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, options.mime, options.quality));
  if (!blob) throw new Error(options.mime === 'image/jpeg' ? 'Could not encode JPEG' : 'Could not encode PNG');
  return new Uint8Array(await blob.arrayBuffer());
}
