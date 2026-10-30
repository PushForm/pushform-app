// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutImage, LayoutViewport } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import type { NativeChunkOptions } from './chunks';
import type { NativeStoredChunk } from './container';
import type { NativeColumnReader } from './columns';
import { NativeRecordCodec } from './record';
import type { NativeScalar } from './record';
import { encodeNativeLayoutGeometry, decodeNativeLayoutGeometry, streamNativeLayoutGeometry, readNativeLayoutGeometry, materializeNativeLayoutGeometry } from './layoutGeometry';
import type { NativeLayoutGeometryReference, NativePackedLayoutGeometry } from './layoutGeometry';
import { encodeNativeLayoutViewport, decodeNativeLayoutViewport, attachNativeLayoutViewportFields } from './layoutViewport';
import type { LayoutViewportExtensions } from './layoutViewport';
import { nativeLayoutAssetFields } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
export interface NativeLayoutImageReference {
  assetId: number;
  clip?: NativeLayoutGeometryReference | undefined;
  viewport?: LayoutViewport | undefined;
  extensions: Map<string, Uint8Array[]>;
  viewportExtensions: LayoutViewportExtensions;
}
export interface NativePackedLayoutImage { envelope?: Uint8Array[]; outerEnvelope?: Uint8Array[]; reference: NativeLayoutImageReference; asset: NativeLayoutAsset; clip?: NativePackedLayoutGeometry }
const record = new NativeRecordCodec({ assetId: { id: 1, kind: 'uint32', required: true }, clip: { id: 2, kind: 'bytes', required: false }, viewport: { id: 3, kind: 'bytes', required: false } });
const optional = new NativeRecordCodec({ state: { id: 1, kind: 'uint32', required: true }, value: { id: 2, kind: 'bytes', required: false } });
const fail = (): never => { throw new NativeChunkError('Invalid native Layout image'); };
function validate(r: NativeLayoutImageReference): void {
  if (!Number.isInteger(r.assetId) || r.assetId < 1 || r.assetId > 0xffffffff) fail();
  // Crop outlines have no compound contours. Frame geometry belongs to the owning entity.
  if (r.clip && (r.clip.closed || r.clip.columns.contourStarts || r.clip.columns.openContours)) fail();
}
export function encodeNativeLayoutImage(r: NativeLayoutImageReference): Uint8Array {
  validate(r); const fields: Record<string, NativeScalar> = { assetId: r.assetId };
  for (const key of ['clip', 'viewport'] as const) if (Object.hasOwn(r, key)) {
    const value = key === 'clip' ? r.clip === undefined ? undefined : encodeNativeLayoutGeometry(r.clip) :
      r.viewport === undefined ? undefined : encodeNativeLayoutViewport(r.viewport, r.viewport.nativeUnknownFields ? { ...r.viewportExtensions, records: r.viewport.nativeUnknownFields } : r.viewportExtensions);
    fields[key] = optional.encode({ fields: value === undefined ? { state: 0 } : { state: 1, value }, unknownFields: r.extensions.get(key) ?? [] });
  }
  return record.encode({ fields, unknownFields: r.extensions.get('') ?? [] });
}
export function decodeNativeLayoutImage(bytes: Uint8Array): NativeLayoutImageReference {
  const decoded = record.decode(bytes), r: NativeLayoutImageReference = { assetId: decoded.fields.assetId as number, extensions: new Map(), viewportExtensions: { records: new Map(), shadows: new Map() } };
  if (decoded.unknownFields.length) r.extensions.set('', decoded.unknownFields);
  for (const key of ['clip', 'viewport'] as const) if (Object.hasOwn(decoded.fields, key)) {
    const opt = optional.decode(decoded.fields[key] as Uint8Array), has = Object.hasOwn(opt.fields, 'value');
    if (opt.unknownFields.length) r.extensions.set(key, opt.unknownFields);
    if (opt.fields.state === 0 && !has) r[key] = undefined;
    else if (opt.fields.state === 1 && has) {
      if (key === 'clip') r.clip = decodeNativeLayoutGeometry(opt.fields.value as Uint8Array);
      else { const v = decodeNativeLayoutViewport(opt.fields.value as Uint8Array); r.viewport = v.value; r.viewportExtensions = v.extensions; }
    } else return fail();
  }
  validate(r); return r;
}
/** The document writer assigns a shared asset ID to src before streaming this image's crop geometry. */
export async function* streamNativeLayoutImage(value: LayoutImage, assetId: number, nextId: () => number, options: NativeChunkOptions = {}): AsyncGenerator<NativeStoredChunk, NativeLayoutImageReference> {
  const r: NativeLayoutImageReference = { assetId, extensions: value.nativeUnknownFields?.extensions ?? new Map(), viewportExtensions: { records: new Map(), shadows: new Map() } }; validate(r);
  options.signal?.throwIfAborted();
  if (Object.hasOwn(value, 'clip')) r.clip = value.clip === undefined ? undefined : yield* streamNativeLayoutGeometry({ ...value.clip, closed: false }, nextId, options);
  if (r.clip && value.clip?.nativeUnknownFields) r.clip.extensions = value.clip.nativeUnknownFields;
  if (Object.hasOwn(value, 'viewport')) r.viewport = value.viewport;
  return r;
}
/** Asset references borrow the staged binary store; repeated image placements do not decode/copy payloads. */
export async function readNativeLayoutImage(reference: NativeLayoutImageReference, assets: ReadonlyMap<number, NativeLayoutAsset>, columns: NativeColumnReader, signal?: AbortSignal): Promise<NativePackedLayoutImage> {
  validate(reference); signal?.throwIfAborted(); const asset = assets.get(reference.assetId); if (!asset) return fail();
  const result: NativePackedLayoutImage = { reference, asset };
  if (reference.clip) result.clip = await readNativeLayoutGeometry(reference.clip, columns, signal);
  return result;
}
/** The existing editor's asset-string table is materialized once per document, not once per placement. */
export function materializeNativeLayoutImage(packed: NativePackedLayoutImage, sourceStrings: ReadonlyMap<number, string>): LayoutImage {
  const src = sourceStrings.get(packed.reference.assetId); if (src === undefined) return fail();
  const value: LayoutImage = { src, ...nativeLayoutAssetFields(packed.asset) }, extensions = packed.reference.extensions;
  if (extensions.size || packed.envelope?.length || packed.outerEnvelope?.length) value.nativeUnknownFields = {
    ...(extensions.size ? { extensions } : {}), ...(packed.envelope?.length ? { envelope: packed.envelope } : {}), ...(packed.outerEnvelope?.length ? { outerEnvelope: packed.outerEnvelope } : {}),
  };
  if (Object.hasOwn(packed.reference, 'clip')) {
    if (packed.clip) {
      const geometry = materializeNativeLayoutGeometry(packed.clip); value.clip = { points: geometry.points };
      if (packed.clip.reference.extensions.size) value.clip.nativeUnknownFields = packed.clip.reference.extensions;
      if (Object.hasOwn(geometry, 'handles')) Object.defineProperty(value.clip, 'handles', { value: geometry.handles, enumerable: true, writable: true, configurable: true });
    } else value.clip = undefined;
  }
  if (Object.hasOwn(packed.reference, 'viewport')) {
    value.viewport = packed.reference.viewport;
    if (value.viewport) attachNativeLayoutViewportFields(value.viewport, packed.reference.viewportExtensions);
  }
  return value;
}
