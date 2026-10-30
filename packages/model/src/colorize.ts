// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Texture colorization. Each pixel moves in hue, lightness and saturation (HLS) by the difference between the
 * material color and the texture's average color:
 *
 * - hue: `shift` adds the hue difference; `tint` replaces the hue with the material color's;
 * - lightness: adds the lightness difference, clamped to 0..1;
 * - saturation: adds the saturation difference, clamped, except that a material color less saturated than the
 *   average scales saturation by their ratio, so a gray material color makes the texture gray.
 *
 * The average is the per-channel pixel mean, truncated to whole 0..255 values, as `Texture#average_color` reports.
 */
export type ColorizeType = 'shift' | 'tint';
export type Rgb255 = readonly [number, number, number];

interface Hls { h: number; l: number; s: number }

/** HLS of an RGB color in 0..255: hue in degrees (0 for grays), lightness and saturation in 0..1. */
export function rgbToHls(r: number, g: number, b: number): Hls {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  if (max === min) return { h: 0, l, s: 0 };
  const d = max - min;
  const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, l, s };
}

function hueChannel(m1: number, m2: number, h: number): number {
  h -= 360 * Math.floor(h / 360);
  if (h < 60) return m1 + (m2 - m1) * h / 60;
  if (h < 180) return m2;
  if (h < 240) return m1 + (m2 - m1) * (240 - h) / 60;
  return m1;
}

/** RGB in 0..255 (rounded) of an HLS color. */
export function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  const packed = hlsToPacked(h, l, s);
  return [packed >> 16, (packed >> 8) & 255, packed & 255];
}

/** RGB of an HLS color packed as 0xRRGGBB, without allocating. */
function hlsToPacked(h: number, l: number, s: number): number {
  if (s === 0) { const v = Math.round(l * 255); return (v << 16) | (v << 8) | v; }
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
  return (Math.round(hueChannel(m1, m2, h + 120) * 255) << 16) | (Math.round(hueChannel(m1, m2, h) * 255) << 8) |
    Math.round(hueChannel(m1, m2, h - 120) * 255);
}

/** Entries of the direct-mapped cache of converted colors: bounded memory however many colors a photo has. */
const CACHE_SIZE = 1 << 16;

/** The texture's average color: the per-channel mean of its RGBA pixels, truncated. */
export function textureAverage(pixels: ArrayLike<number>): [number, number, number] {
  let r = 0, g = 0, b = 0;
  const n = Math.floor(pixels.length / 4);
  for (let i = 0; i < n * 4; i += 4) { r += pixels[i]!; g += pixels[i + 1]!; b += pixels[i + 2]!; }
  return n ? [Math.floor(r / n), Math.floor(g / n), Math.floor(b / n)] : [0, 0, 0];
}

/** Colorize RGBA pixels in place toward `color` (0..255), keeping alpha. */
export function colorizePixels(pixels: Uint8ClampedArray, color: Rgb255, type: ColorizeType,
  average: Rgb255 = textureAverage(pixels)): void {
  const target = rgbToHls(color[0], color[1], color[2]), avg = rgbToHls(average[0], average[1], average[2]);
  const dh = target.h - avg.h, dl = target.l - avg.l, ds = target.s - avg.s;
  const scale = ds < 0 && avg.s > 0 ? target.s / avg.s : null, tint = type === 'tint';
  // Textures repeat colors: a direct-mapped cache converts most of them once, in bounded memory.
  const keys = new Int32Array(CACHE_SIZE).fill(-1), values = new Int32Array(CACHE_SIZE);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!, key = (r << 16) | (g << 8) | b;
    const slot = Math.imul(key, 0x9e3779b1) >>> 16;
    let out: number;
    if (keys[slot] === key) out = values[slot]!;
    else {
      // rgbToHls, inlined to allocate nothing per pixel.
      const R = r / 255, G = g / 255, B = b / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min, pl = (max + min) / 2;
      let ph = 0, ps = 0;
      if (d > 0) {
        ps = pl <= 0.5 ? d / (max + min) : d / (2 - max - min);
        ph = 60 * (max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4);
      }
      const l = Math.min(1, Math.max(0, pl + dl));
      const s = scale === null ? Math.min(1, Math.max(0, ps + ds)) : ps * scale;
      out = hlsToPacked(tint ? target.h : ph + dh, l, s);
      keys[slot] = key; values[slot] = out;
    }
    pixels[i] = out >> 16; pixels[i + 1] = (out >> 8) & 255; pixels[i + 2] = out & 255;
  }
}
