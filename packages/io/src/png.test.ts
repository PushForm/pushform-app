// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { clearPngColors, decodePng, encodePng } from './png';

describe('PNG encoding', () => {
  it.each([3, 4] as const)('round-trips %i-channel pixels through every row filter', (channels) => {
    const width = 23, height = 17;
    const pixels = new Uint8Array(width * height * channels);
    // Smooth areas, edges and noise, so rows choose different filters.
    for (let i = 0; i < pixels.length; i++) {
      const x = (i / channels | 0) % width, y = i / channels / width | 0;
      pixels[i] = y < 6 ? x * 9 : y < 12 ? (x > 11 ? 200 : 10) : (i * 2654435761) >>> 24;
    }
    const png = encodePng(width, height, pixels, channels);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({ width, height, channels });
    expect(decoded!.pixels).toEqual(pixels);
  });

  it('reads only 8-bit RGB and RGBA PNGs', () => {
    const png = encodePng(1, 1, new Uint8Array([1, 2, 3]), 3);
    expect(decodePng(png.slice(0, 20))).toBeNull();
    const sixteenBit = png.slice(); sixteenBit[24] = 16;
    expect(decodePng(sixteenBit)).toBeNull();
  });
});

describe('clearing colors', () => {
  it('makes pixels of the given colors transparent and keeps the rest', () => {
    // sky, background, a near-sky pixel, a face, and an already transparent pixel
    const rgba = new Uint8Array([198, 205, 208, 255, 204, 204, 201, 255, 199, 205, 208, 255, 255, 255, 255, 255, 198, 205, 208, 0]);
    const cleared = clearPngColors(encodePng(5, 1, rgba, 4), [0xc6cdd0, 0xccccc9]);
    expect([...decodePng(cleared!)!.pixels]).toEqual([198, 205, 208, 0, 204, 204, 201, 0, 199, 205, 208, 255, 255, 255, 255, 255, 198, 205, 208, 0]);
    const near = clearPngColors(encodePng(5, 1, rgba, 4), [0xc6cdd0], 1);
    expect(decodePng(near!)!.pixels[11]).toBe(0);
  });

  it('returns null when nothing matches or the PNG cannot be read', () => {
    const rgb = encodePng(2, 1, new Uint8Array([10, 20, 30, 40, 50, 60]), 3);
    expect(clearPngColors(rgb, [0xffffff])).toBeNull();
    expect(clearPngColors(rgb, [])).toBeNull();
    expect(clearPngColors(new Uint8Array([1, 2, 3]), [0])).toBeNull();
    expect(decodePng(clearPngColors(rgb, [0x0a141e])!)!.channels).toBe(4);
  });
});
