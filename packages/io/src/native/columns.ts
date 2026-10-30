// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { encodeNativeChunks, decodeNativeChunks, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';
import type { NativeChunk, NativeChunkOptions } from './chunks';
import type { NativeDirectoryEntry } from './container';
import { NativeIdIndex } from './idIndex';
import { NativeEdgeIndex } from './edgeKey';
import { PackedPointIndex } from '@pushform/geom';

export interface NativeColumnArrays { float64: Float64Array; uint32: Uint32Array; uint8: Uint8Array }
export type NativeColumnType = keyof NativeColumnArrays;
const widths = { float64: 8, uint32: 4, uint8: 1 } as const;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Share one budget across every column allocated while opening a document. */
export class NativeColumnBudget {
  #used = 0;
  constructor(readonly limit = NATIVE_MAX_DECODED_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > NATIVE_MAX_DECODED_BYTES) throw new NativeChunkError('Invalid column budget');
  }
  get usedBytes(): number { return this.#used; }
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.#used) throw new NativeChunkError('Native column allocation budget exceeded');
    this.#used += bytes;
  }
  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#used) throw new NativeChunkError('Invalid column budget release');
    this.#used -= bytes;
  }
}
function swap(bytes: Uint8Array, width: number): void {
  for (let at = 0; at < bytes.length; at += width) for (let j = 0; j < width / 2; j++) {
    const a = at + j, b = at + width - j - 1, value = bytes[a]!; bytes[a] = bytes[b]!; bytes[b] = value;
  }
}

/** Model arrays remain immutable until iteration completes; no numeric boxing. */
export function encodeNativeColumn(
  values: NativeColumnArrays[NativeColumnType], options: NativeChunkOptions = {},
): AsyncGenerator<NativeChunk> {
  const width = values instanceof Float64Array ? 8 : values instanceof Uint32Array ? 4 : values instanceof Uint8Array ? 1 : 0;
  const pageBytes = options.pageBytes ?? NATIVE_CHUNK_BYTES;
  if (!width || !Number.isInteger(pageBytes) || pageBytes < width || pageBytes > NATIVE_MAX_CHUNK_BYTES || pageBytes % width)
    throw new NativeChunkError('Invalid native column or page alignment');
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  function* pages(): Generator<Uint8Array> {
    for (let at = 0; at < bytes.length; at += pageBytes) {
      const page = bytes.subarray(at, Math.min(at + pageBytes, bytes.length));
      if (littleEndian || width === 1) yield page;
      else { const copy = new Uint8Array(page); swap(copy, width); yield copy; }
    }
  }
  return encodeNativeChunks(pages(), options);
}

/**
 * Allocate only the final typed column plus the current decoded chunk. Count is
 * validated and charged before allocation; failures release the reservation.
 * A successful reservation stays charged for the lifetime of the opened state.
 */
export async function decodeNativeColumn<T extends NativeColumnType>(
  type: T, count: number, chunks: Iterable<NativeChunk> | AsyncIterable<NativeChunk>, budget: NativeColumnBudget, signal?: AbortSignal,
): Promise<NativeColumnArrays[T]> {
  return assembleNativeColumn(type, count, decodeNativeChunks(chunks, signal), budget, signal);
}

async function assembleNativeColumn<T extends NativeColumnType>(
  type: T, count: number, pages: AsyncIterable<Uint8Array>, budget: NativeColumnBudget, signal?: AbortSignal,
): Promise<NativeColumnArrays[T]> {
  const width = widths[type];
  if (!width || !Number.isSafeInteger(count) || count < 0 || count > Math.floor(NATIVE_MAX_DECODED_BYTES / width))
    throw new NativeChunkError('Invalid native column element count');
  signal?.throwIfAborted();
  const length = count * width; budget.reserve(length);
  try {
    const buffer = new ArrayBuffer(length), bytes = new Uint8Array(buffer); let at = 0;
    for await (const page of pages) {
      signal?.throwIfAborted();
      if (page.length > length - at) throw new NativeChunkError('Native column has excess bytes');
      bytes.set(page, at); at += page.length;
    }
    if (at !== length) throw new NativeChunkError('Native column is truncated');
    if (!littleEndian && width > 1) swap(bytes, width);
    const value = type === 'float64' ? new Float64Array(buffer) : type === 'uint32' ? new Uint32Array(buffer) : bytes;
    return value as NativeColumnArrays[T];
  } catch (error) { budget.release(length); throw error; }
}

/** One index shared by all column reads; no repeated linear directory scans. */
export class NativeColumnReader {
  readonly #entries: Map<number, NativeDirectoryEntry>;
  constructor(private readonly container: { entries: readonly NativeDirectoryEntry[]; read(entry: NativeDirectoryEntry): Promise<Uint8Array> },
    private readonly budget: NativeColumnBudget) {
    this.#entries = new Map(container.entries.map(entry => [entry.descriptor.id, entry]));
  }
  /** Validate uniqueness using bounded numeric scratch, avoiding a per-ID JS Set. */
  validateUniqueIds(ids: Uint32Array, signal?: AbortSignal): void {
    signal?.throwIfAborted(); this.budget.reserve(ids.byteLength);
    try {
      const sorted = ids.slice().sort();
      for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new NativeChunkError('Duplicate native persistent ID');
      signal?.throwIfAborted();
    } finally { this.budget.release(ids.byteLength); }
  }
  indexIds(ids: Uint32Array, signal?: AbortSignal): NativeIdIndex { return new NativeIdIndex(ids, this.budget, signal); }
  indexPoints(positions: Float64Array, signal?: AbortSignal): PackedPointIndex {
    const count = positions.length / 3;
    if (!Number.isInteger(count)) throw new NativeChunkError('Invalid point column size');
    const bytes = count * 4; this.budget.reserve(bytes);
    try { return new PackedPointIndex(positions, new Uint32Array(count), signal); }
    catch (error) { this.budget.release(bytes); throw error; }
  }
  indexEdgeKeys(rows: Uint32Array, signal?: AbortSignal): NativeEdgeIndex { return new NativeEdgeIndex(rows, this.budget, signal); }
  async read<T extends NativeColumnType>(type: T, count: number, chunkIds: readonly number[], signal?: AbortSignal): Promise<NativeColumnArrays[T]> {
    return this.readKind(type, count, chunkIds, 2, signal);
  }
  /** Image/embedded bytes share the document's allocation budget with geometry. */
  async readAsset(count: number, chunkIds: readonly number[], signal?: AbortSignal): Promise<Uint8Array> {
    return this.readKind('uint8', count, chunkIds, 4, signal);
  }
  private async readKind<T extends NativeColumnType>(type: T, count: number, chunkIds: readonly number[], kind: 2 | 4, signal?: AbortSignal): Promise<NativeColumnArrays[T]> {
    const entries: NativeDirectoryEntry[] = [], seen = new Set<number>(); let bytes = 0;
    for (const id of chunkIds) {
      const entry = this.#entries.get(id);
      if (!entry || seen.has(id) || entry.descriptor.kind !== kind || entry.descriptor.schemaId !== 1)
        throw new NativeChunkError('Invalid native column chunk reference');
      seen.add(id); entries.push(entry); bytes += entry.descriptor.decodedBytes;
    }
    if (!Number.isSafeInteger(count) || count < 0 || bytes !== count * widths[type]) throw new NativeChunkError('Native column size mismatch');
    const container = this.container;
    async function* pages(): AsyncGenerator<Uint8Array> { for (const entry of entries) { signal?.throwIfAborted(); yield await container.read(entry); } }
    return assembleNativeColumn(type, count, pages(), this.budget, signal);
  }
}
