// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTiff, tiffToPng } from './tiff';

// Fixtures were written by Pillow 10.2 with libtiff from the patterns below.
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/tiff/${name}`, import.meta.url)));
const WIDTH = 8, HEIGHT = 6;
const pattern = (x: number, y: number): number[] => [(x * 30 + y) % 256, (y * 40 + x * 3) % 256, (x * y * 7) % 256, Math.min(255, 40 + (x + y) * 20)];
const expected = (pixel: (x: number, y: number) => number[], width = WIDTH, height = HEIGHT): number[] =>
  Array.from({ length: width * height }, (_, i) => pixel(i % width, Math.floor(i / width))).flat();
const gray = (x: number, y: number): number => (x * 30 + y * 5) % 256;

describe('TIFF decoding', () => {
  it('reads LZW with the horizontal predictor, Deflate with unassociated alpha, and PackBits gray', () => {
    expect([...decodeTiff(fixture('rgb-lzw-predictor.tif')).rgba]).toEqual(expected((x, y) => [...pattern(x, y).slice(0, 3), 255]));
    expect([...decodeTiff(fixture('rgba-deflate.tif')).rgba]).toEqual(expected(pattern));
    expect([...decodeTiff(fixture('gray-packbits.tif')).rgba]).toEqual(expected((x, y) => [gray(x, y), gray(x, y), gray(x, y), 255]));
  });

  it('reads 16-bit gray, 1-bit black and white, and palette images', () => {
    expect([...decodeTiff(fixture('gray16.tif')).rgba]).toEqual(expected((x, y) => [gray(x, y), gray(x, y), gray(x, y), 255]));
    const white = (x: number, y: number): number => (x + y) % 3 === 0 ? 255 : 0;
    expect([...decodeTiff(fixture('bilevel.tif')).rgba]).toEqual(expected((x, y) => [white(x, y), white(x, y), white(x, y), 255]));
    // Pillow's own reading of the palette image.
    const rgb = '0114003c06003c06003c060079200eb41200b41200b41200011400113e043e42133e421379200e7a4f2cb64e3db64e3d113e04113e043e42137a4f2c7a4f2cb64e3db64e3dbe8177127a0b127a0b2296175d8e445d8e44be8177be8177be81772296172296175d8e445fbd5d5fbd5d91c998c8c8cdc8c8cd14ca1214ca125fbd5d5fbd5d91c99891c998c8c8cdc8c8cd';
    const palette = rgb.match(/.{6}/g)!.flatMap((hex) => [...hex.match(/../g)!.map((byte) => parseInt(byte, 16)), 255]);
    expect([...decodeTiff(fixture('palette.tif')).rgba]).toEqual(palette);
  });

  it('reads LZW data long enough to widen its codes to 12 bits and clear the table', () => {
    const noise = (x: number, y: number): number[] => [0, 1, 2].map((c) => ((x * 73 + y * 151 + c * 37) ^ (x * y)) & 255);
    expect([...decodeTiff(fixture('noise-lzw.tif')).rgba]).toEqual(expected((x, y) => [...noise(x, y), 255], 64, 64));
  });

  it('reads big-endian, tiled, planar images with associated alpha', () => {
    // 3 × 2 RGBA in one 16 × 16 tile per plane; alpha is premultiplied into the color.
    const pixels = [[200, 100, 50, 255], [100, 50, 26, 128], [0, 0, 0, 0], [10, 20, 30, 255], [255, 255, 255, 255], [64, 32, 16, 64]];
    const tile = 16 * 16;
    const tags: [number, number[]][] = [
      [256, [3]], [257, [2]], [258, [8, 8, 8, 8]], [259, [1]], [262, [2]], [277, [4]], [284, [2]],
      [322, [16]], [323, [16]], [324, [0, 0, 0, 0]], [325, [tile, tile, tile, tile]], [338, [1]],
    ];
    // Header, then the directory with every value as a LONG, then values that do not fit an entry, then the tiles.
    const valuesAt = 8 + 2 + tags.length * 12 + 4;
    const tilesAt = valuesAt + tags.reduce((sum, [, values]) => sum + (values.length > 1 ? values.length * 4 : 0), 0);
    tags[9]![1] = [0, 1, 2, 3].map((plane) => tilesAt + plane * tile);
    const bytes = new Uint8Array(tilesAt + 4 * tile);
    const view = new DataView(bytes.buffer);
    bytes.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
    view.setUint16(8, tags.length);
    let next = valuesAt;
    tags.forEach(([tag, values], index) => {
      const entry = 10 + index * 12;
      view.setUint16(entry, tag); view.setUint16(entry + 2, 4); view.setUint32(entry + 4, values.length);
      const at = values.length > 1 ? next : entry + 8;
      if (values.length > 1) { view.setUint32(entry + 8, at); next += values.length * 4; }
      values.forEach((value, i) => view.setUint32(at + i * 4, value));
    });
    pixels.forEach((pixel, i) => pixel.forEach((value, plane) => { bytes[tilesAt + plane * tile + Math.floor(i / 3) * 16 + i % 3] = value; }));
    expect([...decodeTiff(bytes).rgba]).toEqual([200, 100, 50, 255, 199, 100, 52, 128, 0, 0, 0, 0, 10, 20, 30, 255, 255, 255, 255, 255, 255, 128, 64, 64]);
  });

  it('reports compressions it cannot read', () => {
    expect(() => decodeTiff(fixture('jpeg.tif'))).toThrow('TIFF images compressed with JPEG are not supported');
    expect(() => decodeTiff(fixture('bilevel-g4.tif'))).toThrow('TIFF images compressed with CCITT fax are not supported');
    expect(() => decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('a TIFF image could not be read');
  });

  it('converts to PNG, without alpha when opaque, at most the given size on the longer side', () => {
    const header = (png: Uint8Array): number[] => {
      const view = new DataView(png.buffer, png.byteOffset);
      return [view.getUint32(16), view.getUint32(20), png[25]!];
    };
    expect(header(tiffToPng(fixture('rgb-lzw-predictor.tif')))).toEqual([8, 6, 2]);
    expect(header(tiffToPng(fixture('rgba-deflate.tif')))).toEqual([8, 6, 6]);
    expect(header(tiffToPng(fixture('noise-lzw.tif'), 16))).toEqual([16, 16, 2]);
  });
});
