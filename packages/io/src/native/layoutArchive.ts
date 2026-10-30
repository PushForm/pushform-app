// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutModelArchive } from '@pushform/layout';
import { NativeChunkError, NATIVE_MAX_CHUNKS, NATIVE_MAX_DECODED_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { nativeLayoutAssetFields } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
import { NativeRecordCodec } from './record';
import type { NativeScalar } from './record';
import { encodeNativeIds, decodeNativeIds } from './idList';
import { streamNativeNumbers } from './numericStream';
type Model = LayoutModelArchive['models'] extends Map<string, infer V> ? V : never;
type Viewport = LayoutModelArchive['viewports'] extends Map<string, infer V> ? V : never;
export interface NativeLayoutArchiveHeader {
  envelopeUnknown?: Uint8Array[];
  id: string; assetId: number; modelCount: number; viewportCount: number;
  annotationConnectionsVersion?: 1 | undefined;
  unknownFields: Uint8Array[];
}
export interface NativeLayoutArchiveModel { id: string; value: Model; unknownFields: Uint8Array[]; envelopeUnknown?: Uint8Array[] }
export interface NativeLayoutArchiveViewport { id: string; modelReferenceId: string | null; entityCount: number; entityChunks: number[]; unknownFields: Uint8Array[] }
export interface NativePackedLayoutArchiveViewport { reference: NativeLayoutArchiveViewport; entityIds: Uint32Array; envelopeUnknown?: Uint8Array[] }
const header = new NativeRecordCodec({ id: { id: 1, kind: 'string', required: true }, assetId: { id: 2, kind: 'uint32', required: true }, format: { id: 3, kind: 'uint32', required: true },
  modelCount: { id: 4, kind: 'uint32', required: true }, viewportCount: { id: 5, kind: 'uint32', required: true }, annotationConnectionsVersion: { id: 6, kind: 'uint32', required: false } });
const model = new NativeRecordCodec({ id: { id: 1, kind: 'string', required: true }, internalTarget: { id: 2, kind: 'string', required: false }, externalTarget: { id: 3, kind: 'string', required: false } });
const viewport = new NativeRecordCodec({ id: { id: 1, kind: 'string', required: true }, modelReferenceId: { id: 2, kind: 'string', required: false }, entityCount: { id: 3, kind: 'uint32', required: true }, entityChunks: { id: 4, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout archive'); };
function validateHeader(r: NativeLayoutArchiveHeader): void {
  if (!r.id || !Number.isInteger(r.assetId) || r.assetId < 1 || r.assetId > 0xffffffff ||
    !Number.isInteger(r.modelCount) || r.modelCount < 0 || r.modelCount > 0xffffffff ||
    !Number.isInteger(r.viewportCount) || r.viewportCount < 0 || r.viewportCount > 0xffffffff ||
    r.annotationConnectionsVersion !== undefined && r.annotationConnectionsVersion !== 1) fail();
}
export function encodeNativeLayoutArchiveHeader(r: NativeLayoutArchiveHeader): Uint8Array {
  validateHeader(r); const fields: Record<string, NativeScalar> = { id: r.id, assetId: r.assetId, format: 0, modelCount: r.modelCount, viewportCount: r.viewportCount };
  if (Object.hasOwn(r, 'annotationConnectionsVersion')) fields.annotationConnectionsVersion = r.annotationConnectionsVersion ?? 0;
  return header.encode({ fields, unknownFields: r.unknownFields });
}
export function decodeNativeLayoutArchiveHeader(bytes: Uint8Array): NativeLayoutArchiveHeader {
  const { fields: f, unknownFields } = header.decode(bytes); if (f.format !== 0) return fail();
  const r: NativeLayoutArchiveHeader = { id: f.id as string, assetId: f.assetId as number, modelCount: f.modelCount as number, viewportCount: f.viewportCount as number, unknownFields };
  if (Object.hasOwn(f, 'annotationConnectionsVersion')) {
    if (f.annotationConnectionsVersion !== 0 && f.annotationConnectionsVersion !== 1) return fail();
    r.annotationConnectionsVersion = f.annotationConnectionsVersion === 0 ? undefined : 1;
  }
  validateHeader(r); return r;
}
export function encodeNativeLayoutArchiveModel(r: NativeLayoutArchiveModel): Uint8Array {
  const fields: Record<string, NativeScalar> = { id: r.id };
  for (const key of ['internalTarget', 'externalTarget'] as const) if (r.value[key] !== null) fields[key] = r.value[key];
  return model.encode({ fields, unknownFields: r.unknownFields });
}
export function decodeNativeLayoutArchiveModel(bytes: Uint8Array): NativeLayoutArchiveModel {
  const { fields: f, unknownFields } = model.decode(bytes);
  return { id: f.id as string, value: { internalTarget: f.internalTarget as string | undefined ?? null, externalTarget: f.externalTarget as string | undefined ?? null }, unknownFields };
}
function validateViewport(r: NativeLayoutArchiveViewport): void {
  if (!Number.isInteger(r.entityCount) || r.entityCount < 0 || r.entityCount * 4 > NATIVE_MAX_DECODED_BYTES ||
    !!r.entityCount !== !!r.entityChunks.length || r.entityChunks.length > NATIVE_MAX_CHUNKS || new Set(r.entityChunks).size !== r.entityChunks.length) fail();
  for (const id of r.entityChunks) if (!Number.isInteger(id) || id < 1 || id >= 0xffffffff) fail();
}
export function encodeNativeLayoutArchiveViewport(r: NativeLayoutArchiveViewport): Uint8Array {
  validateViewport(r); return viewport.encode({ fields: { id: r.id, entityCount: r.entityCount,
    ...(r.modelReferenceId === null ? {} : { modelReferenceId: r.modelReferenceId }), ...(r.entityChunks.length ? { entityChunks: encodeNativeIds(r.entityChunks) } : {}) }, unknownFields: r.unknownFields });
}
export function decodeNativeLayoutArchiveViewport(bytes: Uint8Array): NativeLayoutArchiveViewport {
  const { fields: f, unknownFields } = viewport.decode(bytes), r = { id: f.id as string, modelReferenceId: f.modelReferenceId as string | undefined ?? null,
    entityCount: f.entityCount as number, entityChunks: decodeNativeIds(f.entityChunks as Uint8Array | undefined), unknownFields }; validateViewport(r); return r;
}
export async function* streamNativeLayoutArchiveViewport(id: string, value: Viewport, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutArchiveViewport> {
  function* ids() { for (const id of value.entityIds) { if (id < 1) fail(); yield id; } }
  const r = { id, modelReferenceId: value.modelReferenceId, entityCount: value.entityIds.length,
    entityChunks: yield* streamNativeNumbers(ids(), 'uint32', value.entityIds.length, nextId, options), unknownFields: value.nativeUnknownFields?.unknownFields ?? [] }; validateViewport(r); return r;
}
export async function readNativeLayoutArchiveViewport(reference: NativeLayoutArchiveViewport, columns: NativeColumnReader, signal?: AbortSignal): Promise<NativePackedLayoutArchiveViewport> {
  validateViewport(reference); const entityIds = await columns.read('uint32', reference.entityCount, reference.entityChunks, signal);
  for (const id of entityIds) if (!id) return fail();
  // These are preserved source associations: deleted paper objects and repeated IDs remain meaningful history.
  return { reference, entityIds };
}
/** All input records are owner-scoped by the outer document stream. Keep source mappings even when paper objects were deleted. */
export function assembleNativeLayoutArchive(reference: NativeLayoutArchiveHeader, assets: ReadonlyMap<number, NativeLayoutAsset>, models: Iterable<NativeLayoutArchiveModel>, viewports: Iterable<NativePackedLayoutArchiveViewport>) {
  validateHeader(reference); const asset = assets.get(reference.assetId); if (!asset || !asset.bytes.length || asset.reference.prefix !== '') return fail();
  const modelMap = new Map<string, NativeLayoutArchiveModel>(), viewportMap = new Map<string, NativePackedLayoutArchiveViewport>();
  for (const m of models) { if (modelMap.has(m.id) || modelMap.size >= reference.modelCount) return fail(); modelMap.set(m.id, m); }
  for (const v of viewports) { if (viewportMap.has(v.reference.id) || viewportMap.size >= reference.viewportCount) return fail(); viewportMap.set(v.reference.id, v); }
  if (modelMap.size !== reference.modelCount || viewportMap.size !== reference.viewportCount) return fail();
  return { reference, asset, models: modelMap, viewports: viewportMap };
}
export function materializeNativeLayoutArchive(packed: ReturnType<typeof assembleNativeLayoutArchive>, assetStrings: ReadonlyMap<number, string>): LayoutModelArchive {
  const archiveBase64 = assetStrings.get(packed.reference.assetId); if (archiveBase64 === undefined) return fail();
  const value: LayoutModelArchive = { format: 'sketchup-layout', archiveBase64, ...nativeLayoutAssetFields(packed.asset), ...ownedFields(packed.reference),
    models: new Map(Array.from(packed.models, ([id, m]) => [id, { ...m.value, ...ownedFields(m) }])),
    viewports: new Map(Array.from(packed.viewports, ([id, v]) => [id, { modelReferenceId: v.reference.modelReferenceId, entityIds: Array.from(v.entityIds),
      ...ownedFields({ unknownFields: v.reference.unknownFields, ...(v.envelopeUnknown ? { envelopeUnknown: v.envelopeUnknown } : {}) }) }])) };
  if (Object.hasOwn(packed.reference, 'annotationConnectionsVersion')) Object.defineProperty(value, 'annotationConnectionsVersion', { value: packed.reference.annotationConnectionsVersion, enumerable: true, writable: true, configurable: true });
  return value;
}

function ownedFields(value: { unknownFields: Uint8Array[]; envelopeUnknown?: Uint8Array[] }) {
  return value.unknownFields.length || value.envelopeUnknown?.length ? { nativeUnknownFields: {
    ...(value.unknownFields.length ? { unknownFields: value.unknownFields } : {}),
    ...(value.envelopeUnknown?.length ? { envelopeUnknown: value.envelopeUnknown } : {}),
  } } : {};
}
