// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { colorizePixels, hlsToRgb, rgbToHls, textureAverage } from './colorize';
import { SKETCHUP_COLORIZE_CASES } from './colorize.fixture';

const fixture = { cases: SKETCHUP_COLORIZE_CASES };

/** CIE76 color difference of two sRGB colors (0..255). */
function deltaE(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const lab = (c: ArrayLike<number>): number[] => {
    const lin = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const [r, g, b] = [lin(c[0]!), lin(c[1]!), lin(c[2]!)];
    const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}

it('reproduces SketchUp\'s shift and tint colorization of test textures within a small color difference', () => {
  expect(fixture.cases).toHaveLength(54);
  let total = 0, count = 0;
  for (const c of fixture.cases) {
    const pairs = c.pixels.split(' ');
    const pixels = new Uint8ClampedArray(pairs.length * 4);
    pairs.forEach((pair, i) => { for (let k = 0; k < 3; k++) pixels[i * 4 + k] = parseInt(pair.slice(k * 2, k * 2 + 2), 16); pixels[i * 4 + 3] = 255; });
    colorizePixels(pixels, c.color, c.type, c.average);
    let worst = 0;
    pairs.forEach((pair, i) => {
      const expected = [0, 1, 2].map(k => parseInt(pair.slice(6 + k * 2, 8 + k * 2), 16));
      const e = deltaE(pixels.subarray(i * 4, i * 4 + 3), expected);
      worst = Math.max(worst, e); total += e; count++;
    });
    expect(worst, c.name).toBeLessThan(3.5);
  }
  expect(total / count).toBeLessThan(0.6);
});

it('keeps alpha and makes a gray material color gray', () => {
  const pixels = new Uint8ClampedArray([200, 120, 40, 128, 90, 60, 30, 255]);
  colorizePixels(pixels, [128, 128, 128], 'shift');
  expect(pixels[3]).toBe(128); expect(pixels[7]).toBe(255);
  expect(pixels[0]).toBe(pixels[1]); expect(pixels[1]).toBe(pixels[2]);
});

it('averages pixels per channel and truncates, as SketchUp reports a texture\'s average color', () => {
  expect(textureAverage(new Uint8ClampedArray([10, 20, 30, 255, 11, 21, 32, 0]))).toEqual([10, 20, 31]);
  expect(textureAverage(new Uint8ClampedArray(0))).toEqual([0, 0, 0]);
});

it('converts between RGB and HLS', () => {
  expect(rgbToHls(210, 180, 140).h).toBeCloseTo(34.2857, 3);
  expect(rgbToHls(210, 180, 140).s).toBeCloseTo(0.4375, 4);
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 30, 30], [40, 80, 200], [12, 250, 99]] as const) {
    const { h, l, s } = rgbToHls(c[0], c[1], c[2]);
    expect(hlsToRgb(h, l, s)).toEqual(c);
  }
});
