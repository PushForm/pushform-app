// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SketchFace, UvMapping } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { streamNativeNumbers } from './numericStream';

export type NativeFaceUvSource = Pick<SketchFace, 'uv' | 'uvBack'>;
export interface NativeFaceUvReference { faceCount: number; valueCount: number; kindChunks: number[]; offsetChunks: number[]; valueChunks: number[]; unknownFields: Uint8Array[] }
export interface NativeFaceUv { kinds: Uint8Array; offsets: Uint32Array; values: Float64Array }
const codec = new NativeRecordCodec({ faceCount: { id: 1, kind: 'uint32', required: true }, valueCount: { id: 2, kind: 'uint32', required: true },
  kindChunks: { id: 3, kind: 'bytes', required: false }, offsetChunks: { id: 4, kind: 'bytes', required: false }, valueChunks: { id: 5, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native face UV'); };
const uvCodes = { auto: 2, affine: 3, projective: 4, sized: 5 } satisfies Record<UvMapping['kind'], number>;
const width = (code: number): number => code === 4 ? 9 : code === 3 || code === 5 ? 6 : 0;
function code(uv: UvMapping | undefined, present: boolean, front: boolean): number {
  if (!present || uv === undefined) { if (front) return fail(); return present ? 1 : 0; }
  if (uv.kind === 'auto') return 2;
  const n = uvCodes[uv.kind]; if (n === undefined) return fail();
  if (uv.matrix.length !== width(n)) return fail(); return n;
}
function validate(ref: NativeFaceUvReference): void {
  if (!Number.isInteger(ref.faceCount) || ref.faceCount < 0 || !Number.isInteger(ref.valueCount) || ref.valueCount < 0 ||
      ref.valueCount > ref.faceCount * 18 || ref.faceCount * 10 + 4 + ref.valueCount * 8 > NATIVE_MAX_DECODED_BYTES) fail();
  const used = new Set<number>();
  for (const [chunks, count] of [[ref.kindChunks, ref.faceCount * 2], [ref.offsetChunks, ref.faceCount * 2 + 1], [ref.valueChunks, ref.valueCount]] as const) {
    if (!!chunks.length !== !!count) fail();
    for (const id of chunks) { if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id)) fail(); used.add(id); }
  }
  if (used.size > NATIVE_MAX_CHUNKS) fail();
}
export function encodeNativeFaceUvReference(ref: NativeFaceUvReference): Uint8Array {
  validate(ref); return codec.encode({ fields: { faceCount: ref.faceCount, valueCount: ref.valueCount,
    ...(ref.kindChunks.length ? { kindChunks: encodeNativeIds(ref.kindChunks) } : {}), offsetChunks: encodeNativeIds(ref.offsetChunks),
    ...(ref.valueChunks.length ? { valueChunks: encodeNativeIds(ref.valueChunks) } : {}) }, unknownFields: ref.unknownFields });
}
export function decodeNativeFaceUvReference(bytes: Uint8Array): NativeFaceUvReference {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const ref = { faceCount: f.faceCount as number, valueCount: f.valueCount as number, kindChunks: decodeNativeIds(f.kindChunks as Uint8Array | undefined),
    offsetChunks: decodeNativeIds(f.offsetChunks as Uint8Array | undefined), valueChunks: decodeNativeIds(f.valueChunks as Uint8Array | undefined), unknownFields: decoded.unknownFields };
  validate(ref); return ref;
}
export async function* streamNativeFaceUv(
  faces: ReadonlyMap<number, NativeFaceUvSource>, nextId: () => number, options: NativeChunkOptions = {},
): AsyncGenerator<NativeStoredChunk, NativeFaceUvReference> {
  options.signal?.throwIfAborted(); const faceCount = faces.size; let valueCount = 0;
  for (const face of faces.values()) {
    valueCount += width(code(face.uv, true, true)) + width(code(face.uvBack, Object.hasOwn(face, 'uvBack'), false));
    if (faceCount * 10 + 4 + valueCount * 8 > NATIVE_MAX_DECODED_BYTES) return fail();
  }
  function* numbers(column: 'kinds' | 'offsets' | 'values'): Generator<number> {
    let offset = 0;
    for (const face of faces.values()) for (let side = 0; side < 2; side++) {
      const uv = side === 0 ? face.uv : face.uvBack, kind = code(uv, side === 0 || Object.hasOwn(face, 'uvBack'), side === 0);
      if (column === 'kinds') yield kind;
      else if (column === 'offsets') { yield offset; offset += width(kind); }
      else if (uv && uv.kind !== 'auto') yield* uv.matrix;
    }
    if (column === 'offsets') yield offset;
  }
  const kindChunks = yield* streamNativeNumbers(numbers('kinds'), 'uint8', faceCount * 2, nextId, options);
  const offsetChunks = yield* streamNativeNumbers(numbers('offsets'), 'uint32', faceCount * 2 + 1, nextId, options);
  const valueChunks = yield* streamNativeNumbers(numbers('values'), 'float64', valueCount, nextId, options);
  const ref = { faceCount, valueCount, kindChunks, offsetChunks, valueChunks, unknownFields: [] }; validate(ref); return ref;
}
export async function readNativeFaceUv(ref: NativeFaceUvReference, columns: NativeColumnReader, signal?: AbortSignal): Promise<NativeFaceUv> {
  validate(ref);
  const kinds = await columns.read('uint8', ref.faceCount * 2, ref.kindChunks, signal);
  const offsets = await columns.read('uint32', ref.faceCount * 2 + 1, ref.offsetChunks, signal);
  if (offsets[0] !== 0 || offsets[offsets.length - 1] !== ref.valueCount) return fail();
  for (let i = 0; i < kinds.length; i++) if (kinds[i]! > 5 || (i % 2 === 0 && kinds[i]! < 2) || offsets[i + 1]! - offsets[i]! !== width(kinds[i]!)) return fail();
  const values = await columns.read('float64', ref.valueCount, ref.valueChunks, signal);
  for (const value of values) if (!Number.isFinite(value)) return fail(); return { kinds, offsets, values };
}
/** Materialize a requested face from a validated table, never a whole UV object graph. */
export function nativeFaceUvAt(table: NativeFaceUv, row: number): NativeFaceUvSource {
  if (!Number.isInteger(row) || row < 0 || row >= table.kinds.length / 2) return fail();
  function mapping(slot: number): UvMapping | undefined {
    const kind = table.kinds[slot]!; if (kind < 2) return undefined; if (kind === 2) return { kind: 'auto' };
    const matrix = Array.from(table.values.subarray(table.offsets[slot], table.offsets[slot + 1]));
    if (kind === 4) return { kind: 'projective', matrix: matrix as unknown as Extract<UvMapping, { kind: 'projective' }>['matrix'] };
    return { kind: kind === 3 ? 'affine' : 'sized', matrix: matrix as unknown as Extract<UvMapping, { kind: 'affine' }>['matrix'] };
  }
  const result: NativeFaceUvSource = { uv: mapping(row * 2)! }; if (table.kinds[row * 2 + 1] !== 0) result.uvBack = mapping(row * 2 + 1); return result;
}
