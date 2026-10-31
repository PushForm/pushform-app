// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_CHUNK_BYTES } from './chunks';
import { openNativeContainer } from './container';
import type { NativeFileSource } from './container';

export const NATIVE_ROOT_ID = 0xffff_ffff;
/** Required document capabilities a reader must declare: 1 = mesh parts (record kind 17, MOD3850). */
export const NATIVE_CAPABILITY_MESH_PARTS = 1;
export const NATIVE_MODEL_CAPABILITIES: ReadonlySet<number> = new Set([NATIVE_CAPABILITY_MESH_PARTS]);
export interface NativeDocumentRoot {
  schemaMajor: number;
  documentKind: 1 | 2;
  metadataChunk: number;
  recordChunks: number[];
  requiredCapabilities: number[];
  unknownFields: Uint8Array[];
}
const fail = (): never => { throw new NativeChunkError('Invalid or unsupported native document root'); };
function uint(reader: protobuf.Reader): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (reader.pos >= reader.len) return fail(); const byte = reader.buf[reader.pos++]!;
    if (i === 4 && byte > 15) return fail(); value += (byte & 127) * 2 ** (7 * i);
    if (!(byte & 128)) return value;
  }
  return fail();
}
function validate(value: NativeDocumentRoot): void {
  if (value.schemaMajor !== 1 || (value.documentKind !== 1 && value.documentKind !== 2) ||
      !Number.isInteger(value.metadataChunk) || value.metadataChunk < 1 || value.metadataChunk >= NATIVE_ROOT_ID) fail();
  for (const ids of [value.recordChunks, value.requiredCapabilities]) {
    if (ids.length > NATIVE_MAX_CHUNKS || new Set(ids).size !== ids.length) fail();
    for (const id of ids) if (!Number.isInteger(id) || id < 1 || id >= NATIVE_ROOT_ID) fail();
  }
  if (value.recordChunks.includes(value.metadataChunk)) fail();
}
export function decodeNativeDocumentRoot(bytes: Uint8Array): NativeDocumentRoot {
  if (bytes.length > NATIVE_MAX_CHUNK_BYTES) return fail();
  const reader = protobuf.Reader.create(bytes), seen = new Set<number>();
  const value: NativeDocumentRoot = { schemaMajor: 0, documentKind: 1, metadataChunk: 0, recordChunks: [], requiredCapabilities: [], unknownFields: [] };
  try {
    while (reader.pos < reader.len) {
      const start = reader.pos, tag = uint(reader), id = tag >>> 3, wire = tag & 7;
      if (!id || ![0, 1, 2, 5].includes(wire)) return fail();
      if (id <= 3) {
        if (wire !== 0 || seen.has(id)) return fail(); seen.add(id); const n = uint(reader);
        if (id === 1) value.schemaMajor = n; else if (id === 2) value.documentKind = n as 1 | 2; else value.metadataChunk = n;
      } else if (id <= 5) {
        if (wire !== 0 && wire !== 2) return fail(); const list = id === 4 ? value.recordChunks : value.requiredCapabilities;
        if (wire === 0) list.push(uint(reader));
        else {
          const length = uint(reader), end = reader.pos + length; if (end > reader.len) return fail();
          while (reader.pos < end) { list.push(uint(reader)); if (list.length > NATIVE_MAX_CHUNKS) return fail(); }
          if (reader.pos !== end) return fail();
        }
        if (list.length > NATIVE_MAX_CHUNKS) return fail();
      } else {
        reader.skipType(wire); if (reader.pos > reader.len) return fail(); value.unknownFields.push(new Uint8Array(bytes.subarray(start, reader.pos)));
      }
    }
  } catch { return fail(); }
  if (seen.size !== 3) return fail(); validate(value); return value;
}
export function encodeNativeDocumentRoot(value: NativeDocumentRoot): Uint8Array {
  validate(value);
  const writer = protobuf.Writer.create().uint32(8).uint32(value.schemaMajor).uint32(16).uint32(value.documentKind).uint32(24).uint32(value.metadataChunk);
  for (const [index, ids] of [value.recordChunks, value.requiredCapabilities].entries()) if (ids.length) {
    writer.uint32(((index + 4) << 3) | 2).fork(); for (const id of ids) writer.uint32(id); writer.ldelim();
  }
  const known = writer.finish(); let length = known.length;
  for (const field of value.unknownFields) {
    if (!field.length || (uint(protobuf.Reader.create(field)) >>> 3) <= 5) return fail(); length += field.length;
  }
  if (length > NATIVE_MAX_CHUNK_BYTES) return fail();
  const bytes = new Uint8Array(length); bytes.set(known); let at = known.length;
  for (const field of value.unknownFields) { bytes.set(field, at); at += field.length; }
  const checked = decodeNativeDocumentRoot(bytes);
  if (checked.recordChunks.length !== value.recordChunks.length || checked.requiredCapabilities.length !== value.requiredCapabilities.length) return fail();
  return bytes;
}

/** Gate document adapters before geometry allocation. Does not install state. */
export async function openNativeDocumentIndex(
  source: NativeFileSource, supportedCapabilities: ReadonlySet<number>, supports: (kind: number, schema: number) => boolean, signal?: AbortSignal,
) {
  const container = await openNativeContainer(source, (kind, schema) => kind === 1 ? schema === 1 : supports(kind, schema), signal);
  const rootEntry = container.entries.find(entry => entry.descriptor.id === container.root)!;
  const root = decodeNativeDocumentRoot(await container.read(rootEntry));
  if (root.documentKind !== container.kind) return fail();
  for (const capability of root.requiredCapabilities) if (!supportedCapabilities.has(capability))
    throw new NativeChunkError(`Unsupported required native capability: ${capability}`);
  const entries = new Map(container.entries.map(entry => [entry.descriptor.id, entry]));
  const metadata = entries.get(root.metadataChunk);
  if (!metadata || metadata.descriptor.kind !== 3 || !metadata.descriptor.required) return fail();
  for (const id of root.recordChunks) if (!entries.has(id) || id === container.root) return fail();
  return { root, container, metadata };
}
