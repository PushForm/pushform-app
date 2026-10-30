// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SurfaceId } from '@pushform/core';
import type { SurfaceRecord } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader } from './columns';
import type { NativeStoredChunk } from './container';
import { streamNativeNumbers } from './numericStream';

export interface NativeBodySurfaces { ids: Uint32Array; curves: Uint32Array; flags: Uint8Array; offsets: Uint32Array; faces: Uint32Array }
type Column = keyof NativeBodySurfaces;
export interface NativeBodySurfacesReference { count: number; referenceCount: number; columns: Record<Column, number[]>; unknownFields: Uint8Array[] }
const names = ['ids', 'curves', 'flags', 'offsets', 'faces'] as const;
const codec = new NativeRecordCodec({ count: { id: 1, kind: 'uint32', required: true }, referenceCount: { id: 2, kind: 'uint32', required: true },
  ids: { id: 3, kind: 'bytes', required: false }, curves: { id: 4, kind: 'bytes', required: false }, flags: { id: 5, kind: 'bytes', required: false }, offsets: { id: 6, kind: 'bytes', required: false }, faces: { id: 7, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native body surfaces'); };
const size = (ref: Pick<NativeBodySurfacesReference, 'count' | 'referenceCount'>, name: Column): number => name === 'faces' ? ref.referenceCount : ref.count + (name === 'offsets' ? 1 : 0);
function validate(ref: NativeBodySurfacesReference): void {
  if (!Number.isInteger(ref.count) || ref.count < 0 || !Number.isInteger(ref.referenceCount) || ref.referenceCount < 0 ||
    (!ref.count && ref.referenceCount) || ref.count * 13 + ref.referenceCount * 4 + 4 > NATIVE_MAX_DECODED_BYTES) fail();
  const used = new Set<number>();
  for (const name of names) {
    if (!!ref.columns[name].length !== !!size(ref, name)) fail();
    for (const id of ref.columns[name]) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeBodySurfacesReference(ref: NativeBodySurfacesReference): Uint8Array {
  validate(ref);
  return codec.encode({ fields: { count: ref.count, referenceCount: ref.referenceCount,
    ...Object.fromEntries(names.filter(name => ref.columns[name].length).map(name => [name, encodeNativeIds(ref.columns[name])])) }, unknownFields: ref.unknownFields });
}
export function decodeNativeBodySurfacesReference(bytes: Uint8Array): NativeBodySurfacesReference {
  const decoded = codec.decode(bytes), columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = decodeNativeIds(decoded.fields[name] as Uint8Array | undefined);
  const ref = { count: decoded.fields.count as number, referenceCount: decoded.fields.referenceCount as number, columns, unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
/** Stream each column without a second collection of surfaces or face references. */
export async function* streamNativeBodySurfaces(surfaces: ReadonlyMap<SurfaceId, SurfaceRecord>, nextId: () => number,
  options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeBodySurfacesReference> {
  options.signal?.throwIfAborted();
  let referenceCount = 0; for (const surface of surfaces.values()) referenceCount += surface.faceIds.length;
  const ref: NativeBodySurfacesReference = { count: surfaces.size, referenceCount, columns: { ids: [], curves: [], flags: [], offsets: [], faces: [] }, unknownFields: [] };
  if (!Number.isSafeInteger(referenceCount) || surfaces.size * 13 + referenceCount * 4 + 4 > NATIVE_MAX_DECODED_BYTES) return fail();
  function* values(name: Column): Generator<number> {
    let offset = 0;
    for (const [id, surface] of surfaces) {
      if (id !== surface.id) return fail();
      switch (name) {
        case 'ids': yield id; break;
        case 'curves': yield surface.curveId ?? 0; break;
        case 'flags': yield surface.curveId === null ? 0 : 1; break;
        case 'offsets': yield offset; offset += surface.faceIds.length; break;
        case 'faces': yield* surface.faceIds; break;
      }
    }
    if (name === 'offsets') yield offset;
  }
  for (const name of names) ref.columns[name] = yield* streamNativeNumbers(values(name), name === 'flags' ? 'uint8' : 'uint32', size(ref, name), nextId, options);
  validate(ref); return ref;
}
export async function readNativeBodySurfaces(ref: NativeBodySurfacesReference, reader: NativeColumnReader,
  hasFace: (id: number) => boolean, hasCurve: (id: number) => boolean, signal?: AbortSignal): Promise<NativeBodySurfaces> {
  validate(ref); const result = {} as NativeBodySurfaces;
  for (const name of names) {
    const value = await reader.read(name === 'flags' ? 'uint8' : 'uint32', size(ref, name), ref.columns[name], signal);
    Object.defineProperty(result, name, { value, enumerable: true });
    if (name === 'ids') reader.validateUniqueIds(result.ids, signal);
  }
  if (result.offsets[0] !== 0 || result.offsets[ref.count] !== ref.referenceCount) return fail();
  for (let i = 0; i < ref.count; i++) {
    if (result.offsets[i]! > result.offsets[i + 1]! || result.flags[i]! > 1 ||
      (result.flags[i] ? !hasCurve(result.curves[i]!) : result.curves[i] !== 0)) return fail();
  }
  for (const id of result.faces) if (!hasFace(id)) return fail();
  return result;
}
