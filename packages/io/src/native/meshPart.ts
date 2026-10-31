// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MaterialId } from '@pushform/core';
import { validateMeshPartGeometry } from '@pushform/model';
import type { CommonAttrs, MeshPart, MeshPartGeometry } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { NativeChunkError, NATIVE_MAX_CHUNKS } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { encodeNativeColumn } from './columns';
import type { NativeColumnArrays, NativeColumnReader, NativeColumnType } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeStoredChunk } from './container';
import type { NativeCommonPropertyReader } from './commonProperty';
import { streamNativeMesh, readNativeMesh, encodeNativeMeshReference, decodeNativeMeshReference } from './mesh';
import type { NativeMeshReference } from './mesh';

/** Record kind 17 (`meshPart.proto`): the part's metadata and the chunk ids of its packed columns. */
export interface NativeMeshPartReference {
  id: number; properties: number; name: string; sourceFormat: string; sourceSystem: string; materialId: number | null;
  faceCount: number; edgeCount: number; edgePointCount: number;
  /** positions, triangles and the source face per triangle, as a body mesh is stored. */
  mesh: NativeMeshReference;
  faceMaterialChunks: number[]; edgeOffsetChunks: number[]; edgePositionChunks: number[]; edgeFlagChunks: number[];
  unknownFields: Uint8Array[];
}
const codec = new NativeRecordCodec({ id: { id: 1, kind: 'uint32', required: true }, properties: { id: 2, kind: 'uint32', required: true },
  name: { id: 3, kind: 'string', required: true }, sourceFormat: { id: 4, kind: 'string', required: true }, sourceSystem: { id: 5, kind: 'string', required: true },
  materialId: { id: 6, kind: 'uint32', required: false }, faceCount: { id: 7, kind: 'uint32', required: true }, edgeCount: { id: 8, kind: 'uint32', required: true },
  edgePointCount: { id: 9, kind: 'uint32', required: true }, mesh: { id: 10, kind: 'bytes', required: true }, faceMaterialChunks: { id: 11, kind: 'bytes', required: true },
  edgeOffsetChunks: { id: 12, kind: 'bytes', required: true }, edgePositionChunks: { id: 13, kind: 'bytes', required: true }, edgeFlagChunks: { id: 14, kind: 'bytes', required: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native mesh part'); };
const MAX_NAME = 4096;

/** Chunk id lists travel as little-endian uint32 bytes, so the record codec's fixed field kinds suffice. */
function encodeIds(ids: readonly number[]): Uint8Array {
  const out = new Uint8Array(ids.length * 4), view = new DataView(out.buffer);
  ids.forEach((id, i) => view.setUint32(i * 4, id, true));
  return out;
}
function decodeIds(bytes: Uint8Array): number[] {
  if (bytes.length % 4) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ids: number[] = [];
  for (let at = 0; at < bytes.length; at += 4) ids.push(view.getUint32(at, true));
  return ids;
}
function validate(ref: NativeMeshPartReference): void {
  if (!Number.isInteger(ref.properties) || ref.properties < 1 || ref.properties > 0xffff_ffff || ref.name.length > MAX_NAME ||
    ref.sourceFormat.length > MAX_NAME || ref.sourceSystem.length > MAX_NAME) fail();
  for (const count of [ref.faceCount, ref.edgeCount, ref.edgePointCount]) if (!Number.isInteger(count) || count < 0 || count > 0xffff_ffff) fail();
  if (!!ref.edgeCount !== !!ref.edgePointCount || (ref.edgeCount && ref.edgePointCount < 2 * ref.edgeCount)) fail();
  const used = new Set<number>();
  for (const ids of [ref.mesh.vertexChunks, ref.mesh.triangleChunks, ref.mesh.faceIdChunks, ref.faceMaterialChunks, ref.edgeOffsetChunks, ref.edgePositionChunks, ref.edgeFlagChunks]) {
    for (const id of ids) { if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS || !!ref.faceCount !== !!ref.faceMaterialChunks.length || !!ref.edgeCount !== !!ref.edgeOffsetChunks.length ||
    !!ref.edgeCount !== !!ref.edgePositionChunks.length || !!ref.edgeCount !== !!ref.edgeFlagChunks.length) fail();
}
export function encodeNativeMeshPartReference(ref: NativeMeshPartReference): Uint8Array {
  validate(ref);
  return codec.encode({ fields: { id: ref.id, properties: ref.properties, name: ref.name, sourceFormat: ref.sourceFormat, sourceSystem: ref.sourceSystem,
    ...(ref.materialId === null ? {} : { materialId: ref.materialId }), faceCount: ref.faceCount, edgeCount: ref.edgeCount, edgePointCount: ref.edgePointCount,
    mesh: encodeNativeMeshReference(ref.mesh), faceMaterialChunks: encodeIds(ref.faceMaterialChunks), edgeOffsetChunks: encodeIds(ref.edgeOffsetChunks),
    edgePositionChunks: encodeIds(ref.edgePositionChunks), edgeFlagChunks: encodeIds(ref.edgeFlagChunks) }, unknownFields: ref.unknownFields });
}
export function decodeNativeMeshPartReference(bytes: Uint8Array): NativeMeshPartReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref: NativeMeshPartReference = { id: f.id as number, properties: f.properties as number, name: f.name as string, sourceFormat: f.sourceFormat as string,
    sourceSystem: f.sourceSystem as string, materialId: f.materialId === undefined ? null : f.materialId as number, faceCount: f.faceCount as number,
    edgeCount: f.edgeCount as number, edgePointCount: f.edgePointCount as number, mesh: decodeNativeMeshReference(f.mesh as Uint8Array),
    faceMaterialChunks: decodeIds(f.faceMaterialChunks as Uint8Array), edgeOffsetChunks: decodeIds(f.edgeOffsetChunks as Uint8Array),
    edgePositionChunks: decodeIds(f.edgePositionChunks as Uint8Array), edgeFlagChunks: decodeIds(f.edgeFlagChunks as Uint8Array), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}

async function* column(values: NativeColumnArrays[NativeColumnType], nextId: () => number, options: NativeChunkOptions): AsyncGenerator<NativeStoredChunk, number[]> {
  const ids: number[] = [];
  for await (const chunk of encodeNativeColumn(values, options)) {
    const id = nextId(); ids.push(id); yield { descriptor: describeNativeChunk(id, 2, 1, true, chunk), data: chunk.data };
  }
  return ids;
}
/** Yield the part's columns under downstream backpressure; return only the small reference. */
export async function* streamNativeMeshPart(part: MeshPart, propertyId: (value: CommonAttrs) => number, nextId: () => number,
  options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeMeshPartReference> {
  const g = part.geometry;
  validateMeshPartGeometry(g);
  const mesh = yield* streamNativeMesh({ verts: g.positions, tris: g.triangles, faceId: g.triangleFace }, nextId, options);
  const edgeCount = g.edgeOffsets.length ? g.edgeOffsets.length - 1 : 0;
  const ref: NativeMeshPartReference = { id: part.id, properties: propertyId(part), name: part.name, sourceFormat: part.source.format, sourceSystem: part.source.system,
    materialId: part.materialId, faceCount: g.faceCount, edgeCount, edgePointCount: g.edgePositions.length / 3, mesh,
    faceMaterialChunks: yield* column(g.faceMaterials, nextId, options), edgeOffsetChunks: yield* column(g.edgeOffsets, nextId, options),
    edgePositionChunks: yield* column(g.edgePositions, nextId, options), edgeFlagChunks: yield* column(g.edgeFlags, nextId, options),
    unknownFields: part.nativeUnknownFields?.extensions?.get('') ?? [] };
  validate(ref); return ref;
}
/** Read the part's columns back and check them against the catalogs; this staging reader does not install a Document. */
export async function readNativeMeshPart(ref: NativeMeshPartReference, columns: NativeColumnReader, properties: NativeCommonPropertyReader,
  hasMaterial: (id: number) => boolean, hasTag: (id: number) => boolean, signal?: AbortSignal) {
  validate(ref); const common = properties.get(ref.properties);
  if (!hasTag(common.value.tagId) || (ref.materialId !== null && !hasMaterial(ref.materialId))) return fail();
  const mesh = await readNativeMesh(ref.mesh, columns, signal);
  const faceMaterials = await columns.read('uint32', ref.faceCount, ref.faceMaterialChunks, signal);
  const edgeOffsets = await columns.read('uint32', ref.edgeCount ? ref.edgeCount + 1 : 0, ref.edgeOffsetChunks, signal);
  const edgePositions = await columns.read('float64', ref.edgePointCount * 3, ref.edgePositionChunks, signal);
  const edgeFlags = await columns.read('uint8', ref.edgeCount, ref.edgeFlagChunks, signal);
  signal?.throwIfAborted();
  const geometry: MeshPartGeometry = { positions: mesh.verts, triangles: mesh.tris, triangleFace: mesh.faceId, faceCount: ref.faceCount, faceMaterials, edgeOffsets, edgePositions, edgeFlags };
  try { validateMeshPartGeometry(geometry); } catch { return fail(); }
  for (const id of faceMaterials) if (id && !hasMaterial(id)) return fail();
  for (const flags of edgeFlags) if (flags > 3) return fail();
  return { id: ref.id as Id, common: common.value, name: ref.name, source: { format: ref.sourceFormat, system: ref.sourceSystem },
    materialId: ref.materialId as MaterialId | null, geometry, unknownFields: ref.unknownFields };
}
export type NativePackedMeshPart = Awaited<ReturnType<typeof readNativeMeshPart>>;
