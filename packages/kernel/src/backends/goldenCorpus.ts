// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The kernel's golden corpus: requests in the wire format and the exact answers they must get, one record per kernel
 * call in the order they were made. Test support only; nothing in the app imports this file.
 *
 * The answers are bit for bit what the kernel returned when the corpus was recorded, so a replay can only pass if every
 * operation still produces the same positions, triangles, ids and errors. Records must be replayed in order on a fresh
 * kernel, because Manifold's run ids come from one counter that a kernel call may advance.
 */
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

export interface GoldenRecord {
  /** Wire bytes of the request. */
  request: Uint8Array;
  /** What the kernel answered: wire bytes for a result, the error as JSON text for a failure, the cached count for `stats`. */
  outcome: { kind: 'ok'; response: Uint8Array } | { kind: 'error'; info: string } | { kind: 'stats'; cached: number };
}

const MAGIC = 0x474b4650; // "PFKG" little-endian, followed by the record count.

/** Serializes records into the compressed corpus file. */
export function encodeGoldenCorpus(records: readonly GoldenRecord[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const u32 = (v: number): Uint8Array => new Uint8Array(new Uint32Array([v]).buffer);
  parts.push(u32(MAGIC), u32(records.length));
  for (const r of records) {
    parts.push(u32(r.request.byteLength), r.request);
    if (r.outcome.kind === 'ok') parts.push(new Uint8Array([0]), u32(r.outcome.response.byteLength), r.outcome.response);
    else if (r.outcome.kind === 'error') {
      const text = new TextEncoder().encode(r.outcome.info);
      parts.push(new Uint8Array([1]), u32(text.byteLength), text);
    } else parts.push(new Uint8Array([2]), u32(r.outcome.cached));
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return brotliCompressSync(out, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: out.byteLength } });
}

/** Reads a corpus file back into its records, in order. */
export function decodeGoldenCorpus(compressed: Uint8Array): GoldenRecord[] {
  const bytes = brotliDecompressSync(compressed);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = (): number => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const take = (n: number): Uint8Array => {
    const out = bytes.subarray(at, at + n);
    at += n;
    return new Uint8Array(out);
  };
  if (u32() !== MAGIC) throw new Error('Not a kernel golden corpus file');
  const count = u32();
  const records: GoldenRecord[] = [];
  for (let i = 0; i < count; i++) {
    const request = take(u32());
    const kind = view.getUint8(at++);
    if (kind === 2) {
      records.push({ request, outcome: { kind: 'stats', cached: u32() } });
    } else {
      const payload = take(u32());
      records.push({ request, outcome: kind === 0 ? { kind: 'ok', response: payload } : { kind: 'error', info: new TextDecoder().decode(payload) } });
    }
  }
  if (at !== bytes.byteLength) throw new Error(`Kernel golden corpus has ${bytes.byteLength - at} trailing bytes`);
  return records;
}
