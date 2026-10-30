// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutNativeRecordFields } from '@pushform/layout';
import { NativeChunkError, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES, encodeNativeChunks } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
export interface NativeLayoutAssetReference { encoding: 0 | 1; prefix: string; byteLength: number; chunks: number[]; unknownFields: Uint8Array[] }
export interface NativeLayoutAsset { envelopeUnknown?: Uint8Array[]; reference: NativeLayoutAssetReference; bytes: Uint8Array }
/** Asset owners retain extension bytes, never file-local chunk identities or duplicate payloads. */
export function nativeLayoutAssetFields(asset: NativeLayoutAsset): { nativeAssetFields?: LayoutNativeRecordFields } {
  const unknownFields = asset.reference.unknownFields, envelopeUnknown = asset.envelopeUnknown;
  return unknownFields.length || envelopeUnknown?.length ? { nativeAssetFields: {
    ...(unknownFields.length ? { unknownFields } : {}), ...(envelopeUnknown?.length ? { envelopeUnknown } : {}),
  } } : {};
}
const codec = new NativeRecordCodec({ encoding: { id: 1, kind: 'uint32', required: true }, prefix: { id: 2, kind: 'string', required: true },
  byteLength: { id: 3, kind: 'uint32', required: true }, chunks: { id: 4, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout asset'); };
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function validate(r: NativeLayoutAssetReference): void {
  if (r.encoding !== 0 && r.encoding !== 1 || r.prefix.length > 4096 || !wellFormed(r.prefix) || r.encoding === 0 && (r.prefix !== '' || r.byteLength % 2) ||
    r.encoding === 1 && r.prefix !== '' && (!r.prefix.startsWith('data:') || !r.prefix.endsWith(';base64,')) ||
    !Number.isInteger(r.byteLength) || r.byteLength < 0 || r.byteLength > NATIVE_MAX_DECODED_BYTES ||
    !!r.byteLength !== !!r.chunks.length || r.chunks.length > NATIVE_MAX_CHUNKS || new Set(r.chunks).size !== r.chunks.length) fail();
  for (const id of r.chunks) if (!Number.isInteger(id) || id < 1 || id >= 0xffffffff) fail();
}
export function encodeNativeLayoutAssetReference(r: NativeLayoutAssetReference): Uint8Array {
  validate(r); return codec.encode({ fields: { encoding: r.encoding, prefix: r.prefix, byteLength: r.byteLength,
    ...(r.chunks.length ? { chunks: encodeNativeIds(r.chunks) } : {}) }, unknownFields: r.unknownFields });
}
export function decodeNativeLayoutAssetReference(bytes: Uint8Array): NativeLayoutAssetReference {
  const r = codec.decode(bytes), value = { encoding: r.fields.encoding as 0 | 1, prefix: r.fields.prefix as string, byteLength: r.fields.byteLength as number,
    chunks: decodeNativeIds(r.fields.chunks as Uint8Array | undefined), unknownFields: r.unknownFields }; validate(value); return value;
}
function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}
/** Only canonical padded base64 is transformed; other authored strings retain their exact code units. */
function base64Length(text: string, start: number, signal?: AbortSignal): number | undefined {
  const length = text.length - start; if (length % 4) return undefined; if (!length) return 0;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0, end = text.length - padding;
  for (let i = start; i < end; i++) { if (!(i % NATIVE_CHUNK_BYTES)) signal?.throwIfAborted(); if (sextet(text.charCodeAt(i)) < 0) return undefined; }
  if (padding && (sextet(text.charCodeAt(end - 1)) & (padding === 2 ? 15 : 3))) return undefined;
  return length / 4 * 3 - padding;
}
/** Decode directly from the existing immutable string into bounded pages, without atob/full-payload copies. */
export async function* streamNativeLayoutAsset(text: string, kind: 'image' | 'archive' | 'text', nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutAssetReference> {
  options.signal?.throwIfAborted(); const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!Number.isInteger(pageBytes) || pageBytes < 2 || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % 2) return fail();
  let start = 0, prefix = '', length: number | undefined;
  if (kind === 'archive') length = base64Length(text, 0, options.signal);
  else if (kind === 'image' && text.startsWith('data:')) {
    // Bound scanning and prefix copying even for malformed data URLs.
    const comma = text.slice(0, 4096).indexOf(',');
    if (comma >= 0 && text.slice(0, comma).endsWith(';base64')) {
      start = comma + 1; prefix = text.slice(0, start);
      if (wellFormed(prefix)) length = base64Length(text, start, options.signal);
    }
  }
  const encoding = length === undefined ? 0 : 1, byteLength = length ?? text.length * 2;
  if (byteLength > NATIVE_MAX_DECODED_BYTES || Math.ceil(byteLength / pageBytes) > NATIVE_MAX_CHUNKS) return fail();
  const result: NativeLayoutAssetReference = { encoding, prefix: encoding === 0 ? '' : prefix, byteLength, chunks: [], unknownFields: [] };
  function* pages(): Generator<Uint8Array> {
    if (!byteLength) return;
    const page = new Uint8Array(Math.min(pageBytes, byteLength)); let filled = 0, produced = 0;
    if (encoding === 0) {
      const view = new DataView(page.buffer);
      for (let i = 0; i < text.length; i++) {
        view.setUint16(filled, text.charCodeAt(i), true); filled += 2;
        if (filled === page.length) { yield page; filled = 0; }
      }
    } else {
      for (let i = start; i < text.length; i += 4) {
        const bits = (sextet(text.charCodeAt(i)) << 18) | (sextet(text.charCodeAt(i + 1)) << 12) |
          (Math.max(0, sextet(text.charCodeAt(i + 2))) << 6) | Math.max(0, sextet(text.charCodeAt(i + 3)));
        for (let shift = 16; shift >= 0 && produced < byteLength; shift -= 8) {
          page[filled++] = bits >> shift & 255; produced++;
          if (filled === page.length) { yield page; filled = 0; }
        }
      }
    }
    if (filled) yield page.subarray(0, filled);
  }
  for await (const chunk of encodeNativeChunks(pages(), options)) {
    const id = nextId(); result.chunks.push(id);
    yield { descriptor: describeNativeChunk(id, 4, 1, true, chunk), data: chunk.data };
  }
  validate(result); return result;
}
/** Keep decoded assets binary until the legacy editor adapter explicitly requests a string. */
export async function readNativeLayoutAsset(reference: NativeLayoutAssetReference, reader: NativeColumnReader, signal?: AbortSignal): Promise<NativeLayoutAsset> {
  validate(reference); return { reference, bytes: await reader.readAsset(reference.byteLength, reference.chunks, signal) };
}
/** Transitional editor bridge; the new file and staging representations do not contain base64 payload strings. */
export function materializeNativeLayoutAsset(asset: NativeLayoutAsset): string {
  const { reference: r, bytes } = asset; validate(r); if (bytes.length !== r.byteLength) return fail();
  const parts: string[] = [r.prefix];
  if (r.encoding === 1) {
    // Divisible by three: concatenated blocks have no interior padding.
    for (let at = 0; at < bytes.length; at += 3072) parts.push(btoa(String.fromCharCode(...bytes.subarray(at, at + 3072))));
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length; at += 8192) {
      const codes: number[] = []; for (let i = at; i < Math.min(at + 8192, bytes.length); i += 2) codes.push(view.getUint16(i, true));
      parts.push(String.fromCharCode(...codes));
    }
  }
  return parts.join('');
}
