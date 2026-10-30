// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeRecordCodec } from './record';
import type { NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const kinds = ['layer', 'reference', 'page', 'entity', 'archive', 'archiveModel', 'archiveViewport', 'asset', 'customField', 'numbering'] as const;
export interface NativeLayoutRecord {
  kind: typeof kinds[number]; payload: Uint8Array; pageId?: number; archiveId?: string; assetId?: number; unknownFields: Uint8Array[];
}
const codec = new NativeRecordCodec({ kind: { id: 1, kind: 'uint32', required: true }, payload: { id: 2, kind: 'bytes', required: true },
  pageId: { id: 3, kind: 'uint32', required: false }, archiveId: { id: 4, kind: 'string', required: false }, assetId: { id: 5, kind: 'uint32', required: false } });
function validate(r: NativeLayoutRecord): void {
  const archiveOwned = r.kind === 'archiveModel' || r.kind === 'archiveViewport';
  if (!kinds.includes(r.kind) || (r.kind === 'entity') !== Object.hasOwn(r, 'pageId') || archiveOwned !== Object.hasOwn(r, 'archiveId') ||
    (r.kind === 'asset') !== Object.hasOwn(r, 'assetId') || archiveOwned && !r.archiveId ||
    r.kind === 'entity' && (!Number.isInteger(r.pageId) || r.pageId! < 0 || r.pageId! > 0xffffffff) ||
    r.kind === 'asset' && (!Number.isInteger(r.assetId) || r.assetId! < 1 || r.assetId! > 0xffffffff)) throw new NativeChunkError('Invalid native Layout record context');
}
export function encodeNativeLayoutRecord(value: NativeLayoutRecord): Uint8Array {
  validate(value); const fields: Record<string, NativeScalar> = { kind: kinds.indexOf(value.kind), payload: value.payload };
  for (const key of ['pageId', 'archiveId', 'assetId'] as const) if (Object.hasOwn(value, key)) fields[key] = value[key]!;
  return codec.encode({ fields, unknownFields: value.unknownFields });
}
export function decodeNativeLayoutRecord(bytes: Uint8Array): NativeLayoutRecord {
  const r = codec.decode(bytes), kind = kinds[r.fields.kind as number]; if (!kind) throw new NativeChunkError('Unsupported native Layout record kind');
  const value: NativeLayoutRecord = { kind, payload: r.fields.payload as Uint8Array, unknownFields: r.unknownFields };
  if (Object.hasOwn(r.fields, 'pageId')) value.pageId = r.fields.pageId as number;
  if (Object.hasOwn(r.fields, 'archiveId')) value.archiveId = r.fields.archiveId as string;
  if (Object.hasOwn(r.fields, 'assetId')) value.assetId = r.fields.assetId as number;
  validate(value); return value;
}
