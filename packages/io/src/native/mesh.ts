// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData } from '@pushform/core';
import protobuf from 'protobufjs/minimal';
import { encodeNativeColumn } from './columns';
import type { NativeColumnReader } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import { NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES, NativeChunkError } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';

export interface NativeMeshReference {
  vertexCount: number;
  triangleCount: number;
  vertexChunks: number[];
  triangleChunks: number[];
  faceIdChunks: number[];
  unknownFields: Uint8Array[];
}
const fail = (): never => { throw new NativeChunkError('Invalid native mesh reference'); };
const MAX_REFERENCE_BYTES = 1024 * 1024;
function uint(reader: protobuf.Reader): number {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (reader.pos >= reader.len) return fail();
    const byte = reader.buf[reader.pos++]!;
    if (i === 4 && byte > 15) return fail();
    n += (byte & 127) * 2 ** (7 * i); if (!(byte & 128)) return n;
  }
  return fail();
}
function validateReference(ref: NativeMeshReference): void {
  for (const count of [ref.vertexCount, ref.triangleCount]) if (!Number.isSafeInteger(count) || count < 0) fail();
  if (ref.vertexCount * 24 + ref.triangleCount * 16 > NATIVE_MAX_DECODED_BYTES) fail();
  let count = 0;
  for (const ids of [ref.vertexChunks, ref.triangleChunks, ref.faceIdChunks]) {
    count += ids.length;
    for (const id of ids) if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail();
    if (new Set(ids).size !== ids.length) fail();
  }
  if (count > NATIVE_MAX_CHUNKS || !!ref.vertexCount !== !!ref.vertexChunks.length ||
      !!ref.triangleCount !== !!ref.triangleChunks.length || !!ref.triangleCount !== !!ref.faceIdChunks.length) fail();
}
export function decodeNativeMeshReference(bytes: Uint8Array): NativeMeshReference {
  if (bytes.length > MAX_REFERENCE_BYTES) return fail();
  const reader = protobuf.Reader.create(bytes), seen = new Set<number>();
  const ref: NativeMeshReference = { vertexCount: 0, triangleCount: 0, vertexChunks: [], triangleChunks: [], faceIdChunks: [], unknownFields: [] };
  try {
    while (reader.pos < reader.len) {
      const start = reader.pos, tag = uint(reader), field = tag >>> 3, wire = tag & 7;
      if (!field || ![0, 1, 2, 5].includes(wire)) return fail();
      if (field <= 2) {
        if (wire !== 0 || seen.has(field)) return fail(); seen.add(field);
        if (field === 1) ref.vertexCount = uint(reader); else ref.triangleCount = uint(reader);
      } else if (field <= 5) {
        if (wire !== 0 && wire !== 2) return fail();
        const ids = field === 3 ? ref.vertexChunks : field === 4 ? ref.triangleChunks : ref.faceIdChunks;
        if (wire === 0) ids.push(uint(reader));
        else {
          const length = uint(reader), end = reader.pos + length;
          if (end > reader.len) return fail();
          while (reader.pos < end) { ids.push(uint(reader)); if (ids.length > NATIVE_MAX_CHUNKS) return fail(); }
          if (reader.pos !== end) return fail();
        }
        if (ids.length > NATIVE_MAX_CHUNKS) return fail();
      } else {
        reader.skipType(wire); if (reader.pos > reader.len) return fail();
        ref.unknownFields.push(new Uint8Array(bytes.subarray(start, reader.pos)));
      }
    }
  } catch { return fail(); }
  if (seen.size !== 2) return fail(); validateReference(ref); return ref;
}
export function encodeNativeMeshReference(ref: NativeMeshReference): Uint8Array {
  validateReference(ref);
  const writer = protobuf.Writer.create().uint32(8).uint32(ref.vertexCount).uint32(16).uint32(ref.triangleCount);
  for (const [i, ids] of [ref.vertexChunks, ref.triangleChunks, ref.faceIdChunks].entries()) if (ids.length) {
    writer.uint32(((i + 3) << 3) | 2).fork(); for (const id of ids) writer.uint32(id); writer.ldelim();
  }
  const known = writer.finish(); let length = known.length;
  for (const field of ref.unknownFields) {
    if (!field.length || (uint(protobuf.Reader.create(field)) >>> 3) <= 5) return fail();
    length += field.length; if (length > MAX_REFERENCE_BYTES) return fail();
  }
  const bytes = new Uint8Array(length); bytes.set(known); let at = known.length;
  for (const field of ref.unknownFields) { bytes.set(field, at); at += field.length; }
  const checked = decodeNativeMeshReference(bytes);
  // Appended extension fragments may not inject additional known repeated fields.
  if (checked.vertexChunks.length !== ref.vertexChunks.length || checked.triangleChunks.length !== ref.triangleChunks.length ||
      checked.faceIdChunks.length !== ref.faceIdChunks.length) return fail();
  return bytes;
}

/** Structural geometry checks only; kernel validation is still required for a Body. */
export function validateNativeMesh(mesh: MeshData): void {
  if (!(mesh.verts instanceof Float64Array) || !(mesh.tris instanceof Uint32Array) || !(mesh.faceId instanceof Uint32Array) ||
      mesh.verts.length % 3 || mesh.tris.length % 3 || mesh.faceId.length !== mesh.tris.length / 3) return fail();
  for (const value of mesh.verts) if (!Number.isFinite(value)) return fail();
  const count = mesh.verts.length / 3;
  for (const index of mesh.tris) if (index >= count) return fail();
}

/** Yield payloads under downstream backpressure; return only the small reference. */
export async function* streamNativeMesh(
  mesh: MeshData, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeMeshReference> {
  validateNativeMesh(mesh);
  const ref: NativeMeshReference = { vertexCount: mesh.verts.length / 3, triangleCount: mesh.tris.length / 3,
    vertexChunks: [], triangleChunks: [], faceIdChunks: [], unknownFields: [] };
  for (const [values, ids] of [[mesh.verts, ref.vertexChunks], [mesh.tris, ref.triangleChunks], [mesh.faceId, ref.faceIdChunks]] as const) {
    for await (const chunk of encodeNativeColumn(values, options)) {
      const id = nextId(); ids.push(id); yield { descriptor: describeNativeChunk(id, 2, 1, true, chunk), data: chunk.data };
    }
  }
  validateReference(ref); return ref;
}

export async function writeNativeMesh(
  mesh: MeshData, nextId: () => number, write: (chunk: NativeStoredChunk) => Promise<void>, options: NativeChunkOptions = {},
): Promise<NativeMeshReference> {
  const source = streamNativeMesh(mesh, nextId, options);
  try {
    for (;;) { const item = await source.next(); if (item.done) return item.value; await write(item.value); }
  } finally { await source.return(undefined as never); }
}

export async function readNativeMesh(ref: NativeMeshReference, columns: NativeColumnReader, signal?: AbortSignal): Promise<MeshData> {
  validateReference(ref);
  const verts = await columns.read('float64', ref.vertexCount * 3, ref.vertexChunks, signal);
  const tris = await columns.read('uint32', ref.triangleCount * 3, ref.triangleChunks, signal);
  const faceId = await columns.read('uint32', ref.triangleCount, ref.faceIdChunks, signal);
  const mesh = { verts, tris, faceId }; validateNativeMesh(mesh); return mesh;
}
