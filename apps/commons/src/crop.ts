// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COMMONS_PROFILE_IMAGE_LIMIT, COMMONS_PROFILE_IMAGE_SIZES, type CommonsProfileImageKind } from '@pushform/cloud';

export interface Size { width: number; height: number }
/** zoom 1 fills the frame with the whole short side; centerX/centerY are the frame center in source pixels. */
export interface Crop { zoom: number; centerX: number; centerY: number }
export interface SourceRect { x: number; y: number; width: number; height: number }
export const MAX_ZOOM = 4;
export const SOURCE_FILE_LIMIT = 20 * 1024 * 1024;
export const SOURCE_PIXEL_LIMIT = 8192;

export const outputSize = (kind: CommonsProfileImageKind): Size => COMMONS_PROFILE_IMAGE_SIZES[kind];
export const initialCrop = (source: Size): Crop => ({ zoom: 1, centerX: source.width / 2, centerY: source.height / 2 });
/** Source pixels covered by the frame: the frame keeps the output aspect ratio and never leaves the image. */
export function sourceRect(source: Size, frame: Size, crop: Crop): SourceRect {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const fit = Math.min(source.width / frame.width, source.height / frame.height);
  const width = Math.min(source.width, frame.width * fit / zoom), height = Math.min(source.height, frame.height * fit / zoom);
  const x = Math.min(source.width - width, Math.max(0, crop.centerX - width / 2));
  const y = Math.min(source.height - height, Math.max(0, crop.centerY - height / 2));
  return { x, y, width, height };
}
export function clampCrop(source: Size, frame: Size, crop: Crop): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const rect = sourceRect(source, frame, { ...crop, zoom });
  return { zoom, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 };
}
/** Dragging the picture by (dx, dy) screen pixels in a frame displayed `displayWidth` wide. */
export function panCrop(source: Size, frame: Size, crop: Crop, dx: number, dy: number, displayWidth: number): Crop {
  const rect = sourceRect(source, frame, crop); const perPixel = rect.width / Math.max(1, displayWidth);
  return clampCrop(source, frame, { ...crop, centerX: crop.centerX - dx * perPixel, centerY: crop.centerY - dy * perPixel });
}
export const zoomCrop = (source: Size, frame: Size, crop: Crop, zoom: number): Crop => clampCrop(source, frame, { ...crop, zoom });

export interface CanvasLike {
  width: number; height: number;
  getContext(type: '2d'): Pick<CanvasRenderingContext2D, 'drawImage'|'getImageData'|'fillRect'|'imageSmoothingEnabled'|'imageSmoothingQuality'|'fillStyle'> | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}
const browserCanvas = (): CanvasLike => document.createElement('canvas') as unknown as CanvasLike;
const encode = (canvas: CanvasLike, type: string, quality?: number) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob(blob => blob && blob.type === type ? resolve(blob) : reject(new Error('Your browser could not encode this image.')), type, quality));

/**
 * Draws the cropped area at the fixed output size. Transparent images stay PNG; others become JPEG. A transparent
 * image too detailed for the size limit is flattened onto white and saved as JPEG.
 */
export async function renderCrop(image: CanvasImageSource, source: Size, kind: CommonsProfileImageKind, crop: Crop, createCanvas: () => CanvasLike = browserCanvas): Promise<Blob> {
  const out = outputSize(kind); const rect = sourceRect(source, out, crop);
  const canvas = createCanvas(); canvas.width = out.width; canvas.height = out.height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Your browser cannot crop images.');
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, out.width, out.height);
  const pixels = context.getImageData(0, 0, out.width, out.height).data;
  let transparent = false; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) { transparent = true; break; }
  if (transparent) {
    const png = await encode(canvas, 'image/png');
    if (png.size <= COMMONS_PROFILE_IMAGE_LIMIT) return png;
    const flat = createCanvas(); flat.width = out.width; flat.height = out.height;
    const flatContext = flat.getContext('2d'); if (!flatContext) throw new Error('Your browser cannot crop images.');
    flatContext.fillStyle = '#ffffff'; flatContext.fillRect(0, 0, out.width, out.height); flatContext.drawImage(canvas as unknown as CanvasImageSource, 0, 0);
    return jpeg(flat);
  }
  return jpeg(canvas);
}
async function jpeg(canvas: CanvasLike): Promise<Blob> {
  for (const quality of [0.9, 0.8, 0.7, 0.55]) {
    const blob = await encode(canvas, 'image/jpeg', quality);
    if (blob.size <= COMMONS_PROFILE_IMAGE_LIMIT) return blob;
  }
  throw new Error('The cropped image is larger than 2 MiB. Try a simpler image.');
}

/** Decodes a chosen PNG or JPEG file, refusing very large files before decoding them. */
export async function loadSourceImage(file: File): Promise<{ image: CanvasImageSource; size: Size; release(): void }> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Choose a PNG or JPEG image.');
  if (file.size > SOURCE_FILE_LIMIT) throw new Error('Choose an image no larger than 20 MiB.');
  const url = URL.createObjectURL(file); const image = new Image(); image.decoding = 'async'; image.src = url;
  try { await image.decode(); } catch { URL.revokeObjectURL(url); throw new Error('This image could not be read. Choose a PNG or JPEG image.'); }
  const size = { width: image.naturalWidth, height: image.naturalHeight };
  if (!size.width || !size.height || size.width > SOURCE_PIXEL_LIMIT || size.height > SOURCE_PIXEL_LIMIT) {
    URL.revokeObjectURL(url); throw new Error('Choose an image at most 8,192 pixels on each side.');
  }
  return { image, size, release: () => URL.revokeObjectURL(url) };
}
