// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImprintGraph } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader } from './columns';
import type { NativeIdIndex } from './idIndex';
import type { NativeStoredChunk } from './container';
import { streamNativeNumbers } from './numericStream';

interface Counts { vertexCount: number; edgeCount: number }
interface Columns { vertexIds: Uint32Array; positions: Float64Array; edgeIds: Uint32Array; endpoints: Uint32Array; curves: Uint32Array; flags: Uint8Array }
type Column = keyof Columns;
export interface NativeImprintReference extends Counts { faceId: number; nextId: number; version: number; columns: Record<Column, number[]>; unknownFields: Uint8Array[] }
export interface NativePackedImprint extends Columns { faceId: number; nextId: number; version: number; vertexIndex: NativeIdIndex; edgeIndex: NativeIdIndex; unknownFields: Uint8Array[] }
const names = ['vertexIds', 'positions', 'edgeIds', 'endpoints', 'curves', 'flags'] as const;
const codec = new NativeRecordCodec({ faceId: { id: 1, kind: 'uint32', required: true }, nextId: { id: 2, kind: 'uint53', required: true },
  version: { id: 3, kind: 'uint53', required: true }, vertexCount: { id: 4, kind: 'uint32', required: true }, edgeCount: { id: 5, kind: 'uint32', required: true },
  vertexIds: { id: 6, kind: 'bytes', required: false }, positions: { id: 7, kind: 'bytes', required: false },
  edgeIds: { id: 8, kind: 'bytes', required: false }, endpoints: { id: 9, kind: 'bytes', required: false },
  curves: { id: 10, kind: 'bytes', required: false }, flags: { id: 11, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native imprint graph'); };
const size = (c: Counts, name: Column): number => name === 'vertexIds' ? c.vertexCount : name === 'positions' ? c.vertexCount * 2 : c.edgeCount * (name === 'endpoints' ? 2 : 1);
function validate(ref: NativeImprintReference): void {
  for (const n of [ref.faceId, ref.vertexCount, ref.edgeCount]) if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) fail();
  if (!Number.isSafeInteger(ref.nextId) || ref.nextId < 1 || ref.nextId > 0x1_0000_0000 || !Number.isSafeInteger(ref.version) || ref.version < 0 ||
    ref.vertexCount * 24 + ref.edgeCount * 21 > NATIVE_MAX_DECODED_BYTES) fail();
  const used = new Set<number>();
  for (const name of names) {
    if (!!ref.columns[name].length !== !!size(ref, name)) fail();
    for (const id of ref.columns[name]) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeImprintReference(ref: NativeImprintReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { faceId: ref.faceId, nextId: ref.nextId, version: ref.version, vertexCount: ref.vertexCount, edgeCount: ref.edgeCount,
    ...Object.fromEntries(names.filter(name => ref.columns[name].length).map(name => [name, encodeNativeIds(ref.columns[name])])) }, unknownFields: ref.unknownFields });
}
export function decodeNativeImprintReference(bytes: Uint8Array): NativeImprintReference {
  const decoded = codec.decode(bytes), f = decoded.fields, columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = decodeNativeIds(f[name] as Uint8Array | undefined);
  const ref = { faceId: f.faceId as number, nextId: f.nextId as number, version: f.version as number,
    vertexCount: f.vertexCount as number, edgeCount: f.edgeCount as number, columns, unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
export async function* streamNativeImprint(faceId: number, graph: ImprintGraph, nextChunkId: () => number,
  options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeImprintReference> {
  options.signal?.throwIfAborted();
  const ref: NativeImprintReference = { faceId, nextId: graph.nextId, version: graph.version, vertexCount: graph.vertices.size, edgeCount: graph.edges.size,
    columns: { vertexIds: [], positions: [], edgeIds: [], endpoints: [], curves: [], flags: [] }, unknownFields: [] };
  if (ref.vertexCount * 24 + ref.edgeCount * 21 > NATIVE_MAX_DECODED_BYTES) return fail();
  function* values(name: Column): Generator<number> {
    if (name === 'vertexIds' || name === 'positions') {
      for (const [id, point] of graph.vertices) {
        if (id >= graph.nextId || point.length !== 2) return fail();
        if (name === 'vertexIds') yield id; else yield* point;
      }
    } else for (const [id, edge] of graph.edges) {
      if (edge.id !== id || id >= graph.nextId || graph.vertices.has(id) || edge.a === edge.b || !graph.vertices.has(edge.a) || !graph.vertices.has(edge.b)) return fail();
      switch (name) {
        case 'edgeIds': yield id; break;
        case 'endpoints': yield edge.a; yield edge.b; break;
        case 'curves': yield edge.curveId ?? 0; break;
        case 'flags': yield (edge.soft ? 1 : 0) | (edge.smooth ? 2 : 0) | (edge.hidden ? 4 : 0) | (edge.curveId === null ? 0 : 8); break;
      }
    }
  }
  for (const name of names) ref.columns[name] = yield* streamNativeNumbers(values(name), name === 'positions' ? 'float64' : name === 'flags' ? 'uint8' : 'uint32', size(ref, name), nextChunkId, options);
  validate(ref); return ref;
}
export async function readNativeImprint(ref: NativeImprintReference, reader: NativeColumnReader, hasFace: (id: number) => boolean,
  hasCurve: (id: number) => boolean, signal?: AbortSignal): Promise<NativePackedImprint> {
  validate(ref); if (!hasFace(ref.faceId)) return fail();
  const result = {} as Columns;
  for (const name of names) Object.defineProperty(result, name, { value: await reader.read(name === 'positions' ? 'float64' : name === 'flags' ? 'uint8' : 'uint32', size(ref, name), ref.columns[name], signal), enumerable: true });
  const vertexIndex = reader.indexIds(result.vertexIds, signal), edgeIndex = reader.indexIds(result.edgeIds, signal);
  for (const value of result.positions) if (!Number.isFinite(value)) return fail();
  for (const id of result.vertexIds) if (id >= ref.nextId) return fail();
  for (let row = 0; row < ref.edgeCount; row++) {
    const id = result.edgeIds[row]!, a = result.endpoints[row * 2]!, b = result.endpoints[row * 2 + 1]!, flags = result.flags[row]!;
    if (id >= ref.nextId || vertexIndex.has(id) || a === b || !vertexIndex.has(a) || !vertexIndex.has(b) || flags > 15 ||
      (flags & 8 ? !hasCurve(result.curves[row]!) : result.curves[row] !== 0)) return fail();
  }
  return { ...result, faceId: ref.faceId, nextId: ref.nextId, version: ref.version, vertexIndex, edgeIndex, unknownFields: ref.unknownFields };
}
