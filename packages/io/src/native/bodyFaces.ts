// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId } from '@pushform/core';
import type { FaceRecord } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader, NativeColumnType } from './columns';
import type { NativeStoredChunk } from './container';
import { streamNativeNumbers } from './numericStream';
import { streamNativeFaceUv, readNativeFaceUv, encodeNativeFaceUvReference, decodeNativeFaceUvReference } from './faceUv';
import type { NativeFaceUv, NativeFaceUvReference } from './faceUv';

interface Counts { faceCount: number; loopCount: number; pointCount: number }
export interface NativeBodyFaceColumns { ids: Uint32Array; geometry: Float64Array; properties: Uint32Array; flags: Uint8Array; faceOffsets: Uint32Array; loopOffsets: Uint32Array; positions: Float64Array }
type Column = keyof NativeBodyFaceColumns;
export interface NativeBodyFacesReference extends Counts { columns: Record<Column, number[]>; uv: NativeFaceUvReference; unknownFields: Uint8Array[] }
export interface NativeBodyFaces extends NativeBodyFaceColumns { uv: NativeFaceUv }
const layout = {
  ids: { id: 4, type: 'uint32', count: (c: Counts) => c.faceCount }, geometry: { id: 5, type: 'float64', count: (c: Counts) => c.faceCount * 16 },
  properties: { id: 6, type: 'uint32', count: (c: Counts) => c.faceCount * 4 }, flags: { id: 7, type: 'uint8', count: (c: Counts) => c.faceCount },
  faceOffsets: { id: 8, type: 'uint32', count: (c: Counts) => c.faceCount + 1 }, loopOffsets: { id: 9, type: 'uint32', count: (c: Counts) => c.loopCount + 1 },
  positions: { id: 10, type: 'float64', count: (c: Counts) => c.pointCount * 3 },
} satisfies Record<Column, { id: number; type: NativeColumnType; count: (c: Counts) => number }>;
const sourceFields = { id: 'ids', plane: 'geometry', basis: 'geometry', loops: 'faceOffsets/loopOffsets/positions', frontMaterialId: 'properties/flags', backMaterialId: 'properties/flags', tagId: 'properties', hidden: 'flags', surfaceId: 'properties/flags', uv: 'uv', uvBack: 'uv' } satisfies Record<keyof FaceRecord, string>;
void sourceFields;
const names = Object.keys(layout) as Column[];
const codec = new NativeRecordCodec({ faceCount: { id: 1, kind: 'uint32', required: true }, loopCount: { id: 2, kind: 'uint32', required: true }, pointCount: { id: 3, kind: 'uint32', required: true },
  ...Object.fromEntries(names.map(name => [name, { id: layout[name].id, kind: 'bytes', required: false } satisfies NativeField])), uv: { id: 11, kind: 'bytes', required: true } });
const fail = (): never => { throw new NativeChunkError('Invalid native body faces'); };
function counts(c: Counts): void {
  for (const n of [c.faceCount, c.loopCount, c.pointCount]) if (!Number.isInteger(n) || n < 0) fail();
  if (c.loopCount < c.faceCount || c.pointCount < c.loopCount || (!c.faceCount && (c.loopCount || c.pointCount)) || c.faceCount * 153 + c.loopCount * 4 + c.pointCount * 24 + 8 > NATIVE_MAX_DECODED_BYTES) fail();
}
function validate(ref: NativeBodyFacesReference): void {
  counts(ref); if (ref.uv.faceCount !== ref.faceCount) fail(); const used = new Set<number>();
  for (const name of names) {
    const ids = ref.columns[name]; if (!!ids.length !== !!layout[name].count(ref)) fail();
    for (const id of ids) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  for (const ids of [ref.uv.kindChunks, ref.uv.offsetChunks, ref.uv.valueChunks]) for (const id of ids) { if (used.has(id)) fail(); used.add(id); }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeBodyFacesReference(ref: NativeBodyFacesReference): Uint8Array {
  validate(ref); const fields: Record<string, NativeScalar> = { faceCount: ref.faceCount, loopCount: ref.loopCount, pointCount: ref.pointCount, uv: encodeNativeFaceUvReference(ref.uv) };
  for (const name of names) if (ref.columns[name].length) fields[name] = encodeNativeIds(ref.columns[name]);
  return codec.encode({ fields, unknownFields: ref.unknownFields });
}
export function decodeNativeBodyFacesReference(bytes: Uint8Array): NativeBodyFacesReference {
  const decoded = codec.decode(bytes), f = decoded.fields, columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = decodeNativeIds(f[name] as Uint8Array | undefined);
  const ref = { faceCount: f.faceCount as number, loopCount: f.loopCount as number, pointCount: f.pointCount as number, columns, uv: decodeNativeFaceUvReference(f.uv as Uint8Array), unknownFields: decoded.unknownFields }; validate(ref); return ref;
}
/** Streams the face decoration layer only; the kernel mesh remains a separate immutable value. */
export async function* streamNativeBodyFaces(faces: ReadonlyMap<FaceLocalId, FaceRecord>, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeBodyFacesReference> {
  options.signal?.throwIfAborted(); const size: Counts = { faceCount: faces.size, loopCount: 0, pointCount: 0 };
  for (const face of faces.values()) { if (!face.loops.length) return fail(); size.loopCount += face.loops.length;
    for (const loop of face.loops) { if (!loop.length) return fail(); size.pointCount += loop.length; }
  }
  counts(size);
  function* values(column: Column): Generator<number> {
    let offset = 0;
    for (const [id, face] of faces) {
      if (face.id !== id) return fail();
      switch (column) {
        case 'ids': yield id; break;
        case 'geometry':
          if (face.plane.n.length !== 3) return fail(); yield* face.plane.n; yield face.plane.d;
          for (const key of ['origin', 'u', 'v', 'n'] as const) { if (face.basis[key].length !== 3) return fail(); yield* face.basis[key]; } break;
        case 'properties': yield face.frontMaterialId === null ? 0 : face.frontMaterialId; yield face.backMaterialId === null ? 0 : face.backMaterialId; yield face.tagId; yield face.surfaceId === null ? 0 : face.surfaceId; break;
        case 'flags': if (typeof face.hidden !== 'boolean') return fail(); yield Number(face.frontMaterialId !== null) | (Number(face.backMaterialId !== null) << 1) | (Number(face.hidden) << 2) | (Number(face.surfaceId !== null) << 3); break;
        case 'faceOffsets': yield offset; offset += face.loops.length; break;
        case 'loopOffsets': for (const loop of face.loops) { yield offset; offset += loop.length; } break;
        case 'positions': for (const loop of face.loops) for (const p of loop) { if (p.length !== 3) return fail(); yield* p; } break;
      }
    }
    if (column === 'faceOffsets' || column === 'loopOffsets') yield offset;
  }
  const columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = yield* streamNativeNumbers(values(name), layout[name].type, layout[name].count(size), nextId, options);
  const uv = yield* streamNativeFaceUv(faces, nextId, options); const ref = { ...size, columns, uv, unknownFields: [] }; validate(ref); return ref;
}
function offsets(values: Uint32Array, end: number): void {
  if (values[0] !== 0 || values[values.length - 1] !== end) fail();
  for (let i = 1; i < values.length; i++) if (values[i]! <= values[i - 1]!) fail();
}
export async function readNativeBodyFaces(ref: NativeBodyFacesReference, reader: NativeColumnReader,
  hasMaterial: (id: number) => boolean, hasTag: (id: number) => boolean, hasSurface: (id: number) => boolean, signal?: AbortSignal): Promise<NativeBodyFaces> {
  validate(ref); const result = {} as NativeBodyFaceColumns;
  for (const name of names) { const value = await reader.read(layout[name].type, layout[name].count(ref), ref.columns[name], signal);
    Object.defineProperty(result, name, { value, enumerable: true }); if (name === 'ids') reader.validateUniqueIds(result.ids, signal);
  }
  offsets(result.faceOffsets, ref.loopCount); offsets(result.loopOffsets, ref.pointCount);
  for (const value of result.geometry) if (!Number.isFinite(value)) return fail();
  for (const value of result.positions) if (!Number.isFinite(value)) return fail();
  for (let row = 0; row < ref.faceCount; row++) {
    const flag = result.flags[row]!, at = row * 4, surface = result.properties[at + 3]!;
    if (flag > 15 || !hasTag(result.properties[at + 2]!) || (flag & 8 ? !hasSurface(surface) : surface !== 0)) return fail();
    for (let side = 0; side < 2; side++) { const material = result.properties[at + side]!; if (flag & (1 << side) ? !hasMaterial(material) : material !== 0) return fail(); }
  }
  return { ...result, uv: await readNativeFaceUv(ref.uv, reader, signal) };
}
