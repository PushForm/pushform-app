// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import type { NativeLayoutAsset } from './layoutAsset';
import { encodeNativeLayoutAnnotationFields, decodeNativeLayoutAnnotationFields } from './layoutModelAnnotation';
type Connections = NonNullable<LayoutEntity['preservedModelConnections']>;
export type NativeLayoutConnections = Omit<Connections, 'snapshot' | 'nativeAssetFields'> & { snapshotAssetId: number };
export type LayoutConnectionsExtensions = Map<string, Uint8Array[]>;
/** Preserve source associations independently of their position in the wire list. */
export function attachNativeLayoutConnectionFields(value: NativeLayoutConnections, extensions: LayoutConnectionsExtensions, envelope: Uint8Array[], outer: Uint8Array[] = []): void {
  const ext = new Map(extensions);
  for (const [i, viewport] of value.viewports.entries()) {
    const key = `viewports/${i}`, fields = ext.get(key);
    if (fields) { viewport.nativeUnknownFields = fields; ext.delete(key); }
  }
  if (ext.size || envelope.length || outer.length) value.nativeUnknownFields = {
    ...(ext.size ? { extensions: ext } : {}), ...(envelope.length ? { envelope } : {}), ...(outer.length ? { outerEnvelope: outer } : {}),
  };
}
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const connections = new NativeRecordCodec({ archiveId: f(1, 'string'), originalId: f(2, 'string'), snapshotAssetId: f(3, 'uint32'),
  viewports: { ...f(4, 'bytes', false), repeated: true }, fields: f(5, 'bytes', false) } satisfies Record<Exclude<keyof NativeLayoutConnections, 'nativeUnknownFields'>, NativeField>);
const viewport = new NativeRecordCodec({ originalId: f(1, 'string'), entityId: f(2, 'uint32') } satisfies Record<Exclude<keyof Connections['viewports'][number], 'nativeUnknownFields'>, NativeField>);
const fail = (): never => { throw new NativeChunkError('Invalid native Layout preserved connections'); };
function id(n: number): void { if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) fail(); }
function validate(value: NativeLayoutConnections): void {
  id(value.snapshotAssetId);
  if (!value.archiveId || !value.originalId || !Array.isArray(value.viewports) || !value.viewports.length || value.viewports.length > 65536) fail();
  for (const v of value.viewports) { if (!v.originalId) fail(); id(v.entityId); }
}
/** The writer registers the unchanged opaque snapshot as a text asset in the document catalog. */
export function referenceNativeLayoutConnections(value: Connections, snapshotAssetId: number): NativeLayoutConnections {
  const { snapshot: _snapshot, nativeAssetFields: _assetFields, ...metadata } = value; const r = { ...metadata, snapshotAssetId }; validate(r); return r;
}
export function encodeNativeLayoutConnections(value: NativeLayoutConnections, ext: LayoutConnectionsExtensions = value.nativeUnknownFields?.extensions ?? new Map()): Uint8Array {
  validate(value); let size = 0;
  const entries = value.viewports.map((v, i) => {
    const bytes = viewport.encode({ fields: { originalId: v.originalId, entityId: v.entityId }, unknownFields: v.nativeUnknownFields ?? ext.get(`viewports/${i}`) ?? [] });
    size += bytes.length; if (size > 1024 * 1024) return fail(); return bytes;
  });
  const fields: Record<string, NativeScalar> = { archiveId: value.archiveId, originalId: value.originalId, snapshotAssetId: value.snapshotAssetId, viewports: entries };
  if (Object.hasOwn(value, 'fields')) fields.fields = encodeNativeLayoutAnnotationFields(value.fields, ext);
  return connections.encode({ fields, unknownFields: ext.get('') ?? [] });
}
export function decodeNativeLayoutConnections(bytes: Uint8Array): { value: NativeLayoutConnections; extensions: LayoutConnectionsExtensions } {
  const r = connections.decode(bytes), ext: LayoutConnectionsExtensions = new Map(); if (r.unknownFields.length) ext.set('', r.unknownFields);
  const value: NativeLayoutConnections = { archiveId: r.fields.archiveId as string, originalId: r.fields.originalId as string, snapshotAssetId: r.fields.snapshotAssetId as number,
    viewports: ((r.fields.viewports ?? []) as Uint8Array[]).map((bytes, i) => {
      const v = viewport.decode(bytes); if (v.unknownFields.length) ext.set(`viewports/${i}`, v.unknownFields);
      return { originalId: v.fields.originalId as string, entityId: v.fields.entityId as number };
    }) };
  if (Object.hasOwn(r.fields, 'fields')) Object.defineProperty(value, 'fields', { value: decodeNativeLayoutAnnotationFields(r.fields.fields as Uint8Array, ext), enumerable: true, writable: true, configurable: true });
  validate(value); return { value, extensions: ext };
}
/** Source associations may outlive paper entities; only the snapshot asset must resolve during staging. */
export function resolveNativeLayoutConnections(value: NativeLayoutConnections, assets: ReadonlyMap<number, NativeLayoutAsset>): NativeLayoutAsset {
  validate(value); const asset = assets.get(value.snapshotAssetId); if (!asset || !asset.bytes.length || asset.reference.encoding !== 0) return fail(); return asset;
}
export function materializeNativeLayoutConnections(value: NativeLayoutConnections, assetStrings: ReadonlyMap<number, string>): Connections {
  validate(value); const snapshot = assetStrings.get(value.snapshotAssetId); if (!snapshot) return fail();
  const { snapshotAssetId: _id, ...metadata } = value; return { ...metadata, snapshot };
}
