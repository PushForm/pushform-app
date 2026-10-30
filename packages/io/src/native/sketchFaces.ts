// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id } from '@pushform/core';
import type { CommonAttrs, SketchFace } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader, NativeColumnType } from './columns';
import type { NativeStoredChunk } from './container';
import type { NativeCommonPropertyReader } from './commonProperty';
import { streamNativeNumbers } from './numericStream';
import { streamNativeFaceUv, readNativeFaceUv, encodeNativeFaceUvReference, decodeNativeFaceUvReference } from './faceUv';
import type { NativeFaceUv, NativeFaceUvReference } from './faceUv';

interface Counts { faceCount: number; loopCount: number; referenceCount: number }
export interface NativeSketchFaceColumns {
  ids: Uint32Array; geometry: Float64Array; properties: Uint32Array; materialFlags: Uint8Array;
  faceOffsets: Uint32Array; loopOffsets: Uint32Array; edgeIds: Uint32Array; forward: Uint8Array;
}
type Column = keyof NativeSketchFaceColumns;
export interface NativeSketchFacesReference extends Counts { columns: Record<Column, number[]>; uv: NativeFaceUvReference; unknownFields: Uint8Array[] }
export interface NativeSketchFaces extends NativeSketchFaceColumns { uv: NativeFaceUv }
const layout = {
  ids: { id: 4, type: 'uint32', count: (c: Counts) => c.faceCount },
  geometry: { id: 5, type: 'float64', count: (c: Counts) => c.faceCount * 16 },
  properties: { id: 6, type: 'uint32', count: (c: Counts) => c.faceCount * 3 },
  materialFlags: { id: 7, type: 'uint8', count: (c: Counts) => c.faceCount },
  faceOffsets: { id: 8, type: 'uint32', count: (c: Counts) => c.faceCount + 1 },
  loopOffsets: { id: 9, type: 'uint32', count: (c: Counts) => c.loopCount + 1 },
  edgeIds: { id: 10, type: 'uint32', count: (c: Counts) => c.referenceCount },
  forward: { id: 11, type: 'uint8', count: (c: Counts) => c.referenceCount },
} satisfies Record<Column, { id: number; type: NativeColumnType; count: (c: Counts) => number }>;
const columns = Object.keys(layout) as Column[];
const sourceFields = { id: 'ids', plane: 'geometry', basis: 'geometry', loops: 'faceOffsets/loopOffsets/edgeIds/forward', frontMaterialId: 'properties/materialFlags', backMaterialId: 'properties/materialFlags', uv: 'uv', uvBack: 'uv' } satisfies Record<keyof Omit<SketchFace, keyof CommonAttrs>, string>;
void sourceFields;
const codec = new NativeRecordCodec({ faceCount: { id: 1, kind: 'uint32', required: true }, loopCount: { id: 2, kind: 'uint32', required: true }, referenceCount: { id: 3, kind: 'uint32', required: true },
  ...Object.fromEntries(columns.map(name => [name, { id: layout[name].id, kind: 'bytes', required: false } satisfies NativeField])), uv: { id: 12, kind: 'bytes', required: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native sketch faces'); };
function counts(c: Counts): void {
  for (const n of [c.faceCount, c.loopCount, c.referenceCount]) if (!Number.isInteger(n) || n < 0) fail();
  if (c.loopCount < c.faceCount || c.referenceCount < c.loopCount || (!c.faceCount && (c.loopCount || c.referenceCount)) ||
      c.faceCount * 149 + c.loopCount * 4 + c.referenceCount * 5 + 8 > NATIVE_MAX_DECODED_BYTES) fail();
}
function validate(ref: NativeSketchFacesReference): void {
  counts(ref); if (ref.uv.faceCount !== ref.faceCount) fail(); const used = new Set<number>();
  for (const name of columns) {
    const ids = ref.columns[name]; if (!!ids.length !== !!layout[name].count(ref)) fail();
    for (const id of ids) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  for (const ids of [ref.uv.kindChunks, ref.uv.offsetChunks, ref.uv.valueChunks]) for (const id of ids) { if (used.has(id)) fail(); used.add(id); }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeSketchFacesReference(ref: NativeSketchFacesReference): Uint8Array {
  validate(ref); const fields: Record<string, NativeScalar> = { faceCount: ref.faceCount, loopCount: ref.loopCount, referenceCount: ref.referenceCount, uv: encodeNativeFaceUvReference(ref.uv) };
  for (const name of columns) if (ref.columns[name].length) fields[name] = encodeNativeIds(ref.columns[name]);
  return codec.encode({ fields, unknownFields: ref.unknownFields });
}
export function decodeNativeSketchFacesReference(bytes: Uint8Array): NativeSketchFacesReference {
  const decoded = codec.decode(bytes), f = decoded.fields, refs = {} as Record<Column, number[]>;
  for (const name of columns) refs[name] = decodeNativeIds(f[name] as Uint8Array | undefined);
  const ref = { faceCount: f.faceCount as number, loopCount: f.loopCount as number, referenceCount: f.referenceCount as number, columns: refs, uv: decodeNativeFaceUvReference(f.uv as Uint8Array), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
export async function* streamNativeSketchFaces(
  faces: ReadonlyMap<Id, SketchFace>, propertyId: (face: SketchFace) => number, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeSketchFacesReference> {
  options.signal?.throwIfAborted(); const size: Counts = { faceCount: faces.size, loopCount: 0, referenceCount: 0 };
  for (const face of faces.values()) {
    if (!face.loops.length) return fail(); size.loopCount += face.loops.length;
    for (const loop of face.loops) { if (!loop.length) return fail(); size.referenceCount += loop.length; }
  }
  counts(size);
  function* values(column: Column): Generator<number> {
    let offset = 0;
    for (const [id, face] of faces) {
      if (face.id !== id) return fail();
      switch (column) {
        case 'ids': yield id; break;
        case 'geometry': {
          if (face.plane.n.length !== 3) return fail(); yield* face.plane.n; yield face.plane.d;
          for (const key of ['origin', 'u', 'v', 'n'] as const) { if (face.basis[key].length !== 3) return fail(); yield* face.basis[key]; } break;
        }
        case 'properties': { const property = propertyId(face); if (!property) return fail(); yield property; yield face.frontMaterialId === null ? 0 : face.frontMaterialId; yield face.backMaterialId === null ? 0 : face.backMaterialId; break; }
        case 'materialFlags': yield Number(face.frontMaterialId !== null) | (Number(face.backMaterialId !== null) << 1); break;
        case 'faceOffsets': yield offset; offset += face.loops.length; break;
        case 'loopOffsets': for (const loop of face.loops) { yield offset; offset += loop.length; } break;
        case 'edgeIds': for (const loop of face.loops) for (const ref of loop) yield ref.edgeId; break;
        case 'forward': for (const loop of face.loops) for (const ref of loop) { if (typeof ref.forward !== 'boolean') return fail(); yield Number(ref.forward); } break;
      }
    }
    if (column === 'faceOffsets' || column === 'loopOffsets') yield offset;
  }
  const refs = {} as Record<Column, number[]>;
  for (const column of columns) refs[column] = yield* streamNativeNumbers(values(column), layout[column].type, layout[column].count(size), nextId, options);
  const uv = yield* streamNativeFaceUv(faces, nextId, options);
  const ref = { ...size, columns: refs, uv, unknownFields: [] }; validate(ref); return ref;
}
function offsets(values: Uint32Array, end: number): void {
  if (values[0] !== 0 || values[values.length - 1] !== end) fail();
  for (let i = 1; i < values.length; i++) if (values[i]! <= values[i - 1]!) fail();
}
export async function readNativeSketchFaces(
  ref: NativeSketchFacesReference, reader: NativeColumnReader, properties: NativeCommonPropertyReader,
  hasEdge: (id: number) => boolean, hasMaterial: (id: number) => boolean, signal?: AbortSignal,
): Promise<NativeSketchFaces> {
  validate(ref); const result = {} as NativeSketchFaceColumns;
  // Assigning by column name preserves the matching typed-array contract in layout.
  for (const column of columns) {
    const value = await reader.read(layout[column].type, layout[column].count(ref), ref.columns[column], signal);
    Object.defineProperty(result, column, { value, enumerable: true });
    if (column === 'ids') reader.validateUniqueIds(result.ids, signal);
  }
  offsets(result.faceOffsets, ref.loopCount); offsets(result.loopOffsets, ref.referenceCount);
  for (const n of result.geometry) if (!Number.isFinite(n)) return fail();
  for (let i = 0; i < ref.faceCount; i++) {
    const flags = result.materialFlags[i]!, at = i * 3; if (flags > 3) return fail(); properties.get(result.properties[at]!);
    for (let side = 0; side < 2; side++) {
      const material = result.properties[at + side + 1]!;
      if (flags & (1 << side) ? !hasMaterial(material) : material !== 0) return fail();
    }
  }
  for (let i = 0; i < ref.referenceCount; i++) if (result.forward[i]! > 1 || !hasEdge(result.edgeIds[i]!)) return fail();
  return { ...result, uv: await readNativeFaceUv(ref.uv, reader, signal) };
}
