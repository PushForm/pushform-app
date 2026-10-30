// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId } from '@pushform/core';
import type { Curve } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeColumnReader, NativeColumnType } from './columns';
import type { NativeStoredChunk } from './container';
import { streamNativeNumbers } from './numericStream';

interface Counts { count: number; referenceCount: number }
export interface NativeSketchCurves { ids: Uint32Array; kinds: Uint8Array; geometry: Float64Array; segments: Uint32Array; offsets: Uint32Array; edgeIds: Uint32Array }
type Column = keyof NativeSketchCurves;
export interface NativeSketchCurvesReference extends Counts { columns: Record<Column, number[]>; unknownFields: Uint8Array[] }
const layout = {
  ids: { id: 3, type: 'uint32', count: (c: Counts) => c.count }, kinds: { id: 4, type: 'uint8', count: (c: Counts) => c.count },
  geometry: { id: 5, type: 'float64', count: (c: Counts) => c.count * 9 }, segments: { id: 6, type: 'uint32', count: (c: Counts) => c.count },
  offsets: { id: 7, type: 'uint32', count: (c: Counts) => c.count + 1 }, edgeIds: { id: 8, type: 'uint32', count: (c: Counts) => c.referenceCount },
} satisfies Record<Column, { id: number; type: NativeColumnType; count: (c: Counts) => number }>;
const kindCodes = { arc: 0, circle: 1, polygon: 2, freehand: 3 } satisfies Record<Curve['kind'], number>;
const sourceFields = { id: 'ids', kind: 'kinds', center: 'geometry', normal: 'geometry', radius: 'geometry', startAngle: 'geometry', endAngle: 'geometry', segments: 'segments', edgeRefs: 'offsets/edgeIds' } satisfies Record<keyof Curve, string>;
void sourceFields;
const names = Object.keys(layout) as Column[];
const codec = new NativeRecordCodec({ count: { id: 1, kind: 'uint32', required: true }, referenceCount: { id: 2, kind: 'uint32', required: true },
  ...Object.fromEntries(names.map(name => [name, { id: layout[name].id, kind: 'bytes', required: false } satisfies NativeField])) });
const fail = (): never => { throw new NativeChunkError('Invalid native sketch curves'); };
function counts(c: Counts): void {
  if (!Number.isInteger(c.count) || c.count < 0 || !Number.isInteger(c.referenceCount) || c.referenceCount < 0 || (!c.count && c.referenceCount) ||
      c.count * 85 + c.referenceCount * 4 + 4 > NATIVE_MAX_DECODED_BYTES) fail();
}
function validate(ref: NativeSketchCurvesReference): void {
  counts(ref); const used = new Set<number>();
  for (const name of names) {
    const ids = ref.columns[name]; if (!!ids.length !== !!layout[name].count(ref)) fail();
    for (const id of ids) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeSketchCurvesReference(ref: NativeSketchCurvesReference): Uint8Array {
  validate(ref); const fields: Record<string, NativeScalar> = { count: ref.count, referenceCount: ref.referenceCount };
  for (const name of names) if (ref.columns[name].length) fields[name] = encodeNativeIds(ref.columns[name]);
  return codec.encode({ fields, unknownFields: ref.unknownFields });
}
export function decodeNativeSketchCurvesReference(bytes: Uint8Array): NativeSketchCurvesReference {
  const decoded = codec.decode(bytes), f = decoded.fields, refs = {} as Record<Column, number[]>;
  for (const name of names) refs[name] = decodeNativeIds(f[name] as Uint8Array | undefined);
  const ref = { count: f.count as number, referenceCount: f.referenceCount as number, columns: refs, unknownFields: decoded.unknownFields }; validate(ref); return ref;
}
/** Sketch curves use numeric edge IDs; body-edge string references are rejected. */
export async function* streamNativeSketchCurves(
  curves: ReadonlyMap<CurveId, Curve>, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeSketchCurvesReference> {
  options.signal?.throwIfAborted(); const size: Counts = { count: curves.size, referenceCount: 0 };
  for (const curve of curves.values()) { size.referenceCount += curve.edgeRefs.length; counts(size); }
  function* values(column: Column): Generator<number> {
    let offset = 0;
    for (const [id, curve] of curves) {
      if (id !== curve.id) return fail();
      switch (column) {
        case 'ids': yield id; break;
        case 'kinds': { const code = kindCodes[curve.kind]; if (code === undefined) return fail(); yield code; break; }
        case 'geometry':
          if (curve.center.length !== 3 || curve.normal.length !== 3) return fail();
          yield* curve.center; yield* curve.normal; yield curve.radius; yield curve.startAngle; yield curve.endAngle; break;
        case 'segments': yield curve.segments; break;
        case 'offsets': yield offset; offset += curve.edgeRefs.length; break;
        case 'edgeIds': for (const ref of curve.edgeRefs) { if (typeof ref !== 'number') return fail(); yield ref; } break;
      }
    }
    if (column === 'offsets') yield offset;
  }
  const columns = {} as Record<Column, number[]>;
  for (const name of names) columns[name] = yield* streamNativeNumbers(values(name), layout[name].type, layout[name].count(size), nextId, options);
  const ref = { ...size, columns, unknownFields: [] }; validate(ref); return ref;
}
/** Cross-table edge references are validated after edges have been loaded. */
export async function readNativeSketchCurves(ref: NativeSketchCurvesReference, reader: NativeColumnReader, signal?: AbortSignal): Promise<NativeSketchCurves> {
  validate(ref); const result = {} as NativeSketchCurves;
  for (const name of names) {
    const value = await reader.read(layout[name].type, layout[name].count(ref), ref.columns[name], signal);
    Object.defineProperty(result, name, { value, enumerable: true }); if (name === 'ids') reader.validateUniqueIds(result.ids, signal);
  }
  for (const kind of result.kinds) if (kind > 3) return fail();
  for (const value of result.geometry) if (!Number.isFinite(value)) return fail();
  if (result.offsets[0] !== 0 || result.offsets[result.offsets.length - 1] !== ref.referenceCount) return fail();
  for (let i = 1; i < result.offsets.length; i++) if (result.offsets[i]! < result.offsets[i - 1]!) return fail();
  return result;
}
export function validateNativeSketchCurveEdges(curves: NativeSketchCurves, hasEdge: (id: number) => boolean): void {
  for (const id of curves.edgeIds) if (!hasEdge(id)) return fail();
}
