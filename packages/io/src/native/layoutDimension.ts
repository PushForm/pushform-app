// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDimensionAnchor, LayoutLinearDimension, LayoutAngularDimension, LayoutAngularEdgeAnchor } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
export type LayoutDimensionExtensions = Map<string, Uint8Array[]>;
/** Transfer positional wire fields to the anchor objects that survive editing. */
function attachAnchors(values: readonly (LayoutDimensionAnchor | null)[], ext: LayoutDimensionExtensions, path = 'anchors'): void {
  for (const [i, value] of values.entries()) if (value) {
    const prefix = `${path}/${i}`, wrapper = ext.get(prefix), fields = new Map<string, Uint8Array[]>();
    if (wrapper) ext.delete(prefix);
    for (const key of ['', 't']) {
      const name = `${prefix}/value${key ? `/${key}` : ''}`, bytes = ext.get(name);
      if (bytes) { fields.set(key, bytes); ext.delete(name); }
    }
    if (wrapper || fields.size) value.nativeUnknownFields = { ...(wrapper ? { wrapper } : {}), ...(fields.size ? { extensions: fields } : {}) };
  }
}
export function attachNativeLayoutDimensionFields(value: LayoutLinearDimension | LayoutAngularDimension, extensions: LayoutDimensionExtensions, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  const ext = new Map(extensions);
  attachAnchors(value.anchors, ext);
  if ('cachedAngleDeg' in value) {
    for (const [i, edge] of (value.edgeAnchors ?? []).entries()) {
      const path = `edgeAnchors/${i}`, fields = ext.get(path);
      if (fields) { edge.nativeUnknownFields = fields; ext.delete(path); }
    }
    if (value.rayDefinition) {
      const fields = new Map<string, Uint8Array[]>();
      for (const [key, bytes] of ext) if (key.startsWith('rayDefinition/')) {
        fields.set(key === 'rayDefinition/value' ? '' : key.slice('rayDefinition/'.length), bytes); ext.delete(key);
      }
      attachAnchors(value.rayDefinition.anchors, fields);
      if (fields.size) value.rayDefinition.nativeUnknownFields = fields;
    }
  }
  if (ext.size || envelope.length || outer.length) value.nativeUnknownFields = {
    ...(ext.size ? { extensions: ext } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const number = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'double', false) });
const anchor = new NativeRecordCodec({ entityId: f(1, 'uint32'), pointIndex: f(2, 'uint32'), pointCount: f(3, 'uint32'), t: f(4, 'bytes', false) } satisfies Record<Exclude<keyof LayoutDimensionAnchor, 'nativeUnknownFields'>, NativeField>);
const nullableAnchor = new NativeRecordCodec({ value: f(1, 'bytes', false) });
const anchors = new NativeRecordCodec({ entries: { ...f(1, 'bytes', false), repeated: true } });
const linear = new NativeRecordCodec({ anchors: f(1, 'bytes'), alignment: f(2, 'uint32'), angleDeg: f(3, 'bytes', false), units: f(4, 'uint32'), format: f(5, 'uint32', false),
  precision: f(6, 'uint32'), showUnits: f(7, 'bool'), scale: f(8, 'bytes', false), showDashes: f(9, 'uint32', false), text: f(10, 'string'), fontFamily: f(11, 'string'),
  fontSizePt: f(12, 'double'), endpoint: f(13, 'uint32'), arrowSizeMm: f(14, 'double'), extensionGapMm: f(15, 'double'), extensionOverrunMm: f(16, 'double'), cachedValueMm: f(17, 'double'), detached: f(18, 'bool') } satisfies Record<Exclude<keyof LayoutLinearDimension, 'nativeUnknownFields'>, NativeField>);
const angular = new NativeRecordCodec({ anchors: f(1, 'bytes'), units: f(2, 'uint32'), precision: f(3, 'uint32'), showUnits: f(4, 'bool'), text: f(5, 'string'), fontFamily: f(6, 'string'),
  fontSizePt: f(7, 'double'), endpoint: f(8, 'uint32'), arrowSizeMm: f(9, 'double'), extensionGapMm: f(10, 'double'), extensionOverrunMm: f(11, 'double'), cachedAngleDeg: f(12, 'double'),
  detached: f(13, 'bool'), reflex: f(14, 'bool'), angleDeg: f(15, 'bytes', false), edgeAnchors: f(16, 'bytes', false), rayDefinition: f(17, 'bytes', false) } satisfies Record<Exclude<keyof LayoutAngularDimension, 'nativeUnknownFields'>, NativeField>);
const edgeAnchor = new NativeRecordCodec({ entityId: f(1, 'uint32'), segmentIndex: f(2, 'uint32'), pointCount: f(3, 'uint32'), direction: f(4, 'uint32') } satisfies Record<Exclude<keyof LayoutAngularEdgeAnchor, 'nativeUnknownFields'>, NativeField>);
const edgePair = new NativeRecordCodec({ state: f(1, 'uint32'), entries: { ...f(2, 'bytes', false), repeated: true } });
const rays = new NativeRecordCodec({ points: f(1, 'bytes'), anchors: f(2, 'bytes') });
const optionalRays = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'bytes', false) });
const enums = { alignment: ['aligned', 'horizontal', 'vertical', 'rotated'], units: ['mm', 'cm', 'm', 'inch', 'ft', 'pt'], format: ['decimal', 'architectural', 'engineering', 'fractional'], endpoint: ['arrow', 'tick', 'dot', 'none'] } as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout dimension'); };
function finite(n: unknown): number { if (typeof n !== 'number' || !Number.isFinite(n)) return fail(); return n; }
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, ext: LayoutDimensionExtensions) { return codec.encode({ fields, unknownFields: ext.get(path) ?? [] }); }
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: LayoutDimensionExtensions) { const r = codec.decode(bytes); if (r.unknownFields.length) ext.set(path, r.unknownFields); return r.fields; }
function code(key: keyof typeof enums, value: unknown): number { const i = (enums[key] as readonly unknown[]).indexOf(value); if (i < 0) return fail(); return i; }
function choice(key: keyof typeof enums, value: NativeScalar | undefined): string { if (typeof value !== 'number') return fail(); return enums[key][value] ?? fail(); }
function writeNumber(value: number | undefined, path: string, ext: LayoutDimensionExtensions) { return write(number, value === undefined ? { state: 0 } : { state: 1, value: finite(value) }, path, ext); }
function readNumber(bytes: Uint8Array, path: string, ext: LayoutDimensionExtensions): number | undefined {
  const r = read(number, bytes, path, ext), has = Object.hasOwn(r, 'value');
  if (r.state === 0 && !has) return undefined; if (r.state === 1 && has) return finite(r.value); return fail();
}
function validateAnchor(a: LayoutDimensionAnchor): void {
  if (!Number.isInteger(a.entityId) || a.entityId < 1 || a.entityId > 0xffffffff || !Number.isInteger(a.pointCount) || a.pointCount < 2 || a.pointCount > 0xffffffff ||
    !Number.isInteger(a.pointIndex) || a.pointIndex < 0 || a.pointIndex >= a.pointCount || a.t !== undefined && !(a.t > 0 && a.t < 1)) fail();
}
export function encodeNativeLayoutDimensionAnchor(a: LayoutDimensionAnchor, ext: LayoutDimensionExtensions = new Map(), path = ''): Uint8Array {
  if (a.nativeUnknownFields?.extensions) { ext = new Map(ext); for (const [key, fields] of a.nativeUnknownFields.extensions) ext.set(key ? `${path}/${key}` : path, fields); }
  validateAnchor(a); const fields: Record<string, NativeScalar> = { entityId: a.entityId, pointIndex: a.pointIndex, pointCount: a.pointCount };
  if (Object.hasOwn(a, 't')) fields.t = writeNumber(a.t, `${path}/t`, ext);
  return write(anchor, fields, path, ext);
}
export function decodeNativeLayoutDimensionAnchor(bytes: Uint8Array, ext: LayoutDimensionExtensions = new Map(), path = ''): LayoutDimensionAnchor {
  const a = read(anchor, bytes, path, ext), value: LayoutDimensionAnchor = { entityId: a.entityId as number, pointIndex: a.pointIndex as number, pointCount: a.pointCount as number };
  if (Object.hasOwn(a, 't')) value.t = readNumber(a.t as Uint8Array, `${path}/t`, ext); validateAnchor(value); return value;
}
/** Null anchors retain their wrapper sidecars; stale entity identities are resolved by the editor's detached-anchor behavior. */
export function encodeNativeLayoutDimensionAnchors(values: readonly (LayoutDimensionAnchor | null)[], count: number, ext: LayoutDimensionExtensions = new Map(), path = 'anchors'): Uint8Array {
  if (!Array.isArray(values) || values.length !== count || count < 1 || count > 4) return fail();
  return write(anchors, { entries: values.map((a, i) => nullableAnchor.encode({ fields: a === null ? {} : { value: encodeNativeLayoutDimensionAnchor(a, ext, `${path}/${i}/value`) }, unknownFields: a?.nativeUnknownFields?.wrapper ?? ext.get(`${path}/${i}`) ?? [] })) }, path, ext);
}
export function decodeNativeLayoutDimensionAnchors(bytes: Uint8Array, count: number, ext: LayoutDimensionExtensions = new Map(), path = 'anchors'): (LayoutDimensionAnchor | null)[] {
  const r = read(anchors, bytes, path, ext), entries = r.entries as Uint8Array[] | undefined;
  if (!entries || entries.length !== count || count < 1 || count > 4) return fail();
  return entries.map((bytes, i) => { const r = read(nullableAnchor, bytes, `${path}/${i}`, ext); return Object.hasOwn(r, 'value') ? decodeNativeLayoutDimensionAnchor(r.value as Uint8Array, ext, `${path}/${i}/value`) : null; });
}
function validateStyle(value: LayoutLinearDimension | LayoutAngularDimension): void {
  if (!Number.isInteger(value.precision) || value.precision < 0 || value.precision > 6 || !value.fontFamily.trim() || value.fontSizePt <= 0 || value.arrowSizeMm <= 0 ||
    value.extensionGapMm < 0 || value.extensionOverrunMm < 0) fail();
}
function validateLinear(value: LayoutLinearDimension): void {
  validateStyle(value); if (value.cachedValueMm < 0 || value.scale !== undefined && !(value.scale > 0)) fail();
}
export function encodeNativeLayoutLinearDimension(value: LayoutLinearDimension, ext: LayoutDimensionExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  validateLinear(value);
  const fields: Record<string, NativeScalar> = { anchors: encodeNativeLayoutDimensionAnchors(value.anchors, 2, ext), alignment: code('alignment', value.alignment), units: code('units', value.units),
    precision: value.precision, showUnits: value.showUnits, text: value.text, fontFamily: value.fontFamily, fontSizePt: finite(value.fontSizePt), endpoint: code('endpoint', value.endpoint),
    arrowSizeMm: finite(value.arrowSizeMm), extensionGapMm: finite(value.extensionGapMm), extensionOverrunMm: finite(value.extensionOverrunMm), cachedValueMm: finite(value.cachedValueMm), detached: value.detached };
  for (const key of ['angleDeg', 'scale'] as const) if (Object.hasOwn(value, key)) fields[key] = writeNumber(value[key], key, ext);
  if (Object.hasOwn(value, 'format')) fields.format = value.format === undefined ? 0 : code('format', value.format) + 1;
  if (Object.hasOwn(value, 'showDashes')) {
    if (value.showDashes !== undefined && typeof value.showDashes !== 'boolean') return fail(); fields.showDashes = value.showDashes === undefined ? 0 : value.showDashes ? 2 : 1;
  }
  return write(linear, fields, '', ext);
}
export function decodeNativeLayoutLinearDimension(bytes: Uint8Array): { value: LayoutLinearDimension; extensions: LayoutDimensionExtensions } {
  const ext: LayoutDimensionExtensions = new Map(), r = read(linear, bytes, '', ext);
  const value: LayoutLinearDimension = { anchors: decodeNativeLayoutDimensionAnchors(r.anchors as Uint8Array, 2, ext) as LayoutLinearDimension['anchors'],
    alignment: choice('alignment', r.alignment) as LayoutLinearDimension['alignment'], units: choice('units', r.units) as LayoutLinearDimension['units'],
    precision: r.precision as number, showUnits: r.showUnits as boolean, text: r.text as string, fontFamily: r.fontFamily as string,
    fontSizePt: finite(r.fontSizePt), endpoint: choice('endpoint', r.endpoint) as LayoutLinearDimension['endpoint'], arrowSizeMm: finite(r.arrowSizeMm),
    extensionGapMm: finite(r.extensionGapMm), extensionOverrunMm: finite(r.extensionOverrunMm), cachedValueMm: finite(r.cachedValueMm), detached: r.detached as boolean };
  for (const key of ['angleDeg', 'scale'] as const) if (Object.hasOwn(r, key)) present(value, key, readNumber(r[key] as Uint8Array, key, ext));
  if (Object.hasOwn(r, 'format')) present(value, 'format', r.format === 0 ? undefined : choice('format', (r.format as number) - 1));
  if (Object.hasOwn(r, 'showDashes')) { if (r.showDashes !== 0 && r.showDashes !== 1 && r.showDashes !== 2) return fail(); present(value, 'showDashes', r.showDashes === 0 ? undefined : r.showDashes === 2); }
  validateLinear(value); return { value, extensions: ext };
}
function validateAngular(value: LayoutAngularDimension): void {
  validateStyle(value);
  if (value.cachedAngleDeg < 0 || value.cachedAngleDeg > 360 || value.units !== 'degrees' && value.units !== 'radians' ||
    ['format', 'scale', 'showDashes'].some(key => Object.hasOwn(value, key))) fail();
  if (value.edgeAnchors !== undefined) {
    if (!Array.isArray(value.edgeAnchors) || value.edgeAnchors.length !== 2) fail();
    for (const e of value.edgeAnchors) {
      validateAnchor({ entityId: e.entityId, pointCount: e.pointCount, pointIndex: e.segmentIndex }); if (e.direction !== 1 && e.direction !== -1) fail();
    }
  }
  if (value.rayDefinition !== undefined) {
    const r = value.rayDefinition;
    if (!r || value.edgeAnchors !== undefined || value.anchors.some(a => a !== null) || !Array.isArray(r.points) || r.points.length !== 4) fail();
    for (const p of r.points) if (!Array.isArray(p) || p.length !== 2) fail();
  }
}
export function encodeNativeLayoutAngularDimension(value: LayoutAngularDimension, ext: LayoutDimensionExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  validateAngular(value);
  if (value.rayDefinition?.nativeUnknownFields) {
    ext = new Map(ext);
    for (const [key, fields] of value.rayDefinition.nativeUnknownFields) ext.set(key ? `rayDefinition/${key}` : 'rayDefinition/value', fields);
  }
  const fields: Record<string, NativeScalar> = { anchors: encodeNativeLayoutDimensionAnchors(value.anchors, 3, ext), units: value.units === 'degrees' ? 0 : 1,
    precision: value.precision, showUnits: value.showUnits, text: value.text, fontFamily: value.fontFamily, fontSizePt: finite(value.fontSizePt), endpoint: code('endpoint', value.endpoint),
    arrowSizeMm: finite(value.arrowSizeMm), extensionGapMm: finite(value.extensionGapMm), extensionOverrunMm: finite(value.extensionOverrunMm), cachedAngleDeg: finite(value.cachedAngleDeg), detached: value.detached, reflex: value.reflex };
  if (Object.hasOwn(value, 'angleDeg')) fields.angleDeg = writeNumber(value.angleDeg, 'angleDeg', ext);
  if (Object.hasOwn(value, 'edgeAnchors')) fields.edgeAnchors = write(edgePair, { state: value.edgeAnchors === undefined ? 0 : 1,
    entries: (value.edgeAnchors ?? []).map((e, i) => edgeAnchor.encode({ fields: { entityId: e.entityId, segmentIndex: e.segmentIndex, pointCount: e.pointCount, direction: e.direction === 1 ? 0 : 1 }, unknownFields: e.nativeUnknownFields ?? ext.get(`edgeAnchors/${i}`) ?? [] })) }, 'edgeAnchors', ext);
  if (Object.hasOwn(value, 'rayDefinition')) fields.rayDefinition = write(optionalRays, value.rayDefinition === undefined ? { state: 0 } : { state: 1,
    value: write(rays, { points: encodeNativeNumbers(value.rayDefinition.points.flat(), 8), anchors: encodeNativeLayoutDimensionAnchors(value.rayDefinition.anchors, 4, ext, 'rayDefinition/anchors') }, 'rayDefinition/value', ext) }, 'rayDefinition', ext);
  return write(angular, fields, '', ext);
}
export function decodeNativeLayoutAngularDimension(bytes: Uint8Array): { value: LayoutAngularDimension; extensions: LayoutDimensionExtensions } {
  const ext: LayoutDimensionExtensions = new Map(), r = read(angular, bytes, '', ext); if (r.units !== 0 && r.units !== 1) return fail();
  const value: LayoutAngularDimension = { anchors: decodeNativeLayoutDimensionAnchors(r.anchors as Uint8Array, 3, ext) as LayoutAngularDimension['anchors'], units: r.units === 0 ? 'degrees' : 'radians',
    precision: r.precision as number, showUnits: r.showUnits as boolean, text: r.text as string, fontFamily: r.fontFamily as string, fontSizePt: finite(r.fontSizePt),
    endpoint: choice('endpoint', r.endpoint) as LayoutAngularDimension['endpoint'], arrowSizeMm: finite(r.arrowSizeMm), extensionGapMm: finite(r.extensionGapMm), extensionOverrunMm: finite(r.extensionOverrunMm),
    cachedAngleDeg: finite(r.cachedAngleDeg), detached: r.detached as boolean, reflex: r.reflex as boolean };
  if (Object.hasOwn(r, 'angleDeg')) present(value, 'angleDeg', readNumber(r.angleDeg as Uint8Array, 'angleDeg', ext));
  if (Object.hasOwn(r, 'edgeAnchors')) {
    const e = read(edgePair, r.edgeAnchors as Uint8Array, 'edgeAnchors', ext), entries = (e.entries ?? []) as Uint8Array[];
    if (e.state === 0 && !entries.length) present(value, 'edgeAnchors', undefined);
    else if (e.state === 1 && entries.length === 2) value.edgeAnchors = entries.map((bytes, i) => {
      const e = read(edgeAnchor, bytes, `edgeAnchors/${i}`, ext); if (e.direction !== 0 && e.direction !== 1) return fail();
      return { entityId: e.entityId as number, segmentIndex: e.segmentIndex as number, pointCount: e.pointCount as number, direction: e.direction === 0 ? 1 : -1 };
    }) as NonNullable<LayoutAngularDimension['edgeAnchors']>; else return fail();
  }
  if (Object.hasOwn(r, 'rayDefinition')) {
    const o = read(optionalRays, r.rayDefinition as Uint8Array, 'rayDefinition', ext), has = Object.hasOwn(o, 'value');
    if (o.state === 0 && !has) present(value, 'rayDefinition', undefined);
    else if (o.state === 1 && has) {
      const ray = read(rays, o.value as Uint8Array, 'rayDefinition/value', ext), p = decodeNativeNumbers(ray.points as Uint8Array, 8);
      value.rayDefinition = { points: [[p[0]!, p[1]!], [p[2]!, p[3]!], [p[4]!, p[5]!], [p[6]!, p[7]!]],
        anchors: decodeNativeLayoutDimensionAnchors(ray.anchors as Uint8Array, 4, ext, 'rayDefinition/anchors') as NonNullable<LayoutAngularDimension['rayDefinition']>['anchors'] };
    } else return fail();
  }
  validateAngular(value); return { value, extensions: ext };
}
