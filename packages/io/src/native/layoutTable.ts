// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { validLayoutTable } from '@pushform/layout';
import type { LayoutTable, LayoutTableCell, LayoutTableEdge } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { encodeNativeLayoutText, decodeNativeLayoutText, attachNativeLayoutTextFields } from './layoutText';
import type { LayoutTextExtensions } from './layoutText';
export type NativeLayoutTableHeader = Omit<LayoutTable, 'cells'>;
export type LayoutTableExtensions = Map<string, Uint8Array[]>;
export interface NativeLayoutTableCell { index: number; value: LayoutTableCell; extensions: LayoutTableExtensions; textExtensions: LayoutTextExtensions }
export interface NativeLayoutTableExtensions {
  header: LayoutTableExtensions;
  cells: ReadonlyMap<number, { extensions: LayoutTableExtensions; textExtensions: LayoutTextExtensions }>;
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const header = new NativeRecordCodec({ rows: f(1, 'bytes'), columns: f(2, 'bytes'), merges: { ...f(3, 'bytes', false), repeated: true },
  rowEdges: f(4, 'bytes', false), columnEdges: f(5, 'bytes', false) } satisfies Record<Exclude<keyof NativeLayoutTableHeader, 'nativeUnknownFields'>, NativeField>);
const merge = new NativeRecordCodec({ row: f(1, 'uint32'), column: f(2, 'uint32'), rowSpan: f(3, 'uint32'), columnSpan: f(4, 'uint32') } satisfies Record<Exclude<keyof LayoutTable['merges'][number], 'nativeUnknownFields'>, NativeField>);
const edge = new NativeRecordCodec({ strokeColor: f(1, 'string'), strokeWeightPt: f(2, 'double'), strokeDashMm: f(3, 'bytes', false) } satisfies Record<Exclude<keyof LayoutTableEdge, 'nativeUnknownFields'>, NativeField>);
const edges = new NativeRecordCodec({ state: f(1, 'uint32'), entries: { ...f(2, 'bytes', false), repeated: true } });
const cell = new NativeRecordCodec({ index: f(1, 'uint32'), text: f(2, 'bytes'), fillColor: f(3, 'bytes', false), rotationDeg: f(4, 'uint32', false) } satisfies Record<Exclude<keyof LayoutTableCell, 'nativeUnknownFields'> | 'index', NativeField>);
const fill = new NativeRecordCodec({ state: f(1, 'uint32'), value: f(2, 'string', false) });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout table'); };
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, key: string, extensions: LayoutTableExtensions) {
  return codec.encode({ fields, unknownFields: extensions.get(key) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, key: string, extensions: LayoutTableExtensions) {
  const r = codec.decode(bytes); if (r.unknownFields.length) extensions.set(key, r.unknownFields); return r.fields;
}
function numbers(values: readonly number[], max: number): Uint8Array {
  if (!Array.isArray(values) || values.length > max) return fail();
  const bytes = new Uint8Array(values.length * 8), view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) { if (!Number.isFinite(values[i])) return fail(); view.setFloat64(i * 8, values[i]!, true); }
  return bytes;
}
function readNumbers(bytes: Uint8Array, max: number): number[] {
  if (bytes.length % 8 || bytes.length / 8 > max) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), values = [];
  for (let at = 0; at < bytes.length; at += 8) { const n = view.getFloat64(at, true); if (!Number.isFinite(n)) return fail(); values.push(n); }
  return values;
}
/** Validate shape without manufacturing placeholder text/cell objects. Final assembly also uses the product validator. */
function validateHeader(value: NativeLayoutTableHeader): void {
  for (const sizes of [value.rows, value.columns]) {
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > 100) fail();
    let sum = 0; for (const n of sizes) { if (!Number.isFinite(n) || n <= 0) fail(); sum += n; } if (!Number.isFinite(sum)) fail();
  }
  const cells = value.rows.length * value.columns.length;
  if (!Array.isArray(value.merges) || value.merges.length > cells / 2) fail();
  const covered = new Uint8Array(cells);
  for (const m of value.merges) {
    if (!m || ![m.row, m.column, m.rowSpan, m.columnSpan].every(Number.isInteger) || m.row < 0 || m.column < 0 || m.rowSpan < 1 || m.columnSpan < 1 ||
      m.rowSpan * m.columnSpan < 2 || m.row + m.rowSpan > value.rows.length || m.column + m.columnSpan > value.columns.length) fail();
    for (let r = m.row; r < m.row + m.rowSpan; r++) for (let c = m.column; c < m.column + m.columnSpan; c++) {
      const at = r * value.columns.length + c; if (covered[at]) fail(); covered[at] = 1;
    }
  }
  for (const key of ['rowEdges', 'columnEdges'] as const) {
    const entries = value[key]; if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length !== (key === 'rowEdges' ? value.rows.length : value.columns.length) - 1) fail();
    for (const e of entries) {
      if (!e || typeof e.strokeColor !== 'string' || !Number.isFinite(e.strokeWeightPt) || e.strokeWeightPt <= 0) fail();
      if (e.strokeDashMm !== undefined) { if (!Array.isArray(e.strokeDashMm)) fail(); for (const n of e.strokeDashMm) if (!Number.isFinite(n) || n < 0) fail(); }
    }
  }
}
export function encodeNativeLayoutTableHeader(value: NativeLayoutTableHeader, extensions: LayoutTableExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  validateHeader(value); let size = 0;
  const bound = (bytes: Uint8Array) => { size += bytes.length; if (size > 1024 * 1024) fail(); return bytes; };
  const fields: Record<string, NativeScalar> = { rows: numbers(value.rows, 100), columns: numbers(value.columns, 100),
    merges: value.merges.map((m, i) => bound(merge.encode({ fields: { row: m.row, column: m.column, rowSpan: m.rowSpan, columnSpan: m.columnSpan }, unknownFields: m.nativeUnknownFields ?? extensions.get(`merges/${i}`) ?? [] }))) };
  for (const key of ['rowEdges', 'columnEdges'] as const) if (Object.hasOwn(value, key)) {
    const entries = value[key];
    fields[key] = write(edges, { state: entries === undefined ? 0 : 1, entries: (entries ?? []).map((e, i) => {
      const fields: Record<string, NativeScalar> = { strokeColor: e.strokeColor, strokeWeightPt: e.strokeWeightPt };
      if (Object.hasOwn(e, 'strokeDashMm')) {
        const ns = e.strokeDashMm === undefined ? new Uint8Array() : numbers(e.strokeDashMm, 131071), bytes = new Uint8Array(ns.length + 1);
        bytes[0] = e.strokeDashMm === undefined ? 0 : 1; bytes.set(ns, 1); fields.strokeDashMm = bytes;
      }
      return bound(edge.encode({ fields, unknownFields: e.nativeUnknownFields ?? extensions.get(`${key}/${i}`) ?? [] }));
    }) }, key, extensions);
  }
  return write(header, fields, '', extensions);
}
export function decodeNativeLayoutTableHeader(bytes: Uint8Array): { value: NativeLayoutTableHeader; extensions: LayoutTableExtensions } {
  const extensions: LayoutTableExtensions = new Map(), h = read(header, bytes, '', extensions);
  const value: NativeLayoutTableHeader = { rows: readNumbers(h.rows as Uint8Array, 100), columns: readNumbers(h.columns as Uint8Array, 100),
    merges: ((h.merges ?? []) as Uint8Array[]).map((bytes, i) => {
      const m = read(merge, bytes, `merges/${i}`, extensions);
      return { row: m.row as number, column: m.column as number, rowSpan: m.rowSpan as number, columnSpan: m.columnSpan as number };
    }) };
  for (const key of ['rowEdges', 'columnEdges'] as const) if (Object.hasOwn(h, key)) {
    const e = read(edges, h[key] as Uint8Array, key, extensions), entries = (e.entries ?? []) as Uint8Array[];
    if (e.state === 0) { if (entries.length) fail(); present(value, key, undefined); }
    else if (e.state === 1) value[key] = entries.map((bytes, i) => {
      const e = read(edge, bytes, `${key}/${i}`, extensions), result: LayoutTableEdge = { strokeColor: e.strokeColor as string, strokeWeightPt: e.strokeWeightPt as number };
      if (Object.hasOwn(e, 'strokeDashMm')) {
        const bytes = e.strokeDashMm as Uint8Array;
        if (bytes[0] === 0 && bytes.length === 1) present(result, 'strokeDashMm', undefined);
        else if (bytes[0] === 1) result.strokeDashMm = readNumbers(bytes.subarray(1), 131071); else fail();
      }
      return result;
    }); else fail();
  }
  validateHeader(value); return { value, extensions };
}
export function encodeNativeLayoutTableCell(index: number, value: LayoutTableCell, extensions: LayoutTableExtensions = value.nativeUnknownFields?.extensions ?? new Map(), textExtensions?: LayoutTextExtensions): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= 10000) return fail();
  const fields: Record<string, NativeScalar> = { index, text: encodeNativeLayoutText(value.text, textExtensions) };
  if (Object.hasOwn(value, 'fillColor')) fields.fillColor = write(fill, value.fillColor === undefined ? { state: 0 } : value.fillColor === null ? { state: 1 } : { state: 2, value: value.fillColor }, 'fillColor', extensions);
  if (Object.hasOwn(value, 'rotationDeg')) {
    const code = value.rotationDeg === undefined ? 0 : [90, 180, 270].indexOf(value.rotationDeg) + 1; if (!code && value.rotationDeg !== undefined) return fail(); fields.rotationDeg = code;
  }
  return write(cell, fields, '', extensions);
}
export function decodeNativeLayoutTableCell(bytes: Uint8Array): NativeLayoutTableCell {
  const extensions: LayoutTableExtensions = new Map(), c = read(cell, bytes, '', extensions), index = c.index as number;
  if (index >= 10000) return fail();
  const t = decodeNativeLayoutText(c.text as Uint8Array), value: LayoutTableCell = { text: t.value };
  if (Object.hasOwn(c, 'fillColor')) {
    const r = read(fill, c.fillColor as Uint8Array, 'fillColor', extensions), has = Object.hasOwn(r, 'value');
    if (r.state === 0 && !has) present(value, 'fillColor', undefined);
    else if (r.state === 1 && !has) value.fillColor = null;
    else if (r.state === 2 && has) value.fillColor = r.value as string; else fail();
  }
  if (Object.hasOwn(c, 'rotationDeg')) {
    if (c.rotationDeg === 0) present(value, 'rotationDeg', undefined);
    else { const rotation = ([90, 180, 270] as const)[(c.rotationDeg as number) - 1]; if (rotation === undefined) return fail(); value.rotationDeg = rotation; }
  }
  return { index, value, extensions, textExtensions: t.extensions };
}
/** Move positional wire fields onto the editable owners before table edits can reorder them. */
export function attachNativeLayoutTableFields(value: NativeLayoutTableHeader, extensions: LayoutTableExtensions, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  const remaining = new Map(extensions);
  for (const key of ['merges', 'rowEdges', 'columnEdges'] as const) for (const [i, owner] of (value[key] ?? []).entries()) {
    const path = `${key}/${i}`, fields = remaining.get(path);
    if (fields) { owner.nativeUnknownFields = fields; remaining.delete(path); }
  }
  if (remaining.size || envelope.length || outer.length) value.nativeUnknownFields = {
    ...(remaining.size ? { extensions: remaining } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
export function attachNativeLayoutTableCellFields(cell: NativeLayoutTableCell, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  attachNativeLayoutTextFields(cell.value.text, cell.textExtensions, []);
  if (cell.extensions.size || envelope.length || outer.length) cell.value.nativeUnknownFields = {
    ...(cell.extensions.size ? { extensions: cell.extensions } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
/** Consume cells once and enforce exact row-major ownership; never retain a second encoded table. */
export function assembleNativeLayoutTable(header: NativeLayoutTableHeader, records: Iterable<NativeLayoutTableCell>) {
  validateHeader(header); const cells: LayoutTableCell[] = [], count = header.rows.length * header.columns.length;
  const cellExtensions = new Map<number, { extensions: LayoutTableExtensions; textExtensions: LayoutTextExtensions }>();
  for (const record of records) {
    if (record.index !== cells.length || cells.length >= count) return fail(); cells.push(record.value);
    if (record.extensions.size || record.textExtensions.size) cellExtensions.set(record.index, { extensions: record.extensions, textExtensions: record.textExtensions });
  }
  const value = { ...header, cells }; if (!validLayoutTable(value)) return fail(); return { value, cellExtensions };
}
/** Header first, then one cell record at a time; caller supplies entity ownership in the document record stream. */
export function* streamNativeLayoutTableRecords(value: LayoutTable, extensions?: NativeLayoutTableExtensions, signal?: AbortSignal): Generator<{ kind: 'header' | 'cell'; bytes: Uint8Array; envelope?: Uint8Array[]; outerEnvelope?: Uint8Array[] }> {
  signal?.throwIfAborted(); if (!validLayoutTable(value)) return fail();
  const { cells, ...header } = value;
  yield { kind: 'header', bytes: encodeNativeLayoutTableHeader(header, extensions?.header), ...value.nativeUnknownFields };
  for (let i = 0; i < cells.length; i++) {
    signal?.throwIfAborted(); const e = extensions?.cells.get(i);
    yield { kind: 'cell', bytes: encodeNativeLayoutTableCell(i, cells[i]!, e?.extensions, e?.textExtensions), ...cells[i]!.nativeUnknownFields };
  }
}
