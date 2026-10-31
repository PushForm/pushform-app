// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Guid, UnitSettings } from '@pushform/core';
import { FORMAT_VERSION, parseModelAttributions } from '@pushform/model';
import type { DocumentMeta, DimensionStyle } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const field = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const unitSchema = {
  format: field(1, 'uint32'), lengthUnit: field(2, 'uint32'), lengthPrecision: field(3, 'uint32'), areaUnit: field(4, 'uint32'),
  areaPrecision: field(5, 'uint32'), volumeUnit: field(6, 'uint32'), volumePrecision: field(7, 'uint32'), lengthSnap: field(8, 'bytes'),
  angleSnap: field(9, 'bytes'), anglePrecision: field(10, 'uint32'), displayUnitSuffix: field(11, 'bool'), forceZeroInches: field(12, 'bool'),
} satisfies Record<keyof UnitSettings, NativeField>;
const unitsCodec = new NativeRecordCodec(unitSchema);
const metaCodec = new NativeRecordCodec({ guid: field(1, 'string'), nextId: field(2, 'uint53'), units: field(3, 'bytes'), dimensions: field(4, 'bytes', false), attributions: field(5, 'bytes', false) } satisfies Record<Exclude<keyof DocumentMeta, 'formatVersion'>, NativeField>);
const dimensionCodec = new NativeRecordCodec({ fontSizePt: field(1, 'double'), arrow: field(2, 'uint32'), align: field(3, 'uint32') } satisfies Record<keyof DimensionStyle, NativeField>);
const nullable = new NativeRecordCodec({ nullValue: field(2, 'bytes', false), value: field(3, 'double', false) });
const optional = new NativeRecordCodec({ undefinedValue: field(1, 'bytes', false), value: field(3, 'bytes', false) });
const empty = new NativeRecordCodec({});
const enums = {
  format: ['architectural', 'decimal', 'engineering', 'fractional'], lengthUnit: ['in', 'ft', 'yd', 'mm', 'cm', 'm'],
  areaUnit: ['in²', 'ft²', 'yd²', 'mm²', 'cm²', 'm²'], volumeUnit: ['in³', 'ft³', 'yd³', 'mm³', 'cm³', 'm³', 'l'],
  arrow: ['none', 'slash', 'dot', 'closed', 'open'], align: ['screen', 'above', 'centered', 'outside'],
} as const;
const fail = (): never => { throw new NativeChunkError('Invalid native model metadata'); };
/** Only unknown bytes are retained, not another graph of known model values. */
export type ModelMetaExtensions = Map<string, Uint8Array[]>;
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, extensions: ModelMetaExtensions): Record<string, NativeScalar> {
  const record = codec.decode(bytes); if (record.unknownFields.length) extensions.set(path, record.unknownFields); return record.fields;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, extensions: ModelMetaExtensions): Uint8Array {
  return codec.encode({ fields, unknownFields: extensions.get(path) ?? [] });
}
function ordinal(key: keyof typeof enums, value: unknown): number {
  const index = (enums[key] as readonly unknown[]).indexOf(value); if (index < 0) return fail(); return index;
}
function choice(key: keyof typeof enums, value: NativeScalar | undefined): string {
  if (typeof value !== 'number') return fail(); const result = (enums[key] as readonly string[])[value]; if (result === undefined) return fail(); return result;
}
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return fail(); return value; }
function union(fields: Record<string, NativeScalar>, a: string, b: string): string {
  const hasA = Object.hasOwn(fields, a), hasB = Object.hasOwn(fields, b); if (hasA === hasB) return fail(); return hasA ? a : b;
}

export function encodeNativeModelMeta(value: DocumentMeta, extensions: ModelMetaExtensions = new Map()): Uint8Array {
  const units: Record<string, NativeScalar> = { ...value.units } as unknown as Record<string, NativeScalar>;
  for (const key of ['format', 'lengthUnit', 'areaUnit', 'volumeUnit'] as const) units[key] = ordinal(key, value.units[key]);
  for (const key of ['lengthSnap', 'angleSnap'] as const) {
    const path = `units.${key}`, n = value.units[key];
    units[key] = write(nullable, n === null ? { nullValue: write(empty, {}, `${path}.null`, extensions) } : { value: finite(n) }, path, extensions);
  }
  const fields: Record<string, NativeScalar> = { guid: value.guid, nextId: value.nextId, units: write(unitsCodec, units, 'units', extensions) };
  if (Object.hasOwn(value, 'dimensions')) {
    const d = value.dimensions;
    fields.dimensions = write(optional, d === undefined ? { undefinedValue: write(empty, {}, 'dimensions.undefined', extensions) }
      : { value: write(dimensionCodec, { fontSizePt: finite(d.fontSizePt), arrow: ordinal('arrow', d.arrow), align: ordinal('align', d.align) }, 'dimensions.value', extensions) }, 'dimensions', extensions);
  }
  if (value.attributions !== undefined) fields.attributions = new Uint8Array(new TextEncoder().encode(JSON.stringify(parseModelAttributions(value.attributions))));
  return write(metaCodec, fields, '', extensions);
}

export function decodeNativeModelMeta(bytes: Uint8Array): { value: DocumentMeta; extensions: ModelMetaExtensions } {
  const extensions: ModelMetaExtensions = new Map(), fields = read(metaCodec, bytes, '', extensions);
  const u = read(unitsCodec, fields.units as Uint8Array, 'units', extensions);
  for (const key of ['format', 'lengthUnit', 'areaUnit', 'volumeUnit'] as const) u[key] = choice(key, u[key]);
  const snaps: Record<string, number | null> = {};
  for (const key of ['lengthSnap', 'angleSnap'] as const) {
    const path = `units.${key}`, wrapped = read(nullable, u[key] as Uint8Array, path, extensions);
    if (union(wrapped, 'nullValue', 'value') === 'nullValue') {
      read(empty, wrapped.nullValue as Uint8Array, `${path}.null`, extensions); snaps[key] = null;
    } else snaps[key] = finite(wrapped.value);
  }
  const units = { ...u, ...snaps } as unknown as UnitSettings;
  const value: DocumentMeta = { guid: fields.guid as Guid, nextId: fields.nextId as number, formatVersion: FORMAT_VERSION, units };
  if (Object.hasOwn(fields, 'dimensions')) {
    const d = read(optional, fields.dimensions as Uint8Array, 'dimensions', extensions);
    if (union(d, 'undefinedValue', 'value') === 'undefinedValue') {
      read(empty, d.undefinedValue as Uint8Array, 'dimensions.undefined', extensions); value.dimensions = undefined;
    } else {
      const settings = read(dimensionCodec, d.value as Uint8Array, 'dimensions.value', extensions);
      value.dimensions = { fontSizePt: finite(settings.fontSizePt), arrow: choice('arrow', settings.arrow) as DimensionStyle['arrow'], align: choice('align', settings.align) as DimensionStyle['align'] };
    }
  }
  if (fields.attributions !== undefined) {
    const bytes = fields.attributions as Uint8Array; if (bytes.length > 512 * 1024) return fail();
    value.attributions = parseModelAttributions(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  return { value, extensions };
}
