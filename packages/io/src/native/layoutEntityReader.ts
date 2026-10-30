// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { validLayoutTable } from '@pushform/layout';
import type { LayoutEntity } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import type { NativeColumnReader } from './columns';
import { nativeLayoutAssetFields } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
import { decodeNativeLayoutEntityHeader } from './layoutEntityWriter';
import type { NativeLayoutEntityRecord, NativeLayoutEntityPayload } from './layoutEntityWriter';
import { readNativeLayoutGeometry, materializeNativeLayoutGeometry } from './layoutGeometry';
import type { NativePackedLayoutGeometry } from './layoutGeometry';
import { decodeNativeLayoutImage, readNativeLayoutImage, materializeNativeLayoutImage } from './layoutImage';
import type { NativePackedLayoutImage } from './layoutImage';
import { decodeNativeLayoutText, attachNativeLayoutTextFields } from './layoutText';
import { decodeNativeLayoutLinearDimension, decodeNativeLayoutAngularDimension, decodeNativeLayoutDimensionAnchor, attachNativeLayoutDimensionFields } from './layoutDimension';
import { decodeNativeLayoutTableHeader, decodeNativeLayoutTableCell, attachNativeLayoutTableFields, attachNativeLayoutTableCellFields } from './layoutTable';
import { decodeNativeLayoutModelAnnotation, attachNativeLayoutModelAnnotationFields } from './layoutModelAnnotation';
import { decodeNativeLayoutConnections, attachNativeLayoutConnectionFields, resolveNativeLayoutConnections, materializeNativeLayoutConnections } from './layoutConnections';
import type { NativeLayoutConnections } from './layoutConnections';
import { validLayoutEntityContent } from '../layoutFile';
type SmallPayloads = Pick<LayoutEntity, 'table' | 'text' | 'dimension' | 'angularDimension' | 'labelAnchor' | 'modelAnnotation'>;
export interface NativePackedLayoutEntity {
  emptyPayloads?: NonNullable<LayoutEntity['nativeUnknownFields']>['emptyPayloads'];
  outerHeaderUnknown?: Uint8Array[];
  header: ReturnType<typeof decodeNativeLayoutEntityHeader>;
  geometry: NativePackedLayoutGeometry;
  data: SmallPayloads;
  image?: NativePackedLayoutImage | undefined;
  connections?: NativeLayoutConnections | undefined;
  connectionAsset?: NativeLayoutAsset;
  /** Owned payload/envelope sidecars; header and geometry sidecars stay with their typed references. */
  extensions: Map<string, Uint8Array[]>;
}
const fail = (): never => { throw new NativeChunkError('Invalid native Layout entity assembly'); };
function retain(target: Map<string, Uint8Array[]>, prefix: string, source: ReadonlyMap<string, Uint8Array[]>): void {
  for (const [key, fields] of source) target.set(`${prefix}/${key}`, fields);
}
function present(target: object, key: string, value: unknown) { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); }
/** One entity at a time: release encoded records as they are consumed, retaining only typed data and extension fields. */
export async function readNativeLayoutEntity(records: Iterable<NativeLayoutEntityRecord> | AsyncIterable<NativeLayoutEntityRecord>, columns: NativeColumnReader,
  assets: ReadonlyMap<number, NativeLayoutAsset>, signal?: AbortSignal): Promise<NativePackedLayoutEntity> {
  let result: NativePackedLayoutEntity | undefined; const seen = new Set<NativeLayoutEntityPayload>();
  for await (const record of records) {
    signal?.throwIfAborted();
    if (!result) {
      if (record.kind !== 'header' || record.payload === undefined) return fail();
      const header = decodeNativeLayoutEntityHeader(record.payload); if (header.metadata.value.id !== record.ownerId) return fail();
      result = { header, geometry: await readNativeLayoutGeometry(header.geometry, columns, signal), data: {}, extensions: new Map() };
      if (record.unknownFields.length) result.extensions.set('envelope/header', record.unknownFields); continue;
    }
    if (record.ownerId !== result.header.metadata.value.id || record.kind === 'header') return fail();
    const { kind, payload } = record, ext = result.extensions;
    if (kind === 'tableCell') {
      const table = result.data.table; if (!table || payload === undefined || table.cells.length >= table.rows.length * table.columns.length) return fail();
      const c = decodeNativeLayoutTableCell(payload); if (c.index !== table.cells.length) return fail(); attachNativeLayoutTableCellFields(c, record.unknownFields, record.outerUnknown); table.cells.push(c.value);
      retain(ext, `table/cell/${c.index}`, c.extensions); retain(ext, `table/cell/${c.index}/text`, c.textExtensions);
      if (record.unknownFields.length) ext.set(`envelope/tableCell/${c.index}`, record.unknownFields); continue;
    }
    if (seen.has(kind) || !result.header.payloads.includes(kind)) return fail(); seen.add(kind);
    if (record.unknownFields.length) ext.set(`envelope/${kind}`, record.unknownFields);
    if (payload === undefined) {
      if (record.unknownFields.length || record.outerUnknown?.length) {
        result.emptyPayloads ??= new Map();
        result.emptyPayloads.set(kind, { ...(record.unknownFields.length ? { envelope: record.unknownFields } : {}), ...(record.outerUnknown?.length ? { outerEnvelope: record.outerUnknown } : {}) });
        ext.delete(`envelope/${kind}`);
      }
      if (kind === 'image') result.image = undefined;
      else if (kind === 'preservedModelConnections') result.connections = undefined;
      else present(result.data, kind, undefined);
      continue;
    }
    switch (kind) {
      case 'table': { const t = decodeNativeLayoutTableHeader(payload); attachNativeLayoutTableFields(t.value, t.extensions, record.unknownFields, record.outerUnknown); result.data.table = { ...t.value, cells: [] }; retain(ext, 'table/header', t.extensions); break; }
      case 'image': result.image = await readNativeLayoutImage(decodeNativeLayoutImage(payload), assets, columns, signal);
        if (record.unknownFields.length) result.image.envelope = record.unknownFields;
        if (record.outerUnknown?.length) result.image.outerEnvelope = record.outerUnknown; break;
      case 'text': { const t = decodeNativeLayoutText(payload); attachNativeLayoutTextFields(t.value, t.extensions, record.unknownFields, record.outerUnknown); result.data.text = t.value; retain(ext, kind, t.extensions); break; }
      case 'dimension': { const d = decodeNativeLayoutLinearDimension(payload); attachNativeLayoutDimensionFields(d.value, d.extensions, record.unknownFields, record.outerUnknown); result.data.dimension = d.value; retain(ext, kind, d.extensions); break; }
      case 'angularDimension': { const d = decodeNativeLayoutAngularDimension(payload); attachNativeLayoutDimensionFields(d.value, d.extensions, record.unknownFields, record.outerUnknown); result.data.angularDimension = d.value; retain(ext, kind, d.extensions); break; }
      case 'labelAnchor': { const e = new Map<string, Uint8Array[]>(); const anchor = decodeNativeLayoutDimensionAnchor(payload, e);
        if (e.size || record.unknownFields.length || record.outerUnknown?.length) anchor.nativeUnknownFields = {
          ...(e.size ? { extensions: new Map([...e].map(([key, fields]) => [key === '/t' ? 't' : key, fields])) } : {}),
          ...(record.unknownFields.length ? { envelope: record.unknownFields } : {}), ...(record.outerUnknown?.length ? { outerEnvelope: record.outerUnknown } : {}),
        };
        result.data.labelAnchor = anchor; retain(ext, kind, e); break; }
      case 'modelAnnotation': { const a = decodeNativeLayoutModelAnnotation(payload); attachNativeLayoutModelAnnotationFields(a.value, a.extensions, record.unknownFields, record.outerUnknown); result.data.modelAnnotation = a.value; retain(ext, kind, a.extensions); break; }
      case 'preservedModelConnections': { const c = decodeNativeLayoutConnections(payload); const asset = resolveNativeLayoutConnections(c.value, assets); result.connectionAsset = asset; attachNativeLayoutConnectionFields(c.value, c.extensions, record.unknownFields, record.outerUnknown); result.connections = c.value; retain(ext, kind, c.extensions); break; }
      default: return fail();
    }
  }
  signal?.throwIfAborted();
  if (!result || seen.size !== result.header.payloads.length || result.data.table && !validLayoutTable(result.data.table)) return fail();
  return result;
}
/** Materialize only at the existing editor boundary, then apply the same content validator as Layout persistence. */
export function materializeNativeLayoutEntity(packed: NativePackedLayoutEntity, assetStrings: ReadonlyMap<number, string>): LayoutEntity {
  const value: LayoutEntity = { ...packed.header.metadata.value, ...materializeNativeLayoutGeometry(packed.geometry), ...packed.data };
  const metadata = new Map(packed.header.metadata.extensions.records);
  if (value.style) {
    const records = new Map<string, Uint8Array[]>(), style = new Map(packed.header.metadata.extensions.style);
    for (const key of ['style/value', 'style/dash']) { const fields = metadata.get(key); if (fields) { records.set(key, fields); metadata.delete(key); } }
    for (const key of ['startArrow', 'endArrow'] as const) {
      const arrow = value.style[key], fields = style.get(key);
      if (arrow && fields) { arrow.nativeUnknownFields = fields; style.delete(key); }
    }
    if (records.size || style.size) value.style.nativeUnknownFields = { records, style };
  }
  const envelope = packed.extensions.get('envelope/header'), geometry = packed.geometry.reference.extensions;
  if (packed.outerHeaderUnknown?.length || envelope?.length || packed.header.unknownFields.length || geometry.size || metadata.size || packed.emptyPayloads?.size) value.nativeUnknownFields = {
    ...(packed.outerHeaderUnknown?.length ? { outerHeader: packed.outerHeaderUnknown } : {}),
    ...(envelope?.length ? { headerEnvelope: envelope } : {}),
    ...(packed.header.unknownFields.length ? { header: packed.header.unknownFields } : {}),
    ...(geometry.size ? { geometry } : {}),
    ...(metadata.size ? { metadata } : {}),
    ...(packed.emptyPayloads?.size ? { emptyPayloads: packed.emptyPayloads } : {}),
  };
  if (Object.hasOwn(packed, 'image')) present(value, 'image', packed.image === undefined ? undefined : materializeNativeLayoutImage(packed.image, assetStrings));
  if (Object.hasOwn(packed, 'connections')) present(value, 'preservedModelConnections', packed.connections === undefined ? undefined : { ...materializeNativeLayoutConnections(packed.connections, assetStrings), ...(packed.connectionAsset ? nativeLayoutAssetFields(packed.connectionAsset) : {}) });
  if (!validLayoutEntityContent(value)) return fail(); return value;
}
