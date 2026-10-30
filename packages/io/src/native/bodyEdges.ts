// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { EdgeKey, EdgeRecord } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader, NativeColumnType } from './columns';
import type { NativeStoredChunk } from './container';
import { streamNativeNumbers } from './numericStream';
import { parseNativeEdgeKey } from './edgeKey';
import type { NativeEdgeIndex } from './edgeKey';
interface Counts { count: number; pointCount: number }
export interface NativeBodyEdgeColumns { rows: Uint32Array; flags: Uint8Array; offsets: Uint32Array; positions: Float64Array }
type Column = keyof NativeBodyEdgeColumns;
export interface NativeBodyEdgesReference extends Counts { columns: Record<Column, number[]>; unknownFields: Uint8Array[] }
export interface NativeBodyEdges extends NativeBodyEdgeColumns { index: NativeEdgeIndex }
const layout = {
  rows: { id: 3, type: 'uint32', count: (c: Counts) => c.count * 5 }, flags: { id: 4, type: 'uint8', count: (c: Counts) => c.count },
  offsets: { id: 5, type: 'uint32', count: (c: Counts) => c.count + 1 }, positions: { id: 6, type: 'float64', count: (c: Counts) => c.pointCount * 3 },
} satisfies Record<Column, { id: number; type: NativeColumnType; count: (c: Counts) => number }>;
const sourceFields = { key: 'rows[0..2]', faceA: 'rows[0]', faceB: 'rows[1]', polyline: 'offsets/positions', soft: 'flags', smooth: 'flags', hidden: 'flags', tagId: 'rows[3]', curveId: 'rows[4]/flags' } satisfies Record<keyof EdgeRecord, string>;
void sourceFields;
const names = Object.keys(layout) as Column[];
const codec = new NativeRecordCodec({ count: { id: 1, kind: 'uint32', required: true }, pointCount: { id: 2, kind: 'uint32', required: true },
  ...Object.fromEntries(names.map(name => [name, { id: layout[name].id, kind: 'bytes', required: false } satisfies NativeField])) });
const fail = (): never => { throw new NativeChunkError('Invalid native body edges'); };
function counts(c: Counts): void {
  if (!Number.isInteger(c.count) || c.count < 0 || !Number.isInteger(c.pointCount) || c.pointCount < c.count * 2 || (!c.count && c.pointCount) ||
      c.count * 29 + c.pointCount * 24 + 4 > NATIVE_MAX_DECODED_BYTES) fail();
}
function validate(ref: NativeBodyEdgesReference): void {
  counts(ref); const used = new Set<number>();
  for (const name of names) {
    const ids = ref.columns[name]; if (!!ids.length !== !!layout[name].count(ref)) fail();
    for (const id of ids) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeBodyEdgesReference(ref: NativeBodyEdgesReference): Uint8Array {
  validate(ref); const fields: Record<string, NativeScalar> = { count: ref.count, pointCount: ref.pointCount };
  for (const name of names) if (ref.columns[name].length) fields[name] = encodeNativeIds(ref.columns[name]);
  return codec.encode({ fields, unknownFields: ref.unknownFields });
}
export function decodeNativeBodyEdgesReference(bytes: Uint8Array): NativeBodyEdgesReference {
  const decoded = codec.decode(bytes), f = decoded.fields, columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = decodeNativeIds(f[name] as Uint8Array | undefined);
  const ref = { count: f.count as number, pointCount: f.pointCount as number, columns, unknownFields: decoded.unknownFields }; validate(ref); return ref;
}
export async function* streamNativeBodyEdges(edges: ReadonlyMap<EdgeKey, EdgeRecord>, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeBodyEdgesReference> {
  options.signal?.throwIfAborted(); const size: Counts = { count: edges.size, pointCount: 0 };
  for (const edge of edges.values()) { if (edge.polyline.length < 2) return fail(); size.pointCount += edge.polyline.length; } counts(size);
  function* values(column: Column): Generator<number> {
    let offset = 0;
    for (const [key, edge] of edges) {
      if (key !== edge.key) return fail();
      switch (column) {
        case 'rows': { const [a, b, run] = parseNativeEdgeKey(key); if (a !== edge.faceA || b !== edge.faceB) return fail(); yield a; yield b; yield run; yield edge.tagId; yield edge.curveId === null ? 0 : edge.curveId; break; }
        case 'flags': if (typeof edge.soft !== 'boolean' || typeof edge.smooth !== 'boolean' || typeof edge.hidden !== 'boolean') return fail();
          yield Number(edge.soft) | (Number(edge.smooth) << 1) | (Number(edge.hidden) << 2) | (edge.curveId !== null ? 8 : 0); break;
        case 'offsets': yield offset; offset += edge.polyline.length; break;
        case 'positions': for (const p of edge.polyline) { if (p.length !== 3) return fail(); yield* p; } break;
      }
    }
    if (column === 'offsets') yield offset;
  }
  const columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = yield* streamNativeNumbers(values(name), layout[name].type, layout[name].count(size), nextId, options);
  const ref = { ...size, columns, unknownFields: [] }; validate(ref); return ref;
}
export async function readNativeBodyEdges(ref: NativeBodyEdgesReference, reader: NativeColumnReader,
  hasFace: (id: number) => boolean, hasTag: (id: number) => boolean, hasCurve: (id: number) => boolean, signal?: AbortSignal): Promise<NativeBodyEdges> {
  validate(ref); const result = {} as NativeBodyEdgeColumns; let index: NativeEdgeIndex | undefined;
  for (const name of names) {
    const value = await reader.read(layout[name].type, layout[name].count(ref), ref.columns[name], signal);
    Object.defineProperty(result, name, { value, enumerable: true }); if (name === 'rows') index = reader.indexEdgeKeys(result.rows, signal);
  }
  if (result.offsets[0] !== 0 || result.offsets[result.offsets.length - 1] !== ref.pointCount) return fail();
  for (let i = 0; i < ref.count; i++) {
    const at = i * 5, flag = result.flags[i]!, curve = result.rows[at + 4]!;
    if (result.offsets[i + 1]! - result.offsets[i]! < 2 || flag > 15 || !hasFace(result.rows[at]!) || !hasFace(result.rows[at + 1]!) ||
        !hasTag(result.rows[at + 3]!) || (flag & 8 ? !hasCurve(curve) : curve !== 0)) return fail();
  }
  for (const n of result.positions) if (!Number.isFinite(n)) return fail();
  return { ...result, index: index! };
}
