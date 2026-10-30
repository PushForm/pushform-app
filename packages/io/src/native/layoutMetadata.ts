// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LAYOUT_FORMAT_VERSION } from '@pushform/layout';
import type { LayoutDocumentState, LayoutLayer } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind } from './record';
import { decodeNativeLayoutSettings, encodeNativeLayoutSettings } from './layoutSettings';
import type { LayoutSettingsExtensions } from './layoutSettings';
import { decodeNativeLayoutStyle, encodeNativeLayoutStyle } from './layoutStyle';
import type { LayoutStyleExtensions } from './layoutStyle';

export type NativeLayoutMetadata = Pick<LayoutDocumentState, 'meta' | 'settings' | 'defaultStyle' | 'activeLayerId'>;
export interface LayoutMetadataExtensions {
  records: Map<'' | 'meta', Uint8Array[]>;
  settings: LayoutSettingsExtensions;
  style: LayoutStyleExtensions;
}
const f = (id: number, kind: NativeFieldKind): NativeField => ({ id, kind, required: true });
const meta = new NativeRecordCodec({ guid: f(1, 'string'), nextId: f(2, 'uint53') } satisfies Record<Exclude<keyof LayoutDocumentState['meta'], 'formatVersion'>, NativeField>);
const metadata = new NativeRecordCodec({ meta: f(1, 'bytes'), settings: f(2, 'bytes'), defaultStyle: f(3, 'bytes'), activeLayerId: f(4, 'uint32') } satisfies Record<keyof NativeLayoutMetadata, NativeField>);
const layer = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), visible: f(3, 'bool'), locked: f(4, 'bool'), shared: f(5, 'bool') } satisfies Record<Exclude<keyof LayoutLayer, 'nativeUnknownFields'>, NativeField>);
const fail = (): never => { throw new NativeChunkError('Invalid native Layout metadata'); };
function id(value: number): void { if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) fail(); }
function validate(value: NativeLayoutMetadata): void {
  id(value.activeLayerId);
  if (!Number.isSafeInteger(value.meta.nextId) || value.meta.nextId <= value.activeLayerId || value.meta.formatVersion !== LAYOUT_FORMAT_VERSION) fail();
}
export function encodeNativeLayoutMetadata(value: NativeLayoutMetadata,
  extensions: LayoutMetadataExtensions = { records: new Map(), settings: new Map(), style: new Map() }): Uint8Array {
  validate(value);
  return metadata.encode({ fields: {
    meta: meta.encode({ fields: { guid: value.meta.guid, nextId: value.meta.nextId }, unknownFields: extensions.records.get('meta') ?? [] }),
    settings: encodeNativeLayoutSettings(value.settings, extensions.settings), defaultStyle: encodeNativeLayoutStyle(value.defaultStyle, extensions.style),
    activeLayerId: value.activeLayerId,
  }, unknownFields: extensions.records.get('') ?? [] });
}
export function decodeNativeLayoutMetadata(bytes: Uint8Array): { value: NativeLayoutMetadata; extensions: LayoutMetadataExtensions } {
  const record = metadata.decode(bytes), m = meta.decode(record.fields.meta as Uint8Array), settings = decodeNativeLayoutSettings(record.fields.settings as Uint8Array),
    style = decodeNativeLayoutStyle(record.fields.defaultStyle as Uint8Array);
  const value: NativeLayoutMetadata = { meta: { guid: m.fields.guid as string, nextId: m.fields.nextId as number, formatVersion: LAYOUT_FORMAT_VERSION },
    settings: settings.value, defaultStyle: style.value, activeLayerId: record.fields.activeLayerId as number };
  validate(value);
  const records: LayoutMetadataExtensions['records'] = new Map();
  if (record.unknownFields.length) records.set('', record.unknownFields);
  if (m.unknownFields.length) records.set('meta', m.unknownFields);
  return { value, extensions: { records, settings: settings.extensions, style: style.extensions } };
}
export function encodeNativeLayoutLayer(value: LayoutLayer, unknownFields: Uint8Array[] = value.nativeUnknownFields?.unknownFields ?? []): Uint8Array {
  const { nativeUnknownFields: _extra, ...fields } = value;
  id(value.id); return layer.encode({ fields, unknownFields });
}
export function decodeNativeLayoutLayer(bytes: Uint8Array): { value: LayoutLayer; unknownFields: Uint8Array[] } {
  const record = layer.decode(bytes), value = record.fields as unknown as LayoutLayer; id(value.id);
  return { value, unknownFields: record.unknownFields };
}
/** Call after staging the complete layer table, before installing any document. */
export function validateNativeLayoutLayers(value: NativeLayoutMetadata, layers: ReadonlyMap<number, LayoutLayer>, order: readonly number[]): void {
  validate(value);
  if (!layers.has(value.activeLayerId) || order.length !== layers.size) fail();
  const seen = new Set<number>();
  for (const key of order) {
    const record = layers.get(key);
    if (!record || record.id !== key || seen.has(key) || key >= value.meta.nextId) fail();
    id(key); seen.add(key);
  }
}
