// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommonAttrs, Sketch } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader } from './columns';
import type { NativeStoredChunk } from './container';
import type { NativeCommonPropertyReader } from './commonProperty';
import type { NativeIdIndex } from './idIndex';
import type { PackedPointIndex } from '@pushform/geom';
import { streamNativeSketchVertices, readNativeSketchVertices, encodeNativeSketchVerticesReference, decodeNativeSketchVerticesReference } from './sketchVertices';
import type { NativeSketchVertices, NativeSketchVerticesReference } from './sketchVertices';
import { streamNativeSketchEdges, readNativeSketchEdges, encodeNativeSketchEdgesReference, decodeNativeSketchEdgesReference } from './sketchEdges';
import type { NativeSketchEdges, NativeSketchEdgesReference } from './sketchEdges';
import { streamNativeSketchFaces, readNativeSketchFaces, encodeNativeSketchFacesReference, decodeNativeSketchFacesReference } from './sketchFaces';
import type { NativeSketchFaces, NativeSketchFacesReference } from './sketchFaces';
import { streamNativeSketchCurves, readNativeSketchCurves, validateNativeSketchCurveEdges, encodeNativeSketchCurvesReference, decodeNativeSketchCurvesReference } from './sketchCurves';
import type { NativeSketchCurves, NativeSketchCurvesReference } from './sketchCurves';

export interface NativeSketchReference { vertices: NativeSketchVerticesReference; edges: NativeSketchEdgesReference; faces: NativeSketchFacesReference; curves: NativeSketchCurvesReference; unknownFields: Uint8Array[] }
export type NativeSketchExtensions = Map<string, Uint8Array[]>;
export interface NativePackedSketch {
  vertices: NativeSketchVertices; edges: NativeSketchEdges; faces: NativeSketchFaces; curves: NativeSketchCurves;
  indexes: { vertices: NativeIdIndex; edges: NativeIdIndex; faces: NativeIdIndex; curves: NativeIdIndex };
  extensions: NativeSketchExtensions;
  vertexSpatial: PackedPointIndex;
}
const codec = new NativeRecordCodec({ vertices: { id: 1, kind: 'bytes', required: true }, edges: { id: 2, kind: 'bytes', required: true }, faces: { id: 3, kind: 'bytes', required: true }, curves: { id: 4, kind: 'bytes', required: true } });
function validate(ref: NativeSketchReference): void {
  const v = ref.vertices, e = ref.edges, f = ref.faces, c = ref.curves;
  const bytes = v.count * 28 + e.count * 21 + f.faceCount * 159 + f.loopCount * 4 + f.referenceCount * 5 + f.uv.valueCount * 8 +
    c.count * 85 + c.referenceCount * 4 + 16 + (v.count * 2 + e.count + f.faceCount + c.count) * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > NATIVE_MAX_DECODED_BYTES) throw new NativeChunkError('Native sketch exceeds allocation budget');
  const used = new Set<number>();
  for (const ids of [v.idChunks, v.positionChunks, e.idChunks, e.rowChunks, e.flagChunks, ...Object.values(f.columns),
    f.uv.kindChunks, f.uv.offsetChunks, f.uv.valueChunks, ...Object.values(c.columns)]) {
    for (const id of ids) { if (used.has(id)) throw new NativeChunkError('Duplicate native sketch chunk reference'); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) throw new NativeChunkError('Too many native sketch chunks');
}
export function encodeNativeSketchReference(ref: NativeSketchReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { vertices: encodeNativeSketchVerticesReference(ref.vertices), edges: encodeNativeSketchEdgesReference(ref.edges),
    faces: encodeNativeSketchFacesReference(ref.faces), curves: encodeNativeSketchCurvesReference(ref.curves) }, unknownFields: ref.unknownFields });
}
export function decodeNativeSketchReference(bytes: Uint8Array): NativeSketchReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref = { vertices: decodeNativeSketchVerticesReference(f.vertices as Uint8Array), edges: decodeNativeSketchEdgesReference(f.edges as Uint8Array),
    faces: decodeNativeSketchFacesReference(f.faces as Uint8Array), curves: decodeNativeSketchCurvesReference(f.curves as Uint8Array), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
function scopes(ref: NativeSketchReference): [string, { unknownFields: Uint8Array[] }][] {
  return [['', ref], ['vertices', ref.vertices], ['edges', ref.edges], ['faces', ref.faces], ['faces.uv', ref.faces.uv], ['curves', ref.curves]];
}
export async function* streamNativeSketch(
  sketch: Sketch, propertyId: (value: CommonAttrs) => number, nextId: () => number,
  options: NativeChunkOptions = {}, extensions: NativeSketchExtensions = new Map(),
): AsyncGenerator<NativeStoredChunk, NativeSketchReference> {
  const vertices = yield* streamNativeSketchVertices(sketch.vertices, nextId, options);
  const edges = yield* streamNativeSketchEdges(sketch.edges, propertyId, nextId, options);
  const faces = yield* streamNativeSketchFaces(sketch.faces, propertyId, nextId, options);
  const curves = yield* streamNativeSketchCurves(sketch.curves, nextId, options);
  const ref: NativeSketchReference = { vertices, edges, faces, curves, unknownFields: [] };
  for (const [name, value] of scopes(ref)) value.unknownFields = extensions.get(name) ?? [];
  validate(ref); return ref;
}

/** Stage a complete packed sketch with typed ID and vertex proximity indexes. */
export async function readNativeSketch(
  ref: NativeSketchReference, columns: NativeColumnReader, properties: NativeCommonPropertyReader, hasMaterial: (id: number) => boolean, signal?: AbortSignal,
): Promise<NativePackedSketch> {
  validate(ref);
  const vertices = await readNativeSketchVertices(ref.vertices, columns, signal), vertexIndex = columns.indexIds(vertices.ids, signal);
  const curves = await readNativeSketchCurves(ref.curves, columns, signal), curveIndex = columns.indexIds(curves.ids, signal);
  const edges = await readNativeSketchEdges(ref.edges, columns, properties, id => vertexIndex.has(id), id => curveIndex.has(id), signal);
  const edgeIndex = columns.indexIds(edges.ids, signal); validateNativeSketchCurveEdges(curves, id => edgeIndex.has(id));
  const faces = await readNativeSketchFaces(ref.faces, columns, properties, id => edgeIndex.has(id), hasMaterial, signal), faceIndex = columns.indexIds(faces.ids, signal);
  for (const id of edges.ids) if (vertexIndex.has(id)) throw new NativeChunkError('Native sketch entity ID collision');
  for (const id of faces.ids) if (vertexIndex.has(id) || edgeIndex.has(id)) throw new NativeChunkError('Native sketch entity ID collision');
  // Edge directions must form a closed ring for every outer boundary and hole.
  for (let loop = 0; loop + 1 < faces.loopOffsets.length; loop++) {
    let first = -1, end = -1;
    for (let at = faces.loopOffsets[loop]!; at < faces.loopOffsets[loop + 1]!; at++) {
      const row = edgeIndex.find(faces.edgeIds[at]!), forward = faces.forward[at] === 1;
      const a = edges.rows[row * 4 + (forward ? 0 : 1)]!, b = edges.rows[row * 4 + (forward ? 1 : 0)]!;
      if (first === -1) first = a; else if (a !== end) throw new NativeChunkError('Discontinuous native face loop'); end = b;
    }
    if (end !== first) throw new NativeChunkError('Open native face loop');
  }
  const extensions: NativeSketchExtensions = new Map(); for (const [name, value] of scopes(ref)) if (value.unknownFields.length) extensions.set(name, value.unknownFields);
  const vertexSpatial = columns.indexPoints(vertices.positions, signal);
  return { vertices, edges, faces, curves, indexes: { vertices: vertexIndex, edges: edgeIndex, faces: faceIndex, curves: curveIndex }, extensions, vertexSpatial };
}
