// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, FaceLocalId, Id, Vec3 } from '@pushform/core';
import type { CommonAttrs, Dimension, DimensionAnchor } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { NativeChunkError } from './chunks';
export type NativeDimension = Omit<Dimension, keyof CommonAttrs | 'nativeUnknownFields'>;
export interface NativeDimensionRecord { value: NativeDimension; properties: number }
export type DimensionExtensions = Map<string, Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const fields = { id: f(1, 'uint32'), kind: f(3, 'uint32'), start: f(4, 'bytes'), end: f(5, 'bytes'), offset: f(6, 'bytes'), normal: f(7, 'bytes'),
  text: f(8, 'string', false), fontSizePt: f(9, 'double'), anchors: f(10, 'bytes', false), curve: f(11, 'bytes', false), arrow: f(12, 'uint32', false), align: f(13, 'uint32', false) } satisfies Record<keyof NativeDimension, NativeField>;
const { id: idField, ...rest } = fields;
const dimension = new NativeRecordCodec({ id: idField, properties: f(2, 'uint32'), ...rest });
const anchor = new NativeRecordCodec({ kind: f(1, 'uint32'), path: f(2, 'bytes', false), id: f(3, 'uint32', false), bodyId: f(4, 'uint32', false), faceIds: f(5, 'bytes', false) });
const pair = new NativeRecordCodec({ state: f(1, 'uint32'), start: f(2, 'bytes', false), end: f(3, 'bytes', false) });
const curve = new NativeRecordCodec({ state: f(1, 'uint32'), path: f(2, 'bytes', false), bodyId: f(3, 'uint32', false), curveId: f(4, 'uint32', false) });
const kinds = ['linear', 'radial', 'diametric'] as const, arrows = ['none', 'slash', 'dot', 'closed', 'open'] as const, aligns = ['screen', 'above', 'centered', 'outside'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native dimension'); };
function property(id: number): void { if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail(); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, scope: string, ext: DimensionExtensions): Uint8Array {
  return codec.encode({ fields, unknownFields: ext.get(scope) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, scope: string, ext: DimensionExtensions) {
  const r = codec.decode(bytes); if (r.unknownFields.length) ext.set(scope, r.unknownFields); return r.fields;
}
function writeAnchor(value: DimensionAnchor | null, scope: string, ext: DimensionExtensions): Uint8Array {
  const emit = (fields: Record<string, NativeScalar>) => anchor.encode({ fields, unknownFields: value?.nativeUnknownFields ?? ext.get(scope) ?? [] });
  if (value === null) return emit({ kind: 0 });
  if (value.kind === 'sketchVertex') return emit({ kind: 1, path: encodeNativeIds(value.path), id: value.id });
  if (value.kind !== 'bodyVertex') return fail();
  return emit({ kind: 2, path: encodeNativeIds(value.path), bodyId: value.bodyId, faceIds: encodeNativeIds(value.faceIds) });
}
function readAnchor(bytes: Uint8Array, scope: string, ext: DimensionExtensions): DimensionAnchor | null {
  const a = read(anchor, bytes, scope, ext), keys = Object.keys(a).length;
  if (a.kind === 0 && keys === 1) return null;
  if (!(a.path instanceof Uint8Array)) return fail(); const path = decodeNativeIds(a.path) as Id[];
  if (a.kind === 1 && keys === 3 && a.id !== undefined) return { kind: 'sketchVertex', path, id: a.id as Id };
  if (a.kind === 2 && keys === 4 && a.bodyId !== undefined && a.faceIds instanceof Uint8Array) return { kind: 'bodyVertex', path, bodyId: a.bodyId as Id, faceIds: decodeNativeIds(a.faceIds) as FaceLocalId[] };
  return fail();
}
/** Shared with Layout model-linked annotations; identity remains scoped to the referenced model. */
export function encodeNativeModelAnchor(value: DimensionAnchor | null, ext: DimensionExtensions = new Map(), scope = ''): Uint8Array { return writeAnchor(value, scope, ext); }
export function decodeNativeModelAnchor(bytes: Uint8Array, ext: DimensionExtensions = new Map(), scope = ''): DimensionAnchor | null { return readAnchor(bytes, scope, ext); }
export function encodeNativeDimension(record: NativeDimensionRecord, ext: DimensionExtensions = new Map()): Uint8Array {
  property(record.properties); const v = record.value, kind = kinds.indexOf(v.kind); if (kind < 0 || !Number.isFinite(v.fontSizePt)) return fail();
  const out: Record<string, NativeScalar> = { id: v.id, properties: record.properties, kind, start: encodeNativeNumbers(v.start, 3), end: encodeNativeNumbers(v.end, 3),
    offset: encodeNativeNumbers(v.offset, 3), normal: encodeNativeNumbers(v.normal, 3), fontSizePt: v.fontSizePt };
  if (v.text !== null) out.text = v.text;
  if (Object.hasOwn(v, 'anchors')) {
    if (v.anchors !== undefined && v.anchors.length !== 2) return fail();
    out.anchors = write(pair, v.anchors === undefined ? { state: 0 } : { state: 1, start: writeAnchor(v.anchors[0], 'anchors.start', ext), end: writeAnchor(v.anchors[1], 'anchors.end', ext) }, 'anchors', ext);
  }
  if (Object.hasOwn(v, 'curve')) out.curve = curve.encode({ fields: v.curve === undefined ? { state: 0 } : { state: 1, path: encodeNativeIds(v.curve.path), curveId: v.curve.curveId,
    ...(v.curve.bodyId === null ? {} : { bodyId: v.curve.bodyId }) }, unknownFields: v.curve?.nativeUnknownFields ?? ext.get('curve') ?? [] });
  for (const name of ['arrow', 'align'] as const) if (Object.hasOwn(v, name)) {
    const values: readonly string[] = name === 'arrow' ? arrows : aligns, value = v[name], code = value === undefined ? 0 : values.indexOf(value) + 1;
    if (value !== undefined && !code) return fail(); out[name] = code;
  }
  return write(dimension, out, '', ext);
}
export function decodeNativeDimension(bytes: Uint8Array): { value: NativeDimensionRecord; extensions: DimensionExtensions } {
  const ext: DimensionExtensions = new Map(), a = read(dimension, bytes, '', ext); property(a.properties as number);
  const kind = kinds[a.kind as number]; if (!kind || !Number.isFinite(a.fontSizePt)) return fail();
  const vec = (name: string): Vec3 => decodeNativeNumbers(a[name] as Uint8Array, 3) as unknown as Vec3;
  const value: NativeDimension = { id: a.id as Id, kind, start: vec('start'), end: vec('end'), offset: vec('offset'), normal: vec('normal'), text: a.text === undefined ? null : a.text as string, fontSizePt: a.fontSizePt as number };
  if (Object.hasOwn(a, 'anchors')) {
    const p = read(pair, a.anchors as Uint8Array, 'anchors', ext);
    if (p.state === 0 && Object.keys(p).length === 1) value.anchors = undefined;
    else if (p.state === 1 && p.start instanceof Uint8Array && p.end instanceof Uint8Array) value.anchors = [readAnchor(p.start, 'anchors.start', ext), readAnchor(p.end, 'anchors.end', ext)];
    else return fail();
  }
  if (Object.hasOwn(a, 'curve')) {
    const c = read(curve, a.curve as Uint8Array, 'curve', ext);
    if (c.state === 0 && Object.keys(c).length === 1) value.curve = undefined;
    else if (c.state === 1 && c.path instanceof Uint8Array && c.curveId !== undefined) value.curve = { path: decodeNativeIds(c.path) as Id[], bodyId: c.bodyId === undefined ? null : c.bodyId as Id, curveId: c.curveId as CurveId };
    else return fail();
  }
  for (const name of ['arrow', 'align'] as const) if (Object.hasOwn(a, name)) {
    const code = a[name] as number, values = name === 'arrow' ? arrows : aligns; if (code > values.length) return fail();
    Object.defineProperty(value, name, { value: code === 0 ? undefined : values[code - 1], enumerable: true, writable: true, configurable: true });
  }
  return { value: { value, properties: a.properties as number }, extensions: ext };
}
