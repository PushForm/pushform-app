// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Unzlib } from 'fflate';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Whether an 8-bit RGB or RGBA PNG draws nothing: every pixel transparent, or more than one pixel all the same color.
 * LayOut sometimes saves a viewport's raster render blank and renders the view again from its model.
 * Reading stops at the first pixel that shows content. Other PNG kinds report false.
 */
export function pngIsBlank(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  const depth = bytes[24], colorType = bytes[25], interlace = bytes[28];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0 || !width || !height) return false;
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  let previous = new Uint8Array(stride), current = new Uint8Array(stride);
  let filter = -1, column = 0, rows = 0, content = false, transparent = colorType === 6, uniform = width * height > 1;
  const first = new Uint8Array(bpp);
  const finishRow = (): void => {
    for (let x = 0; x < stride; x += bpp) {
      if (transparent && current[x + 3] !== 0) transparent = false;
      if (uniform) {
        if (rows === 0 && x === 0) first.set(current.subarray(0, bpp));
        else for (let k = 0; k < bpp; k++) if (current[x + k] !== first[k]) { uniform = false; break; }
      }
      if (!transparent && !uniform) { content = true; return; }
    }
    [previous, current] = [current, previous];
    rows++; filter = -1; column = 0;
  };
  const inflate = new Unzlib(chunk => {
    for (let i = 0; i < chunk.length && !content && rows < height; i++) {
      if (filter < 0) { filter = chunk[i]!; continue; }
      const raw = chunk[i]!, left = column >= bpp ? current[column - bpp]! : 0, up = previous[column]!;
      const corner = column >= bpp ? previous[column - bpp]! : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
      }
      current[column++] = value & 255;
      if (column === stride) finishRow();
    }
  });
  const data: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  try {
    for (let i = 0; i < data.length && !content && rows < height; i++) inflate.push(data[i]!, i === data.length - 1);
  } catch {
    return false;
  }
  return !content && rows === height;
}
