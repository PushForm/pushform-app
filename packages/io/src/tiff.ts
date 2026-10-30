// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { unzlibSync } from 'fflate';
import { encodePng, PNG_MAX_PX } from './png';

/**
 * A baseline TIFF reader for pictures placed in LayOut documents. It reads the first image of a TIFF in
 * either byte order, in strips or tiles, chunky or planar, uncompressed or compressed with LZW, Deflate or PackBits,
 * with or without the horizontal predictor: 1–16 bit gray, palette, RGB and CMYK, with an alpha channel when present.
 * JPEG, CCITT fax and other compressions, YCbCr, floating-point samples and BigTIFF are reported as unsupported.
 */

/** Why a TIFF cannot be read, worded as an import warning. */
export class TiffError extends Error {}

/** A decoded picture: 8-bit RGBA, unassociated alpha, rows top to bottom. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const COMPRESSION_NAMES: Record<number, string> = {
  2: 'CCITT', 3: 'CCITT fax', 4: 'CCITT fax', 6: 'JPEG', 7: 'JPEG', 34661: 'JBIG', 34712: 'JPEG 2000', 34887: 'LERC', 50000: 'Zstandard', 50001: 'WebP',
};
const NONE = 1, LZW = 5, DEFLATE = 8, DEFLATE_ADOBE = 32946, PACKBITS = 32773;
const WHITE_IS_ZERO = 0, BLACK_IS_ZERO = 1, RGB = 2, PALETTE = 3, CMYK = 5;
const ALPHA_ASSOCIATED = 1, ALPHA_UNASSOCIATED = 2;

/** The TIFF's first image as PNG, reduced to at most `maxPx` on its longer side. */
export function tiffToPng(bytes: Uint8Array, maxPx = PNG_MAX_PX): Uint8Array {
  let image = decodeTiff(bytes);
  const scale = maxPx / Math.max(image.width, image.height);
  if (scale < 1) image = downsample(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const { width, height, rgba } = image;
  let opaque = true;
  for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
  if (!opaque) return encodePng(width, height, rgba, 4);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]!; rgb[j + 1] = rgba[i + 1]!; rgb[j + 2] = rgba[i + 2]!; }
  return encodePng(width, height, rgb, 3);
}

export function decodeTiff(bytes: Uint8Array): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = bytes[0] === 0x49 && bytes[1] === 0x49 ? true : bytes[0] === 0x4d && bytes[1] === 0x4d ? false : null;
  if (order === null || bytes.length < 8) throw new TiffError('a TIFF image could not be read');
  const littleEndian = order;
  const magic = view.getUint16(2, littleEndian);
  if (magic === 43) throw new TiffError('BigTIFF images are not supported');
  if (magic !== 42) throw new TiffError('a TIFF image could not be read');

  const tags = new Map<number, number[]>();
  const ifd = view.getUint32(4, littleEndian);
  const count = view.getUint16(ifd, littleEndian);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    const tag = view.getUint16(entry, littleEndian), type = view.getUint16(entry + 2, littleEndian);
    // Only BYTE, SHORT and LONG values matter here.
    if (type !== 1 && type !== 3 && type !== 4) continue;
    const length = view.getUint32(entry + 4, littleEndian), size = type === 1 ? 1 : type === 3 ? 2 : 4;
    const at = size * length <= 4 ? entry + 8 : view.getUint32(entry + 8, littleEndian);
    const values: number[] = [];
    for (let i = 0; i < length; i++) {
      values.push(type === 1 ? view.getUint8(at + i) : type === 3 ? view.getUint16(at + i * 2, littleEndian) : view.getUint32(at + i * 4, littleEndian));
    }
    tags.set(tag, values);
  }
  const first = (tag: number, fallback: number): number => tags.get(tag)?.[0] ?? fallback;

  const width = first(256, 0), height = first(257, 0);
  if (!width || !height) throw new TiffError('a TIFF image could not be read');
  const compression = first(259, NONE), photometric = first(262, -1);
  const samplesPerPixel = first(277, 1), bits = first(258, 1), planar = first(284, 1), predictor = first(317, 1);
  if (![NONE, LZW, DEFLATE, DEFLATE_ADOBE, PACKBITS].includes(compression)) {
    throw new TiffError(`TIFF images compressed with ${COMPRESSION_NAMES[compression] ?? `method ${compression}`} are not supported`);
  }
  if (first(339, 1) !== 1 && first(339, 1) !== 2) throw new TiffError('TIFF images with floating-point samples are not supported');
  if (![1, 2, 4, 8, 16].includes(bits) || (tags.get(258) ?? []).some((value) => value !== bits)) throw new TiffError(`TIFF images with ${bits}-bit samples are not supported`);
  if (![WHITE_IS_ZERO, BLACK_IS_ZERO, RGB, PALETTE, CMYK].includes(photometric)) throw new TiffError('TIFF images in this color space are not supported');
  if (predictor !== 1 && (predictor !== 2 || bits < 8)) throw new TiffError('TIFF images with this predictor are not supported');
  const colors = photometric === RGB ? 3 : photometric === CMYK ? 4 : 1;
  if (samplesPerPixel < colors || (photometric === PALETTE && bits > 8)) throw new TiffError('a TIFF image could not be read');

  // Chunks are strips or tiles, plane by plane when planar.
  const tiled = tags.has(322);
  const chunkWidth = tiled ? first(322, width) : width;
  const chunkHeight = tiled ? first(323, height) : Math.min(first(278, height), height);
  const offsets = tags.get(tiled ? 324 : 273) ?? [], byteCounts = tags.get(tiled ? 325 : 279) ?? [];
  const across = Math.ceil(width / chunkWidth), down = Math.ceil(height / chunkHeight);
  const planes = planar === 2 ? samplesPerPixel : 1, chunkSamples = planar === 2 ? 1 : samplesPerPixel;
  const rowBytes = Math.ceil(chunkWidth * chunkSamples * bits / 8);
  const palette = photometric === PALETTE;
  const maxValue = (1 << bits) - 1;

  // Samples at 8 bits (palette indexes as stored), pixel by pixel.
  const samples = new Uint8Array(width * height * samplesPerPixel);
  for (let plane = 0; plane < planes; plane++) {
    for (let chunkY = 0; chunkY < down; chunkY++) {
      for (let chunkX = 0; chunkX < across; chunkX++) {
        const index = plane * across * down + chunkY * across + chunkX;
        const offset = offsets[index], byteCount = byteCounts[index];
        if (offset === undefined || offset >= bytes.length) continue;
        const y0 = chunkY * chunkHeight, x0 = chunkX * chunkWidth;
        const rows = tiled ? chunkHeight : Math.min(chunkHeight, height - y0);
        const input = bytes.subarray(offset, byteCount === undefined ? bytes.length : Math.min(bytes.length, offset + byteCount));
        const data = decompress(input, compression, rowBytes * rows);
        if (predictor === 2) undoPredictor(data, rowBytes, rows, chunkSamples, bits, littleEndian);
        const validRows = Math.min(rows, height - y0), validColumns = Math.min(chunkWidth, width - x0);
        for (let row = 0; row < validRows; row++) {
          const rowStart = row * rowBytes;
          for (let column = 0; column < validColumns; column++) {
            const target = ((y0 + row) * width + x0 + column) * samplesPerPixel + plane;
            for (let sample = 0; sample < chunkSamples; sample++) {
              const position = column * chunkSamples + sample;
              let value: number;
              if (bits === 8) value = data[rowStart + position] ?? 0;
              else if (bits === 16) value = data[rowStart + position * 2 + (littleEndian ? 1 : 0)] ?? 0;
              else {
                const bit = position * bits;
                value = ((data[rowStart + (bit >> 3)] ?? 0) >> (8 - bits - (bit & 7))) & maxValue;
                if (!palette) value = Math.round(value * 255 / maxValue);
              }
              samples[target + sample] = value;
            }
          }
        }
      }
    }
  }

  // The first extra sample is alpha when the file says so.
  const alpha = samplesPerPixel > colors ? (tags.get(338)?.[0] ?? 0) : 0;
  const map = tags.get(320) ?? [];
  const entries = 1 << bits;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0, source = 0; pixel < rgba.length; pixel += 4, source += samplesPerPixel) {
    const value = samples[source]!;
    if (photometric === RGB) rgba.set(samples.subarray(source, source + 3), pixel);
    else if (photometric === CMYK) {
      const black = 255 - samples[source + 3]!;
      for (let channel = 0; channel < 3; channel++) rgba[pixel + channel] = Math.round((255 - samples[source + channel]!) * black / 255);
    } else if (palette) {
      for (let channel = 0; channel < 3; channel++) rgba[pixel + channel] = (map[channel * entries + value] ?? 0) >> 8;
    } else rgba.fill(photometric === WHITE_IS_ZERO ? 255 - value : value, pixel, pixel + 3);
    const opacity = alpha === ALPHA_ASSOCIATED || alpha === ALPHA_UNASSOCIATED ? samples[source + colors]! : 255;
    rgba[pixel + 3] = opacity;
    if (alpha === ALPHA_ASSOCIATED && opacity > 0 && opacity < 255) {
      for (let channel = 0; channel < 3; channel++) rgba[pixel + channel] = Math.min(255, Math.round(rgba[pixel + channel]! * 255 / opacity));
    }
  }
  return { width, height, rgba };
}

function decompress(input: Uint8Array, compression: number, expected: number): Uint8Array {
  let data: Uint8Array;
  if (compression === LZW) data = lzw(input, expected);
  else if (compression === PACKBITS) data = packBits(input, expected);
  else if (compression === DEFLATE || compression === DEFLATE_ADOBE) data = unzlibSync(input);
  else data = input;
  if (data.length >= expected && data !== input) return data;
  // Short or uncompressed data is copied so the predictor never writes into the file.
  const out = new Uint8Array(expected);
  out.set(data.subarray(0, expected));
  return out;
}

/** TIFF LZW: MSB-first codes from 9 to 12 bits, widening one code early. */
function lzw(input: Uint8Array, expected: number): Uint8Array {
  const CLEAR = 256, END = 257;
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), head = new Uint8Array(4096), length = new Uint16Array(4096);
  for (let code = 0; code < 256; code++) { prefix[code] = -1; suffix[code] = code; head[code] = code; length[code] = 1; }
  let next = 258, width = 9, bit = 0, written = 0, previous = -1;
  const totalBits = input.length * 8;
  const read = (): number => {
    if (bit + width > totalBits) return END;
    const at = bit >> 3;
    const window = ((input[at] ?? 0) << 16) | ((input[at + 1] ?? 0) << 8) | (input[at + 2] ?? 0);
    bit += width;
    return (window >> (24 - width - ((bit - width) & 7))) & ((1 << width) - 1);
  };
  const emit = (code: number): void => {
    const size = length[code]!;
    let at = written + size - 1;
    for (let c = code; c >= 0; c = prefix[c]!, at--) if (at < expected) out[at] = suffix[c]!;
    written += size;
  };
  const add = (from: number, byte: number): void => {
    if (next >= 4096) return;
    prefix[next] = from; suffix[next] = byte; head[next] = head[from]!; length[next] = length[from]! + 1;
    next++;
    if (next >= (1 << width) - 1 && width < 12) width++;
  };
  while (written < expected) {
    const code = read();
    if (code === END) break;
    if (code === CLEAR) { next = 258; width = 9; previous = -1; continue; }
    if (previous < 0) {
      if (code > 255) break;
      emit(code);
    } else if (code < next) {
      emit(code);
      add(previous, head[code]!);
    } else if (code === next) {
      add(previous, head[previous]!);
      emit(code);
    } else break;
    previous = code;
  }
  return out;
}

function packBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let at = 0, written = 0;
  while (at < input.length && written < expected) {
    const header = (input[at++]! << 24) >> 24;
    if (header >= 0) {
      const run = input.subarray(at, at + header + 1).subarray(0, expected - written);
      out.set(run, written); written += run.length; at += header + 1;
    } else if (header !== -128) {
      const run = Math.min(1 - header, expected - written);
      out.fill(input[at++] ?? 0, written, written + run); written += run;
    }
  }
  return out;
}

/** Horizontal differencing (predictor 2) on 8- and 16-bit samples, in place. */
function undoPredictor(data: Uint8Array, rowBytes: number, rows: number, samples: number, bits: number, littleEndian: boolean): void {
  for (let row = 0; row < rows; row++) {
    const start = row * rowBytes;
    if (bits === 8) {
      for (let i = start + samples; i < start + rowBytes; i++) data[i] = (data[i]! + data[i - samples]!) & 0xff;
    } else {
      const view = new DataView(data.buffer, data.byteOffset + start, rowBytes);
      for (let i = samples * 2; i + 1 < rowBytes; i += 2) view.setUint16(i, view.getUint16(i, littleEndian) + view.getUint16(i - samples * 2, littleEndian), littleEndian);
    }
  }
}

/** Box-filtered reduction, weighting color by alpha so transparent pixels do not darken edges. */
function downsample(image: RgbaImage, width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  const scaleX = image.width / width, scaleY = image.height / height;
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y * scaleY), bottom = Math.max(top + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x * scaleX), right = Math.max(left + 1, Math.floor((x + 1) * scaleX));
      let red = 0, green = 0, blue = 0, opacity = 0, count = 0;
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const at = (sy * image.width + sx) * 4, a = image.rgba[at + 3]!;
          red += image.rgba[at]! * a; green += image.rgba[at + 1]! * a; blue += image.rgba[at + 2]! * a; opacity += a; count++;
        }
      }
      const at = (y * width + x) * 4;
      if (opacity > 0) { rgba[at] = Math.round(red / opacity); rgba[at + 1] = Math.round(green / opacity); rgba[at + 2] = Math.round(blue / opacity); }
      rgba[at + 3] = Math.round(opacity / count);
    }
  }
  return { width, height, rgba };
}
