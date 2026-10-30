// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Material, Tag, TagFolder, Style, Scene } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { NativeChunkError } from './chunks';
import type { NativeChunk, NativeChunkOptions } from './chunks';
import { encodeNativeRecordChunks, decodeNativeRecordChunks } from './recordStream';
import { encodeNativeMaterial, decodeNativeMaterial } from './material';
import type { MaterialExtensions } from './material';
import { encodeNativeTag, decodeNativeTag, encodeNativeTagFolder, decodeNativeTagFolder } from './tags';
import type { TagExtensions } from './tags';
import { encodeNativeStyle, decodeNativeStyle } from './style';
import type { StyleExtensions } from './style';
import { encodeNativeScene, decodeNativeScene } from './scene';
import type { SceneExtensions } from './scene';
import { encodeNativeImageAsset, decodeNativeImageAsset } from './imageAsset';
import type { NativeImageRecord } from './imageAsset';
interface WireExtras { required?: boolean; envelopeUnknown?: Uint8Array[] }
type Entry<K, V, E> = WireExtras & { kind: K; value: V; extensions?: E };
export type NativeCatalogEntry =
  | Entry<'material', Material, MaterialExtensions> | Entry<'tag', Tag, TagExtensions> | Entry<'tagFolder', TagFolder, TagExtensions>
  | Entry<'style', Style, StyleExtensions> | Entry<'scene', Scene, SceneExtensions>
  | (WireExtras & { kind: 'image'; value: NativeImageRecord })
  | { kind: 'unknown'; wireKind: number; schemaMajor: number; required: false; payload: Uint8Array; envelopeUnknown?: Uint8Array[] };
const codec = new NativeRecordCodec({ kind: { id: 1, kind: 'uint32', required: true }, schemaMajor: { id: 2, kind: 'uint32', required: true },
  required: { id: 3, kind: 'bool', required: true }, payload: { id: 4, kind: 'bytes', required: true } });
const kinds = { material: 1, tag: 2, tagFolder: 3, style: 4, scene: 5, image: 6 } as const;
export function encodeNativeCatalogEntry(entry: NativeCatalogEntry): Uint8Array {
  let payload: Uint8Array;
  switch (entry.kind) {
    case 'material': payload = encodeNativeMaterial(entry.value, entry.extensions); break;
    case 'tag': payload = encodeNativeTag(entry.value, entry.extensions); break;
    case 'tagFolder': payload = encodeNativeTagFolder(entry.value, entry.extensions); break;
    case 'style': payload = encodeNativeStyle(entry.value, entry.extensions); break;
    case 'scene': payload = encodeNativeScene(entry.value, entry.extensions); break;
    case 'image': payload = encodeNativeImageAsset(entry.value); break;
    case 'unknown': payload = entry.payload; break;
  }
  const kind = entry.kind === 'unknown' ? entry.wireKind : kinds[entry.kind], schemaMajor = entry.kind === 'unknown' ? entry.schemaMajor : 1;
  if (kind < 1 || schemaMajor < 1 || (entry.kind === 'unknown' && kind <= 6 && schemaMajor === 1)) throw new NativeChunkError('Invalid native catalog kind/schema');
  return codec.encode({ fields: { kind, schemaMajor, required: entry.required ?? true, payload }, unknownFields: entry.envelopeUnknown ?? [] });
}
export function decodeNativeCatalogEntry(bytes: Uint8Array): NativeCatalogEntry {
  const decoded = codec.decode(bytes), kind = decoded.fields.kind as number, schemaMajor = decoded.fields.schemaMajor as number;
  const required = decoded.fields.required as boolean, payload = decoded.fields.payload as Uint8Array, envelopeUnknown = decoded.unknownFields;
  if (!kind || !schemaMajor) throw new NativeChunkError('Invalid native catalog kind/schema');
  const extras = { required, envelopeUnknown };
  if (schemaMajor === 1) switch (kind) {
    case 1: return { kind: 'material', ...decodeNativeMaterial(payload), ...extras };
    case 2: return { kind: 'tag', ...decodeNativeTag(payload), ...extras };
    case 3: return { kind: 'tagFolder', ...decodeNativeTagFolder(payload), ...extras };
    case 4: return { kind: 'style', ...decodeNativeStyle(payload), ...extras };
    case 5: return { kind: 'scene', ...decodeNativeScene(payload), ...extras };
    case 6: return { kind: 'image', value: decodeNativeImageAsset(payload), ...extras };
  }
  if (required) throw new NativeChunkError(`Unsupported required native catalog record: ${kind}/${schemaMajor}`);
  return { kind: 'unknown', wireKind: kind, schemaMajor, required: false, payload, envelopeUnknown };
}
/** Catalog input can be a lazy traversal of the current immutable document revision. */
export function encodeNativeCatalogChunks(entries: Iterable<NativeCatalogEntry> | AsyncIterable<NativeCatalogEntry>, options: NativeChunkOptions = {}): AsyncGenerator<NativeChunk> {
  async function* records(): AsyncGenerator<Uint8Array> { for await (const entry of entries) yield encodeNativeCatalogEntry(entry); }
  return encodeNativeRecordChunks(records(), options);
}
export async function* decodeNativeCatalogChunks(chunks: Iterable<NativeChunk> | AsyncIterable<NativeChunk>, signal?: AbortSignal): AsyncGenerator<NativeCatalogEntry> {
  for await (const record of decodeNativeRecordChunks(chunks, signal)) yield decodeNativeCatalogEntry(record);
}
