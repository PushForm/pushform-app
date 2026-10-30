// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { encodeNativeColumn } from './columns';
import { describeNativeChunk } from './chunkDescriptor';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeFaceUv, NativeFaceUvReference } from './faceUv';
import { encodeNativeSketchReference } from './sketch';
import type { NativePackedSketch, NativeSketchReference } from './sketch';
import { encodeNativeBodyReference } from './body';
import type { NativePackedBody, NativeBodyReference } from './body';
import { streamNativeMesh } from './mesh';
import type { NativeImprintReference } from './imprint';

type Numbers = Float64Array | Uint32Array | Uint8Array;
type Options = { nextId: () => number; chunks: NativeChunkOptions };
async function* column(value: Numbers, options: Options): AsyncGenerator<NativeStoredChunk, number[]> {
  const ids: number[] = [];
  for await (const chunk of encodeNativeColumn(value, options.chunks)) {
    const id = options.nextId(); ids.push(id); yield { descriptor: describeNativeChunk(id, 2, 1, true, chunk), data: chunk.data };
  }
  return ids;
}
async function* table<K extends string>(values: Record<K, Numbers>, options: Options): AsyncGenerator<NativeStoredChunk, Record<K, number[]>> {
  const result = {} as Record<K, number[]>;
  for (const name of Object.keys(values) as K[]) result[name] = yield* column(values[name], options);
  return result;
}
async function* uv(value: NativeFaceUv, unknownFields: Uint8Array[], options: Options): AsyncGenerator<NativeStoredChunk, NativeFaceUvReference> {
  return { faceCount: value.kinds.length / 2, valueCount: value.values.length,
    kindChunks: yield* column(value.kinds, options), offsetChunks: yield* column(value.offsets, options), valueChunks: yield* column(value.values, options), unknownFields };
}
/** Borrow validated immutable columns. Preserve file-local property IDs; the caller must retain their property table. */
export async function* streamPackedSketch(value: NativePackedSketch, nextId: () => number, chunks: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeSketchReference> {
  const options = { nextId, chunks }, ext = (scope: string) => value.extensions.get(scope) ?? [];
  const vertices = { count: value.vertices.ids.length, idChunks: yield* column(value.vertices.ids, options), positionChunks: yield* column(value.vertices.positions, options), unknownFields: ext('vertices') };
  const edges = { count: value.edges.ids.length, idChunks: yield* column(value.edges.ids, options), rowChunks: yield* column(value.edges.rows, options), flagChunks: yield* column(value.edges.flags, options), unknownFields: ext('edges') };
  const { uv: faceUv, ...faceColumns } = value.faces;
  const faces = { faceCount: value.faces.ids.length, loopCount: value.faces.loopOffsets.length - 1, referenceCount: value.faces.edgeIds.length,
    columns: yield* table(faceColumns, options), uv: yield* uv(faceUv, ext('faces.uv'), options), unknownFields: ext('faces') };
  const curves = { count: value.curves.ids.length, referenceCount: value.curves.edgeIds.length, columns: yield* table(value.curves, options), unknownFields: ext('curves') };
  const ref = { vertices, edges, faces, curves, unknownFields: ext('') };
  encodeNativeSketchReference(ref); return ref;
}
/** Stream a validated packed body directly, excluding all derived indexes from the file. */
export async function* streamPackedBody(value: NativePackedBody, properties: number, nextId: () => number, chunks: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeBodyReference> {
  const options = { nextId, chunks }, ext = (scope: string) => value.extensions.get(scope) ?? [];
  const mesh = yield* streamNativeMesh(value.mesh, nextId, chunks); mesh.unknownFields = ext('mesh');
  const { uv: faceUv, ...faceColumns } = value.faces;
  const faces = { faceCount: value.faces.ids.length, loopCount: value.faces.loopOffsets.length - 1, pointCount: value.faces.positions.length / 3,
    columns: yield* table(faceColumns, options), uv: yield* uv(faceUv, ext('faces.uv'), options), unknownFields: ext('faces') };
  const { index: _edgeIndex, ...edgeColumns } = value.edges;
  const edges = { count: value.edges.flags.length, pointCount: value.edges.positions.length / 3, columns: yield* table(edgeColumns, options), unknownFields: ext('edges') };
  const curves = { count: value.curves.ids.length, referenceCount: value.curves.edgeKeys.length / 3, columns: yield* table(value.curves, options), unknownFields: ext('curves') };
  const surfaces = { count: value.surfaces.ids.length, referenceCount: value.surfaces.faces.length, columns: yield* table(value.surfaces, options), unknownFields: ext('surfaces') };
  const imprints: NativeImprintReference[] = [];
  for (const imprint of value.imprints) {
    const { faceId, nextId: allocator, version, vertexIndex: _vertices, edgeIndex: _edges, unknownFields, ...columns } = imprint;
    imprints.push({ faceId, nextId: allocator, version, vertexCount: imprint.vertexIds.length, edgeCount: imprint.edgeIds.length,
      columns: yield* table(columns, options), unknownFields });
  }
  const ref: NativeBodyReference = { id: value.id, version: value.version, nextFaceId: value.nextFaceId, materialId: value.materialId, properties, valid: value.valid,
    volume: value.props.volume, area: value.props.area, mesh, faces, edges, curves, surfaces, imprints, unknownFields: ext('') };
  encodeNativeBodyReference(ref); return ref;
}
