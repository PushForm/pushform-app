// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId } from '@pushform/core';
import type { ImageAsset } from './entities/attrs';

/**
 * Runtime store of image bytes (texture images, image entities). The immutable document state
 * only holds `ImageAsset` descriptors (name, mime, size, content hash); the bytes live here and
 * in the file package. Not undoable: bytes of assets removed by undo stay cached until `remove`.
 */

export interface ImageBlob {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export interface ImageDescription {
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface ImagePutOptions {
  /** Document id to register the asset under; a runtime id (≥ 2^30) is allocated when omitted. */
  readonly id?: ImageId | undefined;
  /** Pixel size when known (skips decoding). */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface ImageEntry {
  readonly asset: ImageAsset;
  readonly blob: ImageBlob;
}

/** First runtime-only id (assets that were never written to a document). */
export const RUNTIME_IMAGE_ID_BASE = 1 << 30;

const HEX = '0123456789abcdef';

function toHex(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return s;
}

/** Two 32-bit FNV-1a passes with different seeds → 16 hex chars (synchronous fallback hash). */
export function fastHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!;
    a = Math.imul(a ^ v, 0x01000193) >>> 0;
    b = Math.imul(b ^ v, 0x01000193) >>> 0;
  }
  // mix in the length so empty prefixes of a longer image never collide
  a = Math.imul(a ^ bytes.length, 0x01000193) >>> 0;
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** SHA-256 of `bytes` via WebCrypto when available, else `fastHash`. */
export async function hashImageBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await subtle.digest('SHA-256', copy);
      return toHex(new Uint8Array(digest));
    } catch {
      // fall through
    }
  }
  return fastHash(bytes);
}

/** Pixel size from the PNG IHDR / JPEG SOF / GIF / BMP header without decoding, or null. */
export function imageSizeFromHeader(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  const u32 = (i: number) => ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  // PNG: signature + IHDR
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  // GIF: 6-byte header, little-endian size
  if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  // BMP: 14-byte file header, then a BITMAPINFOHEADER with little-endian signed width and height
  // (a negative height marks a top-down bitmap)
  if (n >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const i32 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    return { width: Math.abs(i32(18)), height: Math.abs(i32(22)) };
  }
  // JPEG: scan markers for SOFn
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: u16(i + 7), height: u16(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Base64 of raw bytes (works in browsers and Node). */
export function bytesToBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** Raw bytes of a base64 string (a `data:` URL prefix is stripped). */
export function base64ToBytes(b64: string): Uint8Array {
  const comma = b64.indexOf(',');
  const data = b64.startsWith('data:') && comma >= 0 ? b64.slice(comma + 1) : b64;
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(data, 'base64'));
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class ImageStore {
  private entries_ = new Map<ImageId, ImageEntry>();
  private byHash = new Map<string, ImageId>();
  private urls = new Map<ImageId, string>();
  private nextRuntimeId = RUNTIME_IMAGE_ID_BASE;

  /** Hash + pixel size of an image (size from the header, else `createImageBitmap`, else `opts`/0). */
  async describe(bytes: Uint8Array, mime: string, opts: Pick<ImagePutOptions, 'width' | 'height'> = {}): Promise<ImageDescription> {
    const sha256 = await hashImageBytes(bytes);
    let width = opts.width ?? 0, height = opts.height ?? 0;
    if (!width || !height) {
      const hdr = imageSizeFromHeader(bytes);
      if (hdr) ({ width, height } = hdr);
      else {
        const size = await decodeImageSize(bytes, mime);
        if (size) ({ width, height } = size);
      }
    }
    return { sha256, width, height };
  }

  /** Store the bytes of a document asset (no hashing; the asset's `sha256` is trusted). */
  register(asset: ImageAsset, bytes: Uint8Array, mime = asset.mime): ImageAsset {
    const prev = this.entries_.get(asset.id);
    if (prev) this.revoke(asset.id);
    this.entries_.set(asset.id, { asset, blob: { bytes, mime } });
    if (asset.sha256) this.byHash.set(asset.sha256, asset.id);
    return asset;
  }

  /**
   * Add an image: hashes the bytes, returns the existing asset when the same content is already
   * stored (dedupe), else decodes its size and registers a new asset under `opts.id` (or a
   * runtime id). Callers that write the asset into a document pass the allocated document id.
   */
  async put(bytes: Uint8Array, mime: string, name: string, opts: ImagePutOptions = {}): Promise<ImageAsset> {
    const d = await this.describe(bytes, mime, opts);
    const dup = this.byHash.get(d.sha256);
    if (dup !== undefined) {
      const e = this.entries_.get(dup);
      if (e) return e.asset;
    }
    const id = opts.id ?? (this.nextRuntimeId++ as ImageId);
    const asset: ImageAsset = { id, name, mime, width: d.width, height: d.height, sha256: d.sha256 };
    return this.register(asset, bytes, mime);
  }

  /** Id of the stored image with this content hash, if any. */
  findByHash(sha256: string): ImageId | undefined {
    return this.byHash.get(sha256);
  }

  has(id: ImageId): boolean {
    return this.entries_.has(id);
  }
  get(id: ImageId): ImageBlob | undefined {
    return this.entries_.get(id)?.blob;
  }
  asset(id: ImageId): ImageAsset | undefined {
    return this.entries_.get(id)?.asset;
  }
  get size(): number {
    return this.entries_.size;
  }
  entries(): IterableIterator<[ImageId, ImageEntry]> {
    return this.entries_.entries();
  }

  /** `blob:` URL for the image (browser) — falls back to a data URL where `URL.createObjectURL` is missing. */
  objectUrl(id: ImageId): string | undefined {
    const cached = this.urls.get(id);
    if (cached) return cached;
    const e = this.entries_.get(id);
    if (!e) return undefined;
    let url: string;
    const U = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL;
    if (typeof Blob !== 'undefined' && U?.createObjectURL) {
      const copy = new Uint8Array(e.blob.bytes.byteLength);
      copy.set(e.blob.bytes);
      url = U.createObjectURL(new Blob([copy], { type: e.blob.mime }));
    } else url = this.dataUrl(id)!;
    this.urls.set(id, url);
    return url;
  }

  dataUrl(id: ImageId): string | undefined {
    const e = this.entries_.get(id);
    return e ? `data:${e.blob.mime};base64,${bytesToBase64(e.blob.bytes)}` : undefined;
  }

  remove(id: ImageId): boolean {
    const e = this.entries_.get(id);
    if (!e) return false;
    this.revoke(id);
    this.entries_.delete(id);
    if (this.byHash.get(e.asset.sha256) === id) this.byHash.delete(e.asset.sha256);
    return true;
  }

  clear(): void {
    for (const id of [...this.entries_.keys()]) this.remove(id);
  }

  private revoke(id: ImageId): void {
    const url = this.urls.get(id);
    if (!url) return;
    this.urls.delete(id);
    const U = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
    if (url.startsWith('blob:') && U?.revokeObjectURL) U.revokeObjectURL(url);
  }
}

/** Decode the pixel size with `createImageBitmap` (browser); null elsewhere or on failure. */
async function decodeImageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number } | null> {
  const cib = (globalThis as { createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close?: () => void }> }).createImageBitmap;
  if (!cib || typeof Blob === 'undefined') return null;
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const bmp = await cib(new Blob([copy], { type: mime }));
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}
