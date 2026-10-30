// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { decodeChunkDescriptor, encodeChunkDescriptor, MAX_CHUNK_DESCRIPTOR_BYTES } from './chunkDescriptor';
import type { ChunkDescriptor } from './chunkDescriptor';
import { decodeNativeChunks, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';

const HEADER = 32, FOOTER = 64;
const MAGIC = new Uint8Array([80, 85, 83, 72, 70, 82, 77, 50]); // PUSHFRM2
const END = new Uint8Array([80, 70, 69, 78, 68, 50, 0, 0]);
export const NATIVE_MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
/** Logical column fragments are bounded separately from physical storage pages. */
export const NATIVE_MAX_LOGICAL_CHUNKS = 1024 * 1024;
export const NATIVE_MAX_FILE_BYTES = NATIVE_MAX_DECODED_BYTES + NATIVE_MAX_DIRECTORY_BYTES + HEADER + FOOTER;
export interface NativeFileSource {
  readonly size: number;
  /** Returns exactly length bytes; the source must remain immutable while open. */
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface NativeFileSink {
  /** Resolves after bytes have been consumed; the implementation must apply backpressure. */
  write(bytes: Uint8Array): Promise<void>;
}
export interface NativeStoredChunk { descriptor: ChunkDescriptor; data: Uint8Array }
export interface NativeContainerInfo { kind: 1 | 2; root: number }
export interface NativeDirectoryEntry {
  descriptor: ChunkDescriptor; offset: number;
  /** Runtime-only slice: integrity belongs to the physical page, not this logical view. */
  page?: NativeDirectoryEntry;
  start?: number;
}
const fail = (message = 'Invalid native container'): never => { throw new NativeChunkError(message); };
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
async function hash(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
function header(info: NativeContainerInfo): Uint8Array {
  if ((info.kind !== 1 && info.kind !== 2) || !Number.isInteger(info.root) || info.root < 1 || info.root > 0xffff_ffff) return fail();
  const bytes = new Uint8Array(HEADER), view = new DataView(bytes.buffer);
  bytes.set(MAGIC); view.setUint32(8, 1, true); view.setUint32(12, info.kind, true); view.setUint32(16, info.root, true);
  return bytes;
}

/**
 * Append-only container. Payloads go straight to the sink; only the bounded
 * directory is retained. A footer publishes the index after all payloads finish.
 * The caller owns atomic file/recovery publication and must abandon failed writes.
 */
export async function writeNativeContainer(
  info: NativeContainerInfo, source: AsyncIterable<NativeStoredChunk> | Iterable<NativeStoredChunk>,
  sink: NativeFileSink, signal?: AbortSignal,
): Promise<{ storedBytes: number; decodedBytes: number; chunks: number }> {
  signal?.throwIfAborted();
  const head = header(info); await sink.write(head);
  const directory: Uint8Array[] = [];
  let offset = HEADER, directoryBytes = 0, expanded = 0, previousId = 0, rootFound = false, logicalCount = 0;
  for await (const chunk of source) {
    signal?.throwIfAborted();
    const d = chunk.descriptor, encoded = encodeChunkDescriptor(d);
    if (d.id <= previousId) return fail('Native chunk IDs must be strictly increasing');
    if (chunk.data.length !== d.storedBytes) return fail('Native chunk stored length mismatch');
    if (directory.length >= NATIVE_MAX_CHUNKS) return fail(`Native container chunk limit exceeded (${NATIVE_MAX_CHUNKS})`);
    previousId = d.slices ? d.slices[d.slices.length - 3]! : d.id; expanded += d.decodedBytes;
    logicalCount += d.slices ? d.slices.length / 3 : 1;
    if (logicalCount > NATIVE_MAX_LOGICAL_CHUNKS) return fail('Native logical chunk limit exceeded');
    directoryBytes += 8 + encoded.length;
    if (expanded > NATIVE_MAX_DECODED_BYTES || directoryBytes > NATIVE_MAX_DIRECTORY_BYTES ||
        offset + d.storedBytes + directoryBytes + FOOTER > NATIVE_MAX_FILE_BYTES) return fail('Native container budget exceeded');
    if (!equal(await hash(chunk.data), d.sha256)) return fail('Native chunk integrity check failed');
    signal?.throwIfAborted();
    const entry = new Uint8Array(8 + encoded.length), view = new DataView(entry.buffer);
    view.setUint32(0, offset, true); view.setUint32(4, encoded.length, true); entry.set(encoded, 8); directory.push(entry);
    if (d.id === info.root) { if (d.kind !== 1 || !d.required) return fail(); rootFound = true; }
    await sink.write(chunk.data); offset += chunk.data.length;
  }
  if (!rootFound) return fail('Native container has no required root');
  // Hash the header together with the directory so kind/root and record metadata
  // are covered. This allocation is capped independently of document size.
  const index = new Uint8Array(HEADER + directoryBytes); index.set(head); let at = HEADER;
  for (const entry of directory) { index.set(entry, at); at += entry.length; }
  const digest = await hash(index); signal?.throwIfAborted();
  await sink.write(index.subarray(HEADER));
  const footer = new Uint8Array(FOOTER), view = new DataView(footer.buffer);
  footer.set(END); view.setUint32(8, offset, true); view.setUint32(12, directoryBytes, true);
  view.setUint32(16, directory.length, true); view.setUint32(20, offset + directoryBytes + FOOTER, true);
  footer.set(digest, 24); signal?.throwIfAborted(); await sink.write(footer);
  return { storedBytes: offset + directoryBytes + FOOTER, decodedBytes: expanded, chunks: directory.length };
}

/** Open a checked index. Payload integrity is checked as each chunk is read. */
export async function openNativeContainer(
  source: NativeFileSource, supports: (kind: number, schema: number) => boolean, signal?: AbortSignal,
): Promise<NativeContainerInfo & { entries: readonly NativeDirectoryEntry[]; read(entry: NativeDirectoryEntry): Promise<Uint8Array> }> {
  if (!Number.isSafeInteger(source.size) || source.size < HEADER + FOOTER || source.size > NATIVE_MAX_FILE_BYTES) return fail();
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    const bytes = await source.read(offset, length); signal?.throwIfAborted();
    if (bytes.length !== length) return fail('Truncated native container'); return bytes;
  };
  const head = await read(0, HEADER), footer = await read(source.size - FOOTER, FOOTER);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength), fv = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  const kind = hv.getUint32(12, true), root = hv.getUint32(16, true);
  if (!equal(head.subarray(0, 8), MAGIC) || hv.getUint32(8, true) !== 1 || (kind !== 1 && kind !== 2) || !root ||
      head.subarray(20).some(v => v !== 0) || !equal(footer.subarray(0, 8), END) || footer.subarray(56).some(v => v !== 0)) return fail();
  const dir = fv.getUint32(8, true), length = fv.getUint32(12, true), count = fv.getUint32(16, true);
  if (dir < HEADER || length > NATIVE_MAX_DIRECTORY_BYTES || !count || count > NATIVE_MAX_CHUNKS ||
      dir + length + FOOTER !== source.size || fv.getUint32(20, true) !== source.size) return fail();
  const directory = await read(dir, length), combined = new Uint8Array(HEADER + length);
  combined.set(head); combined.set(directory, HEADER);
  if (!equal(await hash(combined), footer.subarray(24, 56))) return fail('Native directory integrity check failed');
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength), entries: NativeDirectoryEntry[] = [];
  let at = 0, nextOffset = HEADER, expanded = 0, previousId = 0, logicalCount = 0;
  for (let i = 0; i < count; i++) {
    if (at + 8 > length) return fail();
    const offset = view.getUint32(at, true), size = view.getUint32(at + 4, true); at += 8;
    if (size > MAX_CHUNK_DESCRIPTOR_BYTES || at + size > length || offset !== nextOffset) return fail();
    const descriptor = decodeChunkDescriptor(directory.subarray(at, at + size)); at += size;
    if (descriptor.id <= previousId || (descriptor.required && !supports(descriptor.kind, descriptor.schemaId))) return fail('Unsupported or duplicate native record');
    previousId = descriptor.slices ? descriptor.slices[descriptor.slices.length - 3]! : descriptor.id;
    logicalCount += descriptor.slices ? descriptor.slices.length / 3 : 1;
    if (logicalCount > NATIVE_MAX_LOGICAL_CHUNKS) return fail('Native logical chunk limit exceeded');
    nextOffset += descriptor.storedBytes; expanded += descriptor.decodedBytes;
    if (nextOffset > dir || expanded > NATIVE_MAX_DECODED_BYTES) return fail();
    entries.push({ descriptor, offset });
  }
  const rootEntry = entries.find(e => e.descriptor.id === root);
  if (at !== length || nextOffset !== dir || !rootEntry || rootEntry.descriptor.kind !== 1 || !rootEntry.descriptor.required) return fail();
  const logical: NativeDirectoryEntry[] = [];
  for (const entry of entries) {
    const { slices, ...descriptor } = entry.descriptor;
    if (!slices) { logical.push(entry); continue; }
    for (let i = 0; i < slices.length; i += 3) logical.push({ offset: entry.offset, page: entry, start: slices[i + 1]!,
      descriptor: { ...descriptor, id: slices[i]!, schemaId: 1, codec: 0, storedBytes: slices[i + 2]!, decodedBytes: slices[i + 2]! } });
  }
  const membership = new Set(logical);
  const readPage = async (entry: NativeDirectoryEntry): Promise<Uint8Array> => {
    const d = entry.descriptor, data = await read(entry.offset, d.storedBytes);
    for await (const decoded of decodeNativeChunks([{ codec: d.codec, decodedBytes: d.decodedBytes, data, digest: d.sha256 }], signal)) return decoded;
    return fail();
  };
  // One decoded physical page, never an unbounded cache of all numeric data.
  let cached: { entry: NativeDirectoryEntry; bytes: Promise<Uint8Array> } | undefined;
  return { kind, root, entries: logical, read: async entry => {
    if (!membership.has(entry)) return fail();
    signal?.throwIfAborted();
    if (!entry.page) return readPage(entry);
    if (cached?.entry !== entry.page) cached = { entry: entry.page, bytes: readPage(entry.page) };
    const bytes = await cached.bytes; signal?.throwIfAborted();
    return bytes.slice(entry.start!, entry.start! + entry.descriptor.decodedBytes);
  } };
}

export function nativeBlobSource(blob: Blob): NativeFileSource {
  return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}
