// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { SCREENSHOT_TYPES, type AttachmentFile } from './client';

/** The longest side a posted picture keeps; larger images are scaled down before upload. */
export const PICTURE_MAX_SIDE = 1568;
/** The largest picture the agent can be shown. */
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
/** Pictures one message may carry. */
export const PICTURES_PER_MESSAGE = 5;

/** A picture ready to upload, or why it was refused. */
export type PreparedPicture = { ok: true; file: AttachmentFile } | { ok: false; reason: string };

/** Decodes and draws an image at a size; null where the browser cannot (tests, old engines). */
export interface PictureScaler {
  scale(blob: Blob, mime: 'image/png' | 'image/jpeg'): Promise<Blob | null>;
  size(blob: Blob): Promise<{ width: number; height: number } | null>;
}

const browserScaler: PictureScaler = {
  async size(blob) {
    if (typeof createImageBitmap !== 'function') return null;
    try { const bitmap = await createImageBitmap(blob); const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return size; } catch { return null; }
  },
  async scale(blob, mime) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    try {
      const bitmap = await createImageBitmap(blob);
      const factor = PICTURE_MAX_SIDE / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * factor)); canvas.height = Math.max(1, Math.round(bitmap.height * factor));
      const context = canvas.getContext('2d');
      if (!context) { bitmap.close(); return null; }
      if (mime === 'image/jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, 0.9));
    } catch { return null; }
  },
};

/**
 * A chosen, pasted or dropped file as a picture to post: PNG, JPEG or WebP, scaled so its longer side is at most
 * 1568 pixels (PNG stays PNG, anything else becomes JPEG), and at most 5 MiB after scaling.
 */
export async function preparePicture(file: File | Blob, name: string, scaler: PictureScaler = browserScaler): Promise<PreparedPicture> {
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) return { ok: false, reason: `${name} is not a PNG, JPEG or WebP image.` };
  if (!file.size) return { ok: false, reason: `${name} is empty.` };
  let blob: Blob = file, mime = file.type;
  const size = await scaler.size(file);
  if (size && Math.max(size.width, size.height) > PICTURE_MAX_SIDE) {
    const target = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const scaled = await scaler.scale(file, target);
    if (scaled) { blob = scaled; mime = target; }
  }
  if (blob.size > PICTURE_MAX_BYTES) return { ok: false, reason: `${name} is larger than 5 MB, even scaled down.` };
  const base = name.replace(/\.[A-Za-z0-9]+$/, '') || 'picture';
  const renamed = mime === file.type ? name : `${base}.${mime === 'image/png' ? 'png' : 'jpg'}`;
  return { ok: true, file: { kind: 'screenshot', name: renamed, mime, blob } };
}

/** The image files among dropped or pasted items. */
export function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(file => file.type.startsWith('image/'));
}
