// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState, LayoutEntity } from '@pushform/layout';
import { assertLayoutState } from '../layoutFile';
import { NativeChunkError, encodeNativeChunks, NATIVE_CHUNK_BYTES, NATIVE_MAX_CHUNK_BYTES } from './chunks';
import type { NativeChunkOptions } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer } from './container';
import type { NativeFileSink, NativeStoredChunk } from './container';
import { encodeNativeDocumentRoot, NATIVE_ROOT_ID } from './documentRoot';
import { encodeNativeRecordChunks } from './recordStream';
import { packNativeNumericPages } from './numericPages';
import { encodeNativeLayoutRecord } from './layoutRecord';
import type { NativeLayoutRecord } from './layoutRecord';
import { encodeNativeLayoutLayer, validateNativeLayoutLayers } from './layoutMetadata';
import { encodeNativeLayoutReference } from './layoutReference';
import { streamNativeLayoutPage, encodeNativeLayoutPage } from './layoutPage';
import { NativeLayoutAssetCatalog, streamNativeLayoutEntity, encodeNativeLayoutEntityRecord } from './layoutEntityWriter';
import { streamNativeLayoutAsset, encodeNativeLayoutAssetReference } from './layoutAsset';
import { encodeNativeLayoutArchiveHeader, encodeNativeLayoutArchiveModel, streamNativeLayoutArchiveViewport, encodeNativeLayoutArchiveViewport } from './layoutArchive';
import type { NativeLayoutArchiveHeader } from './layoutArchive';
import { streamNativeLayoutDocumentHeader, encodeNativeLayoutDocumentHeader, encodeNativeLayoutCustomField, encodeNativeLayoutPageNumberField } from './layoutDocument';
// Compile-time coverage: adding document fields requires an explicit persistence owner.
const sections = { nativeFieldUnknownFields: 'records', nativeDocumentUnknownFields: 'metadata', nativeRootUnknownFields: 'root', meta: 'metadata', references: 'records', modelArchives: 'records', pages: 'records', pageOrder: 'orders', layers: 'records', layerOrder: 'orders', sharedEntities: 'records',
  sharedEntityOrder: 'orders', activeLayerId: 'metadata', settings: 'metadata', defaultStyle: 'metadata', customFields: 'records', pageNumberFields: 'records' } satisfies Record<keyof LayoutDocumentState, string>;
void sections;
/** Write one immutable Layout revision with bounded metadata batches and binary assets; publish the container footer last. */
export async function writeNativeLayout(state: LayoutDocumentState, sink: NativeFileSink, options: NativeChunkOptions = {}) {
  options.signal?.throwIfAborted(); assertLayoutState(state); validateNativeLayoutLayers(state, state.layers, state.layerOrder);
  let next = 1, count = 0, pendingBytes = 0; let pending: Uint8Array[] = [];
  const assets = new NativeLayoutAssetCatalog(), recordChunks: number[] = [];
  const nextId = () => { if (next >= NATIVE_ROOT_ID) throw new NativeChunkError('Native chunk IDs exhausted'); return next++; };
  async function* flush(): AsyncGenerator<NativeStoredChunk> {
    for await (const chunk of encodeNativeRecordChunks(pending, options)) {
      const id = nextId(); recordChunks.push(id); yield { descriptor: describeNativeChunk(id, 3, 1, true, chunk), data: chunk.data };
    }
    pending = []; pendingBytes = 0;
  }
  async function* record(value: Omit<NativeLayoutRecord, 'unknownFields'>, unknownFields: Uint8Array[] = []): AsyncGenerator<NativeStoredChunk> {
    options.signal?.throwIfAborted(); if (++count > 1_000_000) throw new NativeChunkError('Too many native Layout records');
    const bytes = encodeNativeLayoutRecord({ ...value, unknownFields });
    if (pendingBytes + bytes.length > NATIVE_CHUNK_BYTES) yield* flush(); pending.push(bytes); pendingBytes += bytes.length;
    if (pendingBytes >= NATIVE_CHUNK_BYTES) yield* flush();
  }
  async function* entities(values: ReadonlyMap<number, LayoutEntity>, pageId: number): AsyncGenerator<NativeStoredChunk> {
    for (const [id, value] of values) {
      if (id !== value.id) throw new NativeChunkError('Mismatched Layout entity ID');
      for await (const output of streamNativeLayoutEntity(value, assets, nextId, options)) {
        if (output.type === 'chunk') yield output.chunk;
        else yield* record({ kind: 'entity', pageId, payload: encodeNativeLayoutEntityRecord(output.record) }, output.record.outerUnknown ?? (output.record.kind === 'header' ? value.nativeUnknownFields?.outerHeader : output.record.kind === 'text' || output.record.kind === 'dimension' || output.record.kind === 'angularDimension' || output.record.kind === 'labelAnchor' || output.record.kind === 'modelAnnotation' || output.record.kind === 'preservedModelConnections' || output.record.kind === 'image' ? value[output.record.kind]?.nativeUnknownFields?.outerEnvelope : undefined));
      }
    }
  }
  async function* single(bytes: Uint8Array, id: number, kind: number): AsyncGenerator<NativeStoredChunk> {
    if (bytes.length > NATIVE_MAX_CHUNK_BYTES) throw new NativeChunkError('Native Layout header exceeds single-chunk limit');
    for await (const chunk of encodeNativeChunks([bytes], { ...options, pageBytes: NATIVE_MAX_CHUNK_BYTES })) yield { descriptor: describeNativeChunk(id, kind, 1, true, chunk), data: chunk.data };
  }
  async function* chunks(): AsyncGenerator<NativeStoredChunk> {
    for (const layer of state.layers.values()) yield* record({ kind: 'layer', payload: encodeNativeLayoutLayer(layer) }, layer.nativeUnknownFields?.envelopeUnknown);
    for (const [id, value] of state.references) { if (id !== value.id) throw new NativeChunkError('Mismatched Layout reference ID'); yield* record({ kind: 'reference', payload: encodeNativeLayoutReference(value) }, value.nativeUnknownFields?.envelopeUnknown); }
    for (const [id, page] of state.pages) {
      if (id !== page.id) throw new NativeChunkError('Mismatched Layout page ID');
      yield* record({ kind: 'page', payload: encodeNativeLayoutPage(yield* streamNativeLayoutPage(page, nextId, options), page.nativeUnknownFields?.extensions) }, page.nativeUnknownFields?.envelopeUnknown);
      yield* entities(page.entities, id);
    }
    yield* entities(state.sharedEntities, 0);
    for (const [id, value] of state.modelArchives ?? []) {
      const header: NativeLayoutArchiveHeader = { id, assetId: assets.register(value.archiveBase64, 'archive', value.nativeAssetFields), modelCount: value.models.size, viewportCount: value.viewports.size, unknownFields: value.nativeUnknownFields?.unknownFields ?? [] };
      if (Object.hasOwn(value, 'annotationConnectionsVersion')) header.annotationConnectionsVersion = value.annotationConnectionsVersion;
      yield* record({ kind: 'archive', payload: encodeNativeLayoutArchiveHeader(header) }, value.nativeUnknownFields?.envelopeUnknown);
      for (const [key, model] of value.models) yield* record({ kind: 'archiveModel', archiveId: id, payload: encodeNativeLayoutArchiveModel({ id: key, value: model, unknownFields: model.nativeUnknownFields?.unknownFields ?? [] }) }, model.nativeUnknownFields?.envelopeUnknown);
      for (const [key, viewport] of value.viewports) {
        const ref = yield* streamNativeLayoutArchiveViewport(key, viewport, nextId, options);
        yield* record({ kind: 'archiveViewport', archiveId: id, payload: encodeNativeLayoutArchiveViewport(ref) }, viewport.nativeUnknownFields?.envelopeUnknown);
      }
    }
    for (const [name, value] of state.customFields) {
      const fields = state.nativeFieldUnknownFields?.custom.get(name);
      yield* record({ kind: 'customField', payload: encodeNativeLayoutCustomField(name, value, fields?.unknownFields) }, fields?.envelopeUnknown);
    }
    for (const [name, value] of state.pageNumberFields ?? []) {
      const fields = state.nativeFieldUnknownFields?.numbering.get(name);
      yield* record({ kind: 'numbering', payload: encodeNativeLayoutPageNumberField(name, value, fields?.unknownFields) }, fields?.envelopeUnknown);
    }
    for (const asset of assets.entries()) {
      const ref = yield* streamNativeLayoutAsset(asset.source, asset.kind, nextId, options);
      ref.unknownFields = asset.fields?.unknownFields ?? [];
      yield* record({ kind: 'asset', assetId: asset.id, payload: encodeNativeLayoutAssetReference(ref) }, asset.fields?.envelopeUnknown);
    }
    yield* flush();
    const header = yield* streamNativeLayoutDocumentHeader(state, assets.size, nextId, options), metadataChunk = nextId();
    yield* single(encodeNativeLayoutDocumentHeader(header, state.nativeDocumentUnknownFields), metadataChunk, 3);
    yield* single(encodeNativeDocumentRoot({ schemaMajor: 1, documentKind: 2, metadataChunk, recordChunks, requiredCapabilities: [], unknownFields: state.nativeRootUnknownFields ?? [] }), NATIVE_ROOT_ID, 1);
  }
  return writeNativeContainer({ kind: 2, root: NATIVE_ROOT_ID }, packNativeNumericPages(chunks(), options), sink, options.signal);
}
