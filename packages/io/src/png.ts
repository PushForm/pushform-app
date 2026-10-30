// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strToU8, unzlibSync, zlibSync } from 'fflate';

/** Longest side, in pixels, of a picture PushForm converts to PNG. */
export const PNG_MAX_PX = 4096;

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * An 8-bit RGB or RGBA PNG of `pixels` (rows top to bottom, `channels` bytes per pixel, unassociated alpha).
 * Each row uses the filter with the smallest sum of absolute differences, as libpng does by default.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter]!;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels]! : 0, above = up[i]!, corner = i >= channels ? up[i - channels]! : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >> 1 : paeth(left, above, corner);
        const value = (row[i]! - predicted) & 0xff;
        out[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { best = filter; bestScore = score; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best]!, y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** The pixels of an 8-bit, non-interlaced RGB or RGBA PNG, or null for any other kind or a damaged file. */
export function decodePng(bytes: Uint8Array): { width: number; height: number; channels: 3 | 4; pixels: Uint8Array } | null {
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (bytes[24] !== 8 || (bytes[25] !== 2 && bytes[25] !== 6) || bytes[28] !== 0 || !width || !height) return null;
  const channels = bytes[25] === 6 ? 4 : 3, stride = width * channels;
  const data: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  let raw: Uint8Array;
  try { raw = unzlibSync(concat(data)); } catch { return null; }
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride), up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels]! : 0, above = up ? up[i]! : 0, corner = up && i >= channels ? up[i - channels]! : 0;
      const predicted = filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >> 1 : filter === 4 ? paeth(left, above, corner) : 0;
      out[i] = (row[i]! + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * The PNG with every pixel within `tolerance` of one of `colors` (0xRRGGBB) made transparent, or null when it is not
 * an 8-bit RGB or RGBA PNG or no pixel matches.
 */
export function clearPngColors(bytes: Uint8Array, colors: readonly number[], tolerance = 0): Uint8Array | null {
  const image = decodePng(bytes);
  if (!image || !colors.length) return null;
  const { width, height, channels, pixels } = image;
  const rgba = new Uint8Array(width * height * 4);
  let cleared = 0;
  for (let p = 0, q = 0; p < width * height; p++, q += channels) {
    const [r, g, b] = [pixels[q]!, pixels[q + 1]!, pixels[q + 2]!], a = channels === 4 ? pixels[q + 3]! : 255;
    const match = a > 0 && colors.some(c => Math.abs(r - (c >>> 16 & 0xff)) <= tolerance && Math.abs(g - (c >>> 8 & 0xff)) <= tolerance && Math.abs(b - (c & 0xff)) <= tolerance);
    rgba.set(match ? [r, g, b, 0] : [r, g, b, a], p * 4);
    if (match) cleared++;
  }
  return cleared ? encodePng(width, height, rgba, 4) : null;
}

function paeth(left: number, above: number, corner: number): number {
  const estimate = left + above - corner;
  const toLeft = Math.abs(estimate - left), toAbove = Math.abs(estimate - above), toCorner = Math.abs(estimate - corner);
  return toLeft <= toAbove && toLeft <= toCorner ? left : toAbove <= toCorner ? above : corner;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
