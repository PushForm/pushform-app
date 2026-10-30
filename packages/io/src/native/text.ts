// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Vec3 } from '@pushform/core';
import type { CommonAttrs, TextEntity } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeScalar } from './record';
import { encodeNativeNumbers, decodeNativeNumbers } from './fixedNumbers';
import { NativeChunkError } from './chunks';
import type { NativePlacement } from './placements';
export type NativeText = Omit<TextEntity, keyof CommonAttrs | 'nativeUnknownFields'>;
const fields = {
  id: { id: 1, kind: 'uint32', required: true }, text: { id: 3, kind: 'string', required: true }, kind: { id: 4, kind: 'uint32', required: true },
  position: { id: 5, kind: 'bytes', required: true }, offset: { id: 6, kind: 'bytes', required: false }, leader: { id: 7, kind: 'uint32', required: true },
  viewOffset: { id: 8, kind: 'bytes', required: false }, fontFamily: { id: 9, kind: 'string', required: true }, fontSizePt: { id: 10, kind: 'double', required: true },
  bold: { id: 11, kind: 'uint32', required: false }, italic: { id: 12, kind: 'uint32', required: false }, color: { id: 13, kind: 'bytes', required: true }, arrow: { id: 14, kind: 'uint32', required: false },
} satisfies Record<keyof NativeText, NativeField>;
const { id: idField, ...remainingFields } = fields;
const codec = new NativeRecordCodec({ id: idField, properties: { id: 2, kind: 'uint32', required: true }, ...remainingFields });
const leaders = ['none', 'view', 'pushpin'] as const, arrows = ['none', 'slash', 'dot', 'closed', 'open'] as const;
const fail = (): never => { throw new NativeChunkError('Invalid native text'); };
function property(id: number): void { if (!Number.isInteger(id) || id < 1 || id > 0xffff_ffff) fail(); }
const vec = (bytes: NativeScalar): Vec3 => decodeNativeNumbers(bytes as Uint8Array, 3) as unknown as Vec3;
export function encodeNativeText(record: NativePlacement<NativeText>): Uint8Array {
  property(record.properties); const v = record.value, kind = v.kind === 'screen' ? 0 : v.kind === 'leader' ? 1 : -1, leader = leaders.indexOf(v.leader);
  if (kind < 0 || leader < 0 || !Number.isFinite(v.fontSizePt)) return fail();
  const f: Record<string, NativeScalar> = { id: v.id, properties: record.properties, text: v.text, kind, position: encodeNativeNumbers(v.position, 3),
    leader, fontFamily: v.fontFamily, fontSizePt: v.fontSizePt, color: encodeNativeNumbers(v.color, 3) };
  if (v.offset !== null) f.offset = encodeNativeNumbers(v.offset, 3);
  if (Object.hasOwn(v, 'viewOffset')) f.viewOffset = v.viewOffset === undefined ? new Uint8Array() : encodeNativeNumbers(v.viewOffset, 2);
  for (const name of ['bold', 'italic'] as const) if (Object.hasOwn(v, name)) {
    if (v[name] !== undefined && typeof v[name] !== 'boolean') return fail();
    f[name] = v[name] === undefined ? 0 : v[name] ? 2 : 1;
  }
  if (Object.hasOwn(v, 'arrow')) { const code = v.arrow === undefined ? 0 : arrows.indexOf(v.arrow) + 1; if (v.arrow !== undefined && code === 0) return fail(); f.arrow = code; }
  return codec.encode({ fields: f, unknownFields: record.unknownFields });
}
export function decodeNativeText(bytes: Uint8Array): NativePlacement<NativeText> {
  const { fields: f, unknownFields } = codec.decode(bytes); property(f.properties as number);
  const leader = leaders[f.leader as number];
  if ((f.kind !== 0 && f.kind !== 1) || leader === undefined || !Number.isFinite(f.fontSizePt)) return fail();
  const value: NativeText = { id: f.id as Id, text: f.text as string, kind: f.kind === 0 ? 'screen' : 'leader', position: vec(f.position!),
    offset: f.offset === undefined ? null : vec(f.offset), leader, fontFamily: f.fontFamily as string, fontSizePt: f.fontSizePt as number, color: vec(f.color!) };
  if (Object.hasOwn(f, 'viewOffset')) {
    const bytes = f.viewOffset as Uint8Array;
    value.viewOffset = bytes.length === 0 ? undefined : decodeNativeNumbers(bytes, 2) as unknown as readonly [number, number];
  }
  for (const name of ['bold', 'italic'] as const) if (Object.hasOwn(f, name)) {
    const code = f[name] as number; if (code > 2) return fail(); value[name] = code === 0 ? undefined : code === 2;
  }
  if (Object.hasOwn(f, 'arrow')) { const code = f.arrow as number; if (code > arrows.length) return fail(); value.arrow = code === 0 ? undefined : arrows[code - 1]!; }
  return { value, properties: f.properties as number, unknownFields };
}
