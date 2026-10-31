// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId } from '@pushform/core';
import type { CommonAttrs, DocumentState, ImageBlob } from '@pushform/model';
import { NativeChunkError, encodeNativeChunks, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer } from './container';
import type { NativeFileSink, NativeStoredChunk } from './container';
import { encodeNativeDocumentRoot, NATIVE_ROOT_ID, NATIVE_CAPABILITY_MESH_PARTS } from './documentRoot';
import { encodeNativeModelSettings, validateNativeModelCatalogs } from './modelSettings';
import { encodeNativeModelRecord, encodeNativePropertyModelRecord } from './modelRecord';
import type { NativeModelRecord } from './modelRecord';
import { encodeNativeRecordChunks } from './recordStream';
import { NativeCommonPropertyWriter } from './commonProperty';
import { streamNativeImageAsset } from './imageAsset';
import { streamNativeDefinitionOrder } from './definitionOrder';
import { streamNativeSketch } from './sketch';
import { streamNativeBody } from './body';
import { streamNativeMeshPart } from './meshPart';
import { packNativeNumericPages } from './numericPages';

/** The captured revision and asset bytes must remain immutable until writing finishes. */
export interface NativeModelWriteOptions extends NativeChunkOptions {
  imageBlob?: (id: ImageId) => ImageBlob | undefined | Promise<ImageBlob | undefined>;
}
/** Write known Modeling state with bounded metadata batches; never retain a whole serialized document. */
export async function writeNativeModel(state: DocumentState, sink: NativeFileSink, options: NativeModelWriteOptions = {}) {
  options.signal?.throwIfAborted(); validateNativeModelCatalogs(state, state);
  let next = 1;
  const nextId = (): number => { if (next >= NATIVE_ROOT_ID) throw new NativeChunkError('Native chunk ID space exhausted'); return next++; };
  const pool = new NativeCommonPropertyWriter(), recordChunks: number[] = [];
  // A document with mesh parts needs a reader that knows them; older readers refuse it with a clear message.
  const capabilities = [...state.definitions.values()].some(d => d.entities.meshParts.size) ? [NATIVE_CAPABILITY_MESH_PARTS] : [];
  const propertyId = (value: CommonAttrs): number => pool.intern(value).id;
  let pending: Uint8Array[] = [], pendingBytes = 0, recordCount = 0;
  async function* flush(): AsyncGenerator<NativeStoredChunk> {
    for await (const chunk of encodeNativeRecordChunks(pending, options)) {
      const id = nextId(); recordChunks.push(id); yield { descriptor: describeNativeChunk(id, 3, 1, true, chunk), data: chunk.data };
    }
    pending = []; pendingBytes = 0;
  }
  async function* enqueue(bytes: Uint8Array): AsyncGenerator<NativeStoredChunk> {
    options.signal?.throwIfAborted();
    if (++recordCount > 1_000_000) throw new NativeChunkError('Too many native model records');
    if (pendingBytes + bytes.length > NATIVE_CHUNK_BYTES) yield* flush();
    pending.push(bytes); pendingBytes += bytes.length;
    if (pendingBytes >= NATIVE_CHUNK_BYTES) yield* flush();
  }
  async function* record(value: NativeModelRecord): AsyncGenerator<NativeStoredChunk> { yield* enqueue(encodeNativeModelRecord(value)); }
  async function* single(bytes: Uint8Array, id: number, kind: number): AsyncGenerator<NativeStoredChunk> {
    if (bytes.length > NATIVE_MAX_CHUNK_BYTES) throw new NativeChunkError('Native document header exceeds single-chunk limit');
    for await (const chunk of encodeNativeChunks([bytes], { ...options, pageBytes: NATIVE_MAX_CHUNK_BYTES })) yield { descriptor: describeNativeChunk(id, kind, 1, true, chunk), data: chunk.data };
  }
  async function* chunks(): AsyncGenerator<NativeStoredChunk> {
    const metadataChunk = nextId(); yield* single(encodeNativeModelSettings(state, state.nativeSettingsUnknownFields), metadataChunk, 3);
    for (const value of state.materials.values()) yield* record({ kind: 'material', value, ...state.nativeMaterialUnknownFields?.get(value.id) });
    for (const value of state.tags.values()) yield* record({ kind: 'tag', value, ...state.nativeTagUnknownFields?.tags.get(value.id) });
    for (const value of state.tagFolders.values()) yield* record({ kind: 'tagFolder', value, ...state.nativeTagUnknownFields?.folders.get(value.id) });
    for (const value of state.styles.values()) yield* record({ kind: 'style', value, ...state.nativeStyleUnknownFields?.get(value.id) });
    for (const value of state.scenes.values()) yield* record({ kind: 'scene', value, ...state.nativeSceneUnknownFields?.get(value.id) });
    for (const asset of state.images.values()) {
      const blob = await options.imageBlob?.(asset.id);
      const value = yield* streamNativeImageAsset(asset, blob, nextId, options.signal);
      const { unknownFields, ...envelope } = state.nativeImageUnknownFields?.get(asset.id) ?? { unknownFields: [] };
      value.unknownFields = unknownFields;
      yield* record({ kind: 'image', ...envelope, value });
    }
    for (const [ownerDefinitionId, definition] of state.definitions) {
      options.signal?.throwIfAborted(); if (definition.id !== ownerDefinitionId) throw new NativeChunkError('Mismatched native definition ID');
      const { entities, bounds: _bounds, nativeUnknownFields, ...metadata } = definition;
      const entityOrder = yield* streamNativeDefinitionOrder(entities.order, nextId, options);
      yield* record({ kind: 'definition', ...nativeUnknownFields, value: { metadata, entityOrder, activeSectionPlaneId: entities.activeSectionPlaneId } });
      const sketch = yield* streamNativeSketch(entities.sketch, propertyId, nextId, options, entities.sketch.nativeUnknownFields?.extensions);
      yield* record({ kind: 'sketch', ownerDefinitionId, ...entities.sketch.nativeUnknownFields, value: sketch });
      for (const [id, body] of entities.bodies) {
        if (id !== body.id) throw new NativeChunkError('Mismatched native body ID');
        const value = yield* streamNativeBody(body, propertyId, nextId, options, body.nativeUnknownFields?.extensions); yield* record({ kind: 'body', ownerDefinitionId, ...body.nativeUnknownFields, value });
      }
      for (const [id, part] of entities.meshParts) {
        if (id !== part.id) throw new NativeChunkError('Mismatched native mesh part ID');
        const value = yield* streamNativeMeshPart(part, propertyId, nextId, options); yield* record({ kind: 'meshPart', ownerDefinitionId, ...part.nativeUnknownFields, value });
      }
      for (const [id, instance] of entities.instances) {
        if (id !== instance.id) throw new NativeChunkError('Mismatched native instance ID');
        yield* record({ kind: 'instance', ownerDefinitionId, ...instance.nativeUnknownFields, value: { value: instance, properties: propertyId(instance) } });
      }
      for (const [id, value] of entities.guides) { if (id !== value.id) throw new NativeChunkError('Mismatched guide ID'); yield* record({ kind: 'guide', ownerDefinitionId, ...value.nativeUnknownFields, value: { value, properties: propertyId(value), unknownFields: value.nativeUnknownFields?.unknownFields ?? [] } }); }
      for (const [id, value] of entities.images) { if (id !== value.id) throw new NativeChunkError('Mismatched image placement ID'); yield* record({ kind: 'imagePlacement', ownerDefinitionId, ...value.nativeUnknownFields, value: { value, properties: propertyId(value), unknownFields: value.nativeUnknownFields?.unknownFields ?? [] } }); }
      for (const [id, value] of entities.sectionPlanes) { if (id !== value.id) throw new NativeChunkError('Mismatched section plane ID'); yield* record({ kind: 'sectionPlane', ownerDefinitionId, ...value.nativeUnknownFields, value: { value, properties: propertyId(value), unknownFields: value.nativeUnknownFields?.unknownFields ?? [] } }); }
      for (const [id, value] of entities.texts) { if (id !== value.id) throw new NativeChunkError('Mismatched text ID'); yield* record({ kind: 'text', ownerDefinitionId, ...value.nativeUnknownFields, value: { value, properties: propertyId(value), unknownFields: value.nativeUnknownFields?.unknownFields ?? [] } }); }
      for (const [id, value] of entities.dimensions) { if (id !== value.id) throw new NativeChunkError('Mismatched dimension ID'); yield* record({ kind: 'dimension', ownerDefinitionId, ...value.nativeUnknownFields, value: { value, properties: propertyId(value) } }); }
    }
    for (let id = 1; id <= pool.size; id++) yield* enqueue(encodeNativePropertyModelRecord(pool.encodeRecord(id), pool.envelope(id)));
    yield* flush();
    yield* single(encodeNativeDocumentRoot({ schemaMajor: 1, documentKind: 1, metadataChunk, recordChunks, requiredCapabilities: capabilities, unknownFields: state.nativeRootUnknownFields ?? [] }), NATIVE_ROOT_ID, 1);
  }
  return writeNativeContainer({ kind: 1, root: NATIVE_ROOT_ID }, packNativeNumericPages(chunks(), options), sink, options.signal);
}
