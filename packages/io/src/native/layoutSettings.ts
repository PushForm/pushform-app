// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';

export type NativeLayoutSettings = LayoutDocumentState['settings'];
export type LayoutSettingsExtensions = Map<'' | 'grid', Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const grid = new NativeRecordCodec({ spacingMm: f(1, 'double'), show: f(2, 'bool'), snap: f(3, 'bool'),
  angleSnapDeg: f(4, 'double', false), units: f(5, 'uint32', false) } satisfies Record<keyof NativeLayoutSettings['grid'], NativeField>);
const settings = new NativeRecordCodec({ objectSnap: f(1, 'uint32', false), units: f(2, 'uint32'), paperUnits: f(3, 'uint32', false),
  precision: f(4, 'double'), anglePrecision: f(5, 'double'), grid: f(6, 'bytes'), autoRender: f(7, 'bool') } satisfies Record<keyof NativeLayoutSettings, NativeField>);
const units = ['mm', 'inch', 'architectural'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout settings'); };
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return fail(); return value; }
function optionalUnit(value: unknown): number {
  if (value === undefined) return 0;
  if (value === 'mm') return 1;
  if (value === 'in') return 2;
  return fail();
}
function decodedUnit(value: NativeScalar): 'mm' | 'in' | undefined {
  if (value === 0) return undefined;
  if (value === 1) return 'mm';
  if (value === 2) return 'in';
  return fail();
}
function present(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
/** Numbered Layout settings; no generic property bag and no JSON intermediate. */
export function encodeNativeLayoutSettings(value: NativeLayoutSettings, extensions: LayoutSettingsExtensions = new Map()): Uint8Array {
  const g: Record<string, NativeScalar> = { spacingMm: finite(value.grid.spacingMm), show: value.grid.show, snap: value.grid.snap };
  if (value.grid.angleSnapDeg !== null) g.angleSnapDeg = finite(value.grid.angleSnapDeg);
  if (Object.hasOwn(value.grid, 'units')) g.units = optionalUnit(value.grid.units);
  const unit = units.indexOf(value.units); if (unit < 0) return fail();
  const s: Record<string, NativeScalar> = { units: unit, precision: finite(value.precision), anglePrecision: finite(value.anglePrecision),
    grid: grid.encode({ fields: g, unknownFields: extensions.get('grid') ?? [] }), autoRender: value.autoRender };
  if (Object.hasOwn(value, 'paperUnits')) s.paperUnits = optionalUnit(value.paperUnits);
  if (Object.hasOwn(value, 'objectSnap')) {
    if (value.objectSnap !== undefined && typeof value.objectSnap !== 'boolean') return fail();
    s.objectSnap = value.objectSnap === undefined ? 0 : value.objectSnap ? 2 : 1;
  }
  return settings.encode({ fields: s, unknownFields: extensions.get('') ?? [] });
}
export function decodeNativeLayoutSettings(bytes: Uint8Array): { value: NativeLayoutSettings; extensions: LayoutSettingsExtensions } {
  const s = settings.decode(bytes), g = grid.decode(s.fields.grid as Uint8Array), unit = units[s.fields.units as number];
  if (unit === undefined) return fail();
  const value: NativeLayoutSettings = { units: unit, precision: finite(s.fields.precision), anglePrecision: finite(s.fields.anglePrecision),
    autoRender: s.fields.autoRender as boolean, grid: { spacingMm: finite(g.fields.spacingMm), show: g.fields.show as boolean, snap: g.fields.snap as boolean,
      angleSnapDeg: Object.hasOwn(g.fields, 'angleSnapDeg') ? finite(g.fields.angleSnapDeg) : null } };
  if (Object.hasOwn(g.fields, 'units')) present(value.grid, 'units', decodedUnit(g.fields.units!));
  if (Object.hasOwn(s.fields, 'paperUnits')) present(value, 'paperUnits', decodedUnit(s.fields.paperUnits!));
  if (Object.hasOwn(s.fields, 'objectSnap')) {
    const snap = s.fields.objectSnap; if (snap !== 0 && snap !== 1 && snap !== 2) return fail();
    present(value, 'objectSnap', snap === 0 ? undefined : snap === 2);
  }
  const extensions: LayoutSettingsExtensions = new Map();
  if (s.unknownFields.length) extensions.set('', s.unknownFields);
  if (g.unknownFields.length) extensions.set('grid', g.unknownFields);
  return { value, extensions };
}
