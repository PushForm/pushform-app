// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeChunkError } from './chunks';
import type { LayoutDocumentState, LayoutPage } from '@pushform/layout';
import type { NativeFileSource } from './container';
import { openNativeDocumentIndex } from './documentRoot';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { unpackNativeRecords } from './recordStream';
import { decodeNativeLayoutRecord } from './layoutRecord';
import type { NativeLayoutRecord } from './layoutRecord';
import { decodeNativeLayoutDocumentHeader, readNativeLayoutDocumentOrders, decodeNativeLayoutCustomField, decodeNativeLayoutPageNumberField } from './layoutDocument';
import { decodeNativeLayoutLayer } from './layoutMetadata';
import { decodeNativeLayoutReference } from './layoutReference';
import { decodeNativeLayoutPage, readNativeLayoutPage } from './layoutPage';
import { decodeNativeLayoutEntityRecord } from './layoutEntityWriter';
import { readNativeLayoutEntity } from './layoutEntityReader';
import type { NativePackedLayoutEntity } from './layoutEntityReader';
import { decodeNativeLayoutAssetReference, readNativeLayoutAsset } from './layoutAsset';
import type { NativeLayoutAsset } from './layoutAsset';
import { decodeNativeLayoutArchiveHeader, decodeNativeLayoutArchiveModel, decodeNativeLayoutArchiveViewport, readNativeLayoutArchiveViewport, assembleNativeLayoutArchive } from './layoutArchive';
type ArchiveDraft = { header: ReturnType<typeof decodeNativeLayoutArchiveHeader>; models: Map<string, ReturnType<typeof decodeNativeLayoutArchiveModel>>; viewports: Map<string, Awaited<ReturnType<typeof readNativeLayoutArchiveViewport>>> };
export interface NativePackedLayoutPage { record: ReturnType<typeof decodeNativeLayoutPage>; entities: Map<number, NativePackedLayoutEntity>; order: Uint32Array; nativeUnknownFields?: NonNullable<LayoutPage['nativeUnknownFields']> }
const fail = (message: string): never => { throw new NativeChunkError(message); };
function insert<K, V>(map: Map<K, V>, key: K, value: V): void { if (map.has(key)) fail('Duplicate native Layout record identity'); map.set(key, value); }
function hasExtensions(value: unknown): boolean {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
  if (value instanceof Map) { for (const child of value.values()) if (Array.isArray(child) && child.some(v => v instanceof Uint8Array) || hasExtensions(child)) return true; return false; }
  if (Array.isArray(value)) return value.some(hasExtensions);
  for (const [key, child] of Object.entries(value)) if (key === 'unknownFields' && Array.isArray(child) && child.length || hasExtensions(child)) return true;
  return false;
}
/** Two metadata passes stage the complete known Layout format without retaining encoded entity records. */
export async function readNativeLayout(source: NativeFileSource, options: { signal?: AbortSignal; budget?: NativeColumnBudget } = {}) {
  const signal = options.signal, index = await openNativeDocumentIndex(source, new Set(), (kind, schema) => schema === 1 && [2, 3, 4].includes(kind) || kind === 2 && schema === 2, signal);
  if (index.root.documentKind !== 2) return fail('Expected native Layout document');
  const document = decodeNativeLayoutDocumentHeader(await index.container.read(index.metadata)), budget = options.budget ?? new NativeColumnBudget();
  const entries = new Map(index.container.entries.map(e => [e.descriptor.id, e])), consumed = new Set<number>();
  const columns = new NativeColumnReader({ entries: index.container.entries, read: async entry => {
    if (consumed.has(entry.descriptor.id)) return fail('Aliased native Layout numeric/asset chunk'); consumed.add(entry.descriptor.id); return index.container.read(entry);
  } }, budget);
  const layers = new Map<number, ReturnType<typeof decodeNativeLayoutLayer>>(), references = new Map<number, ReturnType<typeof decodeNativeLayoutReference>>(),
    pages = new Map<number, NativePackedLayoutPage>(), sharedEntities = new Map<number, NativePackedLayoutEntity>(), assets = new Map<number, NativeLayoutAsset>(),
    archiveDrafts = new Map<string, ArchiveDraft>(), customFields = new Map<string, ReturnType<typeof decodeNativeLayoutCustomField>>(), numbering = new Map<string, ReturnType<typeof decodeNativeLayoutPageNumberField>>();
  const envelopeExtensions = new Map<string, Uint8Array[]>();
  const fieldUnknownFields: NonNullable<LayoutDocumentState['nativeFieldUnknownFields']> = { custom: new Map(), numbering: new Map() };
  let hasUnsupportedExtensions = index.container.entries.some(e => ![1, 2, 3, 4].includes(e.descriptor.kind) || e.descriptor.schemaId !== 1 || hasExtensions(e.descriptor));
  async function* records(): AsyncGenerator<NativeLayoutRecord> {
    async function* pages() {
      for (const id of index.root.recordChunks) {
        signal?.throwIfAborted(); const e = entries.get(id); if (!e || e.descriptor.kind !== 3 || e.descriptor.schemaId !== 1) return fail('Invalid native Layout record chunk');
        yield await index.container.read(e);
      }
    }
    for await (const bytes of unpackNativeRecords(pages(), signal)) yield decodeNativeLayoutRecord(bytes);
  }
  let ordinal = 0;
  for await (const r of records()) {
    if (r.unknownFields.length && !['entity', 'layer', 'reference', 'page', 'customField', 'numbering', 'archive', 'archiveModel', 'archiveViewport', 'asset'].includes(r.kind)) { hasUnsupportedExtensions = true; envelopeExtensions.set(String(ordinal), r.unknownFields); } ordinal++;
    switch (r.kind) {
      case 'entity': break;
      case 'layer': {
        const v = decodeNativeLayoutLayer(r.payload);
        if (r.unknownFields.length || v.unknownFields.length) v.value.nativeUnknownFields = {
          ...(r.unknownFields.length ? { envelopeUnknown: r.unknownFields } : {}), ...(v.unknownFields.length ? { unknownFields: v.unknownFields } : {}),
        };
        insert(layers, v.value.id, v); break;
      }
      case 'reference': {
        const v = decodeNativeLayoutReference(r.payload), fields = v.extensions.get(''), target = v.extensions.get('target');
        if (r.unknownFields.length || fields?.length) v.value.nativeUnknownFields = {
          ...(r.unknownFields.length ? { envelopeUnknown: r.unknownFields } : {}), ...(fields?.length ? { unknownFields: fields } : {}),
        };
        if (target?.length) v.value.target.nativeUnknownFields = target;
        insert(references, v.value.id, v); break;
      }
      case 'page': {
        const v = decodeNativeLayoutPage(r.payload);
        insert(pages, v.value.metadata.id, { record: v, entities: new Map(), order: new Uint32Array(),
          ...(r.unknownFields.length || v.extensions.size ? { nativeUnknownFields: {
            ...(r.unknownFields.length ? { envelopeUnknown: r.unknownFields } : {}), ...(v.extensions.size ? { extensions: v.extensions } : {}),
          } } : {}),
        }); break;
      }
      case 'asset': { const ref = decodeNativeLayoutAssetReference(r.payload); if (assets.has(r.assetId!)) return fail('Duplicate native Layout asset'); const asset = await readNativeLayoutAsset(ref, columns, signal); if (r.unknownFields.length) asset.envelopeUnknown = r.unknownFields; assets.set(r.assetId!, asset); break; }
      case 'archive': { const h = decodeNativeLayoutArchiveHeader(r.payload); if (r.unknownFields.length) h.envelopeUnknown = r.unknownFields; insert(archiveDrafts, h.id, { header: h, models: new Map(), viewports: new Map() }); break; }
      case 'archiveModel': { const owner = archiveDrafts.get(r.archiveId!); if (!owner) return fail('Missing native Layout archive owner'); const v = decodeNativeLayoutArchiveModel(r.payload); if (r.unknownFields.length) v.envelopeUnknown = r.unknownFields; insert(owner.models, v.id, v); break; }
      case 'archiveViewport': { const owner = archiveDrafts.get(r.archiveId!); if (!owner) return fail('Missing native Layout archive owner'); const ref = decodeNativeLayoutArchiveViewport(r.payload); const v = await readNativeLayoutArchiveViewport(ref, columns, signal); if (r.unknownFields.length) v.envelopeUnknown = r.unknownFields; insert(owner.viewports, ref.id, v); break; }
      case 'customField': case 'numbering': {
        const v = r.kind === 'customField' ? decodeNativeLayoutCustomField(r.payload) : decodeNativeLayoutPageNumberField(r.payload);
        if (r.unknownFields.length || v.unknownFields.length) fieldUnknownFields[r.kind === 'customField' ? 'custom' : 'numbering'].set(v.name, {
          ...(r.unknownFields.length ? { envelopeUnknown: r.unknownFields } : {}), ...(v.unknownFields.length ? { unknownFields: v.unknownFields } : {}),
        });
        if (typeof v.value === 'string') insert(customFields, v.name, v as ReturnType<typeof decodeNativeLayoutCustomField>);
        else insert(numbering, v.name, v as ReturnType<typeof decodeNativeLayoutPageNumberField>);
        break;
      }
    }
  }
  const h = document.value;
  if (references.size !== h.referenceCount || archiveDrafts.size !== h.archiveCount || customFields.size !== h.customFieldCount || numbering.size !== h.numberingCount || assets.size !== h.assetCount || pages.size !== h.orders.pageOrder.count || layers.size !== h.orders.layerOrder.count) return fail('Incomplete native Layout catalogs');
  const usedAssets = new Set<number>();
  const archives = new Map<string, ReturnType<typeof assembleNativeLayoutArchive>>();
  for (const [id, draft] of archiveDrafts) { archives.set(id, assembleNativeLayoutArchive(draft.header, assets, draft.models.values(), draft.viewports.values())); usedAssets.add(draft.header.assetId); }
  // A single lookahead record lets each entity reader consume its own stream, including arbitrarily many table cells.
  const iterator = records()[Symbol.asyncIterator](); let lookahead: IteratorResult<NativeLayoutRecord> | undefined;
  const next = async () => { const result = lookahead ?? await iterator.next(); lookahead = undefined; return result; };
  while (true) {
    const step = await next(); if (step.done) break; const first = step.value; if (first.kind !== 'entity') continue;
    const firstEntity = decodeNativeLayoutEntityRecord(first.payload), pageId = first.pageId!, owner = pageId === 0 ? sharedEntities : pages.get(pageId)?.entities;
    if (!owner || firstEntity.kind !== 'header') return fail('Invalid native Layout entity owner/header');
    async function* entityRecords() {
      yield firstEntity;
      while (true) {
        const step = await iterator.next(); if (step.done) return;
        if (step.value.kind !== 'entity') { lookahead = step; return; }
        const entity = decodeNativeLayoutEntityRecord(step.value.payload);
        if (entity.ownerId !== firstEntity.ownerId || step.value.pageId !== pageId) { lookahead = step; return; }
        if (step.value.unknownFields.length) {
          if (entity.payload === undefined || ['text', 'table', 'tableCell', 'dimension', 'angularDimension', 'labelAnchor', 'modelAnnotation', 'preservedModelConnections', 'image'].includes(entity.kind)) entity.outerUnknown = step.value.unknownFields;
          else hasUnsupportedExtensions = true;
        }
        yield entity;
      }
    }
    const entity = await readNativeLayoutEntity(entityRecords(), columns, assets, signal);
    if (entity.image) usedAssets.add(entity.image.reference.assetId);
    if (entity.connections) usedAssets.add(entity.connections.snapshotAssetId);
    if (first.unknownFields.length) entity.outerHeaderUnknown = first.unknownFields;
    hasUnsupportedExtensions ||= hasExtensions({ data: { ...entity.data, text: undefined, table: undefined, dimension: undefined, angularDimension: undefined, labelAnchor: undefined, modelAnnotation: undefined },
      extensions: new Map([...entity.extensions].filter(([scope]) => scope !== 'envelope/header' && !(entity.image && scope === 'envelope/image') && !(entity.connections && (scope === 'envelope/preservedModelConnections' || scope.startsWith('preservedModelConnections/'))) && !(entity.data.text && (scope === 'envelope/text' || scope.startsWith('text/'))) && !(entity.data.table && (scope === 'envelope/table' || scope.startsWith('envelope/tableCell/') || scope.startsWith('table/'))) && !(['dimension', 'angularDimension', 'labelAnchor', 'modelAnnotation'] as const).some(key => entity.data[key] && (scope === `envelope/${key}` || scope.startsWith(`${key}/`))))) });
    insert(owner, firstEntity.ownerId, entity);
  }
  for (const page of pages.values()) page.order = (await readNativeLayoutPage(page.record.value, columns, layers, page.entities, signal)).order;
  const orders = await readNativeLayoutDocumentOrders(h, columns, { pages, layers, sharedEntities }, signal);
  if (!layers.has(h.metadata.activeLayerId)) return fail('Missing native Layout active layer');
  for (const [pageId, entities] of [[0, sharedEntities] as const, ...Array.from(pages, ([id, page]) => [id, page.entities] as const)]) {
    for (const entity of entities.values()) { const layer = layers.get(entity.header.metadata.value.layerId)?.value; if (!layer || layer.shared !== (pageId === 0)) return fail('Invalid native Layout entity layer'); }
  }
  // Persistent IDs are globally unique; repeated group identities are allowed but may not collide with object IDs.
  const entityMaps = () => [sharedEntities, ...Array.from(pages.values(), p => p.entities)];
  let identityCount = layers.size + references.size + pages.size, groupCount = 0;
  for (const map of entityMaps()) for (const entity of map.values()) { identityCount++; const m = entity.header.metadata.value; groupCount += Number(m.groupId !== undefined) + (m.nestedGroupIds?.length ?? 0); }
  const scratchBytes = (identityCount + groupCount) * 4; budget.reserve(scratchBytes);
  try {
    const identities = new Uint32Array(identityCount), groups = new Uint32Array(groupCount); let i = 0, g = 0;
    const validId = (id: number) => { if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || id >= h.metadata.meta.nextId) fail('Invalid native Layout identity/allocator'); return id; };
    for (const map of [layers, references, pages]) for (const id of map.keys()) identities[i++] = validId(id);
    for (const map of entityMaps()) for (const [id, e] of map) { identities[i++] = validId(id); const m = e.header.metadata.value; if (m.groupId !== undefined) groups[g++] = validId(m.groupId); for (const id of m.nestedGroupIds ?? []) groups[g++] = validId(id); }
    identities.sort(); groups.sort(); for (let i = 1; i < identities.length; i++) if (identities[i] === identities[i - 1]) return fail('Native Layout ID collision');
    let at = 0; for (const group of groups) { while (at < identities.length && identities[at]! < group) at++; if (identities[at] === group) return fail('Native Layout group/object ID collision'); }
  } finally { budget.release(scratchBytes); }
  const staged = { document, layers, references, pages, sharedEntities, assets, archives, customFields, numbering, fieldUnknownFields, orders, envelopeExtensions, rootExtensions: index.root.unknownFields };
  // Supported fields are attached to editable owners; inspect the remaining scopes independently.
  hasUnsupportedExtensions ||= hasExtensions({ ...staged, assets: undefined, document: undefined, layers: undefined, references: undefined, archives: undefined, customFields: undefined, numbering: undefined, fieldUnknownFields: undefined, pages: undefined, sharedEntities: undefined }); signal?.throwIfAborted();
  for (const [id, asset] of assets) if (!usedAssets.has(id) && (asset.reference.unknownFields.length || asset.envelopeUnknown?.length)) hasUnsupportedExtensions = true;
  return { ...staged, canonicalAndIndexBytes: budget.usedBytes, hasUnsupportedExtensions };
}
export type NativePackedLayout = Awaited<ReturnType<typeof readNativeLayout>>;
