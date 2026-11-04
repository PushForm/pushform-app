// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * A picture's stored resolution in pixels per inch, horizontal and vertical: a PNG's pHYs chunk in pixels per
 * meter, or a JPEG's JFIF density in dots per inch or centimeter, else its Exif XResolution and YResolution.
 * Null when the picture stores none (or only an aspect ratio).
 */
export function imagePixelsPerInch(bytes: Uint8Array): [number, number] | null {
  const n = bytes.length;
  const u32 = (i: number) => ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const valid = (x: number, y: number): [number, number] | null => x > 0 && y > 0 && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  if (n >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // Chunks before the image data: length, type, data, CRC.
    for (let i = 8; i + 8 <= n;) {
      const length = u32(i), type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
      if (type === 'pHYs' && length >= 9 && i + 17 <= n) return bytes[i + 16] === 1 ? valid(u32(i + 8) * 0.0254, u32(i + 12) * 0.0254) : null;
      if (type === 'IDAT' || type === 'IEND') return null;
      i += 12 + length;
    }
    return null;
  }
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let exif: [number, number] | null = null;
  for (let i = 2; i + 4 <= n;) {
    if (bytes[i] !== 0xff) return exif;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    // Start of scan: no more metadata segments.
    if (marker === 0xda) return exif;
    const length = u16(i + 2), data = i + 4;
    if (marker === 0xe0 && length >= 16 && String.fromCharCode(...bytes.subarray(data, data + 5)) === 'JFIF\0') {
      const units = bytes[data + 7], x = u16(data + 8), y = u16(data + 10);
      if (units === 1) return valid(x, y);
      if (units === 2) return valid(x * 2.54, y * 2.54);
    }
    if (marker === 0xe1 && length >= 16 && String.fromCharCode(...bytes.subarray(data, data + 6)) === 'Exif\0\0') exif ??= exifResolution(bytes.subarray(data + 6, i + 2 + length));
    i += 2 + length;
  }
  return exif;
}

/** XResolution and YResolution of a TIFF header's first image directory, per ResolutionUnit (2 inch, 3 centimeter). */
function exifResolution(tiff: Uint8Array): [number, number] | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (i: number) => i + 2 <= tiff.length ? view.getUint16(i, little) : 0;
  const u32 = (i: number) => i + 4 <= tiff.length ? view.getUint32(i, little) : 0;
  const ifd = u32(4), count = u16(ifd);
  let x = 0, y = 0, unit = 2;
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12, tag = u16(entry);
    const rational = () => { const at = u32(entry + 8), d = u32(at + 4); return d ? u32(at) / d : 0; };
    if (tag === 0x011a) x = rational();
    else if (tag === 0x011b) y = rational();
    else if (tag === 0x0128) unit = u16(entry + 8);
  }
  const perInch = unit === 3 ? 2.54 : unit === 2 ? 1 : 0;
  return x > 0 && y > 0 && perInch ? [x * perInch, y * perInch] : null;
}
