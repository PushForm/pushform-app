// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { zlibSync } from 'fflate';
import { expect, it } from 'vitest';
import { pngIsBlank } from './pngBlank';

/** A minimal PNG; CRCs are left zero because the check does not read them. */
function png(width: number, height: number, colorType: 2 | 6, pixel: (x: number, y: number) => number[], filter = 0): Uint8Array {
  const bpp = colorType === 6 ? 4 : 3, rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(filter);
    const row = Array.from({ length: width }, (_, x) => pixel(x, y)).flat();
    // Sub filter: each byte minus the one a pixel to its left.
    rows.push(...row.map((v, i) => filter === 1 ? (v - (i >= bpp ? row[i - bpp]! : 0)) & 255 : v));
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set([...type].map(c => c.charCodeAt(0)), 4); out.set(data, 8);
    return out;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(new Uint8Array(rows))), chunk('IEND', new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

it('finds LayOut\'s blank raster renders: all transparent or one flat color', () => {
  expect(pngIsBlank(png(40, 30, 6, () => [12, 34, 56, 0]))).toBe(true);
  expect(pngIsBlank(png(40, 30, 6, (x, y) => [x, y, 0, 0], 1))).toBe(true);
  expect(pngIsBlank(png(40, 30, 2, () => [255, 255, 255]))).toBe(true);
  expect(pngIsBlank(png(40, 30, 6, (x, y) => (x === 39 && y === 29 ? [0, 0, 0, 255] : [255, 255, 255, 0])))).toBe(false);
  expect(pngIsBlank(png(40, 30, 2, (x, y) => (x === 20 && y === 3 ? [250, 255, 255] : [255, 255, 255]), 1))).toBe(false);
  expect(pngIsBlank(new Uint8Array([1, 2, 3]))).toBe(false);
});
