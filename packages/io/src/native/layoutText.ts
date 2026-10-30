// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutText, LayoutTextSpan, LayoutLineSpacing } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
export type LayoutTextExtensions = Map<string, Uint8Array[]>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const text = new NativeRecordCodec({ content: f(1, 'string'), fontFamily: f(2, 'string'), fontSizePt: f(3, 'double'), color: f(4, 'string'),
  bold: f(5, 'bool'), italic: f(6, 'bool'), underline: f(7, 'bool'), align: f(8, 'uint32'), vertical: f(9, 'uint32'), bounded: f(10, 'bool'),
  leader: f(11, 'uint32'), endpoint: f(12, 'uint32'), spans: f(13, 'bytes', false), list: f(14, 'uint32', false), lineSpacing: f(15, 'bytes', false),
  tabStopsPt: f(16, 'bytes', false), rotationDeg: f(17, 'bytes', false), leaderOffsetMm: f(18, 'bytes', false) } satisfies Record<Exclude<keyof LayoutText, 'nativeUnknownFields'>, NativeField>);
const span = new NativeRecordCodec({ start: f(1, 'uint32'), end: f(2, 'uint32'), bold: f(3, 'bool'), italic: f(4, 'bool'), underline: f(5, 'bool'),
  fontFamily: f(6, 'bytes', false), fontSizePt: f(7, 'bytes', false), color: f(8, 'bytes', false) } satisfies Record<Exclude<keyof LayoutTextSpan, 'nativeUnknownFields'>, NativeField>);
const spans = new NativeRecordCodec({ state: f(1, 'uint32'), entries: { ...f(2, 'bytes', false), repeated: true } });
const spacing = new NativeRecordCodec({ mode: f(1, 'uint32'), value: f(2, 'double') } satisfies Record<Exclude<keyof LayoutLineSpacing, 'nativeUnknownFields'>, NativeField>);
const optionalString = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'string', false) });
const optionalNumber = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'double', false) });
const optionalBytes = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'bytes', false) });
const enums = { align: ['left', 'center', 'right'], vertical: ['top', 'middle', 'bottom'], leader: ['straight', 'elbow', 'none'],
  endpoint: ['arrow', 'dot', 'none'], list: ['none', 'bullet', 'number'], mode: ['multiple', 'exactly', 'atLeast'] } as const;
const fail = (): never => { throw new NativeChunkError('Invalid native Layout text'); };
function finite(n: unknown): number { if (typeof n !== 'number' || !Number.isFinite(n)) return fail(); return n; }
function code(key: keyof typeof enums, value: unknown): number { const n = (enums[key] as readonly unknown[]).indexOf(value); if (n < 0) return fail(); return n; }
function choice(key: keyof typeof enums, value: NativeScalar | undefined): string { if (typeof value !== 'number') return fail(); return enums[key][value] ?? fail(); }
function read(codec: NativeRecordCodec, bytes: Uint8Array, key: string, ext: LayoutTextExtensions) {
  const r = codec.decode(bytes); if (r.unknownFields.length) ext.set(key, r.unknownFields); return r.fields;
}
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, key: string, ext: LayoutTextExtensions) {
  return codec.encode({ fields, unknownFields: ext.get(key) ?? [] });
}
function wrap(codec: NativeRecordCodec, value: NativeScalar | undefined, key: string, ext: LayoutTextExtensions) {
  return write(codec, value === undefined ? { state: 0 } : { state: 1, value }, key, ext);
}
function unwrap(codec: NativeRecordCodec, bytes: Uint8Array, key: string, ext: LayoutTextExtensions): NativeScalar | undefined {
  const r = read(codec, bytes, key, ext), has = Object.hasOwn(r, 'value');
  if (r.state === 0 && !has) return undefined;
  if (r.state === 1 && has) return r.value;
  return fail();
}
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true }); }
function spanRange(s: LayoutTextSpan): void { if (s.end < s.start) fail(); }
export function encodeNativeLayoutText(value: LayoutText, ext: LayoutTextExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  const fields: Record<string, NativeScalar> = { content: value.content, fontFamily: value.fontFamily, fontSizePt: finite(value.fontSizePt), color: value.color,
    bold: value.bold, italic: value.italic, underline: value.underline, align: code('align', value.align), vertical: code('vertical', value.vertical),
    bounded: value.bounded, leader: code('leader', value.leader), endpoint: code('endpoint', value.endpoint) };
  for (const key of ['rotationDeg', 'leaderOffsetMm'] as const) if (Object.hasOwn(value, key)) fields[key] = wrap(optionalNumber, value[key] === undefined ? undefined : finite(value[key]), key, ext);
  if (Object.hasOwn(value, 'list')) fields.list = value.list === undefined ? 0 : code('list', value.list) + 1;
  if (Object.hasOwn(value, 'lineSpacing')) fields.lineSpacing = wrap(optionalBytes, value.lineSpacing === undefined ? undefined :
    spacing.encode({ fields: { mode: code('mode', value.lineSpacing.mode), value: finite(value.lineSpacing.value) }, unknownFields: value.lineSpacing.nativeUnknownFields ?? ext.get('lineSpacing.value') ?? [] }), 'lineSpacing', ext);
  if (Object.hasOwn(value, 'tabStopsPt')) {
    let bytes: Uint8Array | undefined;
    if (value.tabStopsPt !== undefined) {
      if (value.tabStopsPt.length > 131072) return fail(); bytes = new Uint8Array(value.tabStopsPt.length * 8); const view = new DataView(bytes.buffer);
      for (let i = 0; i < value.tabStopsPt.length; i++) view.setFloat64(i * 8, finite(value.tabStopsPt[i]), true);
    }
    fields.tabStopsPt = wrap(optionalBytes, bytes, 'tabStopsPt', ext);
  }
  if (Object.hasOwn(value, 'spans')) {
    if (value.spans !== undefined && !Array.isArray(value.spans)) return fail();
    if (value.spans && value.spans.length > 65536) return fail();
    const entries: Uint8Array[] = []; let bytes = 0;
    for (const [i, s] of (value.spans ?? []).entries()) {
      spanRange(s); const key = `spans/${i}`, fields: Record<string, NativeScalar> = { start: s.start, end: s.end, bold: s.bold, italic: s.italic, underline: s.underline };
      const spanExt = s.nativeUnknownFields ? new Map([...s.nativeUnknownFields].map(([name, bytes]) => [name ? `${key}/${name}` : key, bytes])) : ext;
      for (const name of ['fontFamily', 'fontSizePt', 'color'] as const) if (Object.hasOwn(s, name)) fields[name] = wrap(name === 'fontSizePt' ? optionalNumber : optionalString,
        name === 'fontSizePt' && s[name] !== undefined ? finite(s[name]) : s[name], `${key}/${name}`, spanExt);
      const encoded = write(span, fields, key, spanExt); bytes += encoded.length; if (bytes > 1024 * 1024) return fail(); entries.push(encoded);
    }
    fields.spans = write(spans, { state: value.spans === undefined ? 0 : 1, entries }, 'spans', ext);
  }
  return write(text, fields, '', ext);
}

/** Move positional decode sidecars onto the editable rich-text owners. */
export function attachNativeLayoutTextFields(value: LayoutText, extensions: LayoutTextExtensions, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  const remaining = new Map(extensions);
  for (const [i, span] of (value.spans ?? []).entries()) {
    const fields = new Map<string, Uint8Array[]>(), prefix = `spans/${i}`;
    for (const key of ['', 'fontFamily', 'fontSizePt', 'color']) {
      const path = key ? `${prefix}/${key}` : prefix, bytes = remaining.get(path);
      if (bytes) { fields.set(key, bytes); remaining.delete(path); }
    }
    if (fields.size) span.nativeUnknownFields = fields;
  }
  const spacingFields = remaining.get('lineSpacing.value');
  if (value.lineSpacing && spacingFields) { value.lineSpacing.nativeUnknownFields = spacingFields; remaining.delete('lineSpacing.value'); }
  if (remaining.size || envelope.length || outer.length) value.nativeUnknownFields = {
    ...(remaining.size ? { extensions: remaining } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
export function decodeNativeLayoutText(bytes: Uint8Array): { value: LayoutText; extensions: LayoutTextExtensions } {
  const ext: LayoutTextExtensions = new Map(), r = read(text, bytes, '', ext);
  const value: LayoutText = { content: r.content as string, fontFamily: r.fontFamily as string, fontSizePt: finite(r.fontSizePt), color: r.color as string,
    bold: r.bold as boolean, italic: r.italic as boolean, underline: r.underline as boolean, align: choice('align', r.align) as LayoutText['align'],
    vertical: choice('vertical', r.vertical) as LayoutText['vertical'], bounded: r.bounded as boolean,
    leader: choice('leader', r.leader) as LayoutText['leader'], endpoint: choice('endpoint', r.endpoint) as LayoutText['endpoint'] };
  for (const key of ['rotationDeg', 'leaderOffsetMm'] as const) if (Object.hasOwn(r, key)) {
    const n = unwrap(optionalNumber, r[key] as Uint8Array, key, ext); present(value, key, n === undefined ? undefined : finite(n));
  }
  if (Object.hasOwn(r, 'list')) present(value, 'list', r.list === 0 ? undefined : choice('list', (r.list as number) - 1));
  if (Object.hasOwn(r, 'lineSpacing')) {
    const payload = unwrap(optionalBytes, r.lineSpacing as Uint8Array, 'lineSpacing', ext);
    if (payload === undefined) present(value, 'lineSpacing', undefined);
    else { const s = read(spacing, payload as Uint8Array, 'lineSpacing.value', ext); value.lineSpacing = { mode: choice('mode', s.mode) as LayoutLineSpacing['mode'], value: finite(s.value) }; }
  }
  if (Object.hasOwn(r, 'tabStopsPt')) {
    const payload = unwrap(optionalBytes, r.tabStopsPt as Uint8Array, 'tabStopsPt', ext);
    if (payload === undefined) present(value, 'tabStopsPt', undefined);
    else {
      const bytes = payload as Uint8Array; if (bytes.length % 8) return fail(); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), stops = [];
      for (let i = 0; i < bytes.length; i += 8) stops.push(finite(view.getFloat64(i, true))); value.tabStopsPt = stops;
    }
  }
  if (Object.hasOwn(r, 'spans')) {
    const s = read(spans, r.spans as Uint8Array, 'spans', ext), entries = s.entries as Uint8Array[] | undefined;
    if (s.state === 0) { if (entries?.length) return fail(); present(value, 'spans', undefined); }
    else if (s.state === 1) {
      value.spans = (entries ?? []).map((bytes, i) => {
        const key = `spans/${i}`, s = read(span, bytes, key, ext), value: LayoutTextSpan = { start: s.start as number, end: s.end as number, bold: s.bold as boolean, italic: s.italic as boolean, underline: s.underline as boolean };
        spanRange(value);
        for (const name of ['fontFamily', 'fontSizePt', 'color'] as const) if (Object.hasOwn(s, name)) {
          const n = unwrap(name === 'fontSizePt' ? optionalNumber : optionalString, s[name] as Uint8Array, `${key}/${name}`, ext);
          present(value, name, name === 'fontSizePt' && n !== undefined ? finite(n) : n);
        }
        return value;
      });
    } else return fail();
  }
  return { value, extensions: ext };
}
