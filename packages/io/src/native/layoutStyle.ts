// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutArrow, LayoutDocumentState } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
type Style = LayoutDocumentState['defaultStyle'];
export type LayoutStyleExtensions = Map<'' | 'startArrow' | 'endArrow', Uint8Array[]>;
// Stable wire order, independent of future UI ordering.
const arrows = ['filled-triangle', 'open-triangle', 'filled-skinny-triangle', 'open-skinny-triangle', 'open-arrow-90', 'open-arrow-120',
  'filled-circle', 'open-circle', 'filled-square', 'open-square', 'filled-diamond', 'open-diamond', 'star', 't-bar', 'slash-right', 'slash-left'] as const satisfies readonly LayoutArrow['type'][];
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const style = new NativeRecordCodec({ strokeColor: f(1, 'string'), strokeWeightPt: f(2, 'double'), fillColor: f(3, 'string', false),
  startArrow: f(4, 'bytes', false), endArrow: f(5, 'bytes', false) } satisfies Record<keyof Style, NativeField>);
const arrow = new NativeRecordCodec({ type: f(1, 'uint32'), sizePt: f(2, 'double', false) } satisfies Record<Exclude<keyof LayoutArrow, 'nativeUnknownFields'>, NativeField>);
const fail = (): never => { throw new NativeChunkError('Invalid native Layout default style'); };
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) return fail(); return value; }
export function encodeNativeLayoutStyle(value: Style, extensions: LayoutStyleExtensions = new Map()): Uint8Array {
  const fields: Record<string, NativeScalar> = { strokeColor: value.strokeColor, strokeWeightPt: finite(value.strokeWeightPt) };
  if (value.fillColor !== null) fields.fillColor = value.fillColor;
  for (const key of ['startArrow', 'endArrow'] as const) if (Object.hasOwn(value, key)) {
    const a = value[key], type = a === undefined ? 0 : arrows.indexOf(a.type) + 1;
    if (a !== undefined && !type) return fail();
    fields[key] = arrow.encode({ fields: a === undefined ? { type } : { type, sizePt: finite(a.sizePt) }, unknownFields: a?.nativeUnknownFields ?? extensions.get(key) ?? [] });
  }
  return style.encode({ fields, unknownFields: extensions.get('') ?? [] });
}
export function decodeNativeLayoutStyle(bytes: Uint8Array): { value: Style; extensions: LayoutStyleExtensions } {
  const decoded = style.decode(bytes), fields = decoded.fields, extensions: LayoutStyleExtensions = new Map();
  if (decoded.unknownFields.length) extensions.set('', decoded.unknownFields);
  const value: Style = { strokeColor: fields.strokeColor as string, strokeWeightPt: finite(fields.strokeWeightPt),
    fillColor: Object.hasOwn(fields, 'fillColor') ? fields.fillColor as string : null };
  for (const key of ['startArrow', 'endArrow'] as const) if (Object.hasOwn(fields, key)) {
    const a = arrow.decode(fields[key] as Uint8Array), type = a.fields.type as number;
    if (a.unknownFields.length) extensions.set(key, a.unknownFields);
    if (type === 0) { if (Object.hasOwn(a.fields, 'sizePt')) return fail(); Object.defineProperty(value, key, { value: undefined, enumerable: true, writable: true, configurable: true }); }
    else { const name = arrows[type - 1]; if (name === undefined) return fail(); value[key] = { type: name, sizePt: finite(a.fields.sizePt) }; }
  }
  return { value, extensions };
}
