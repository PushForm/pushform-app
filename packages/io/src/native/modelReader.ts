// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, Id, ImageId, MaterialId, TagId } from '@pushform/core';
import type { CommonAttrs, ComponentInstance, Guide, ImageEntity, SectionPlane, TextEntity, Dimension, ImageBlob } from '@pushform/model';
import { nativeAttributeScope } from '@pushform/model';
import { NativeChunkError } from './chunks';
import type { NativeFileSource } from './container';
import { openNativeDocumentIndex, NATIVE_MODEL_CAPABILITIES } from './documentRoot';
import { decodeNativeModelSettings, validateNativeModelCatalogs } from './modelSettings';
import { decodeNativeModelRecord } from './modelRecord';
import type { NativeModelRecord } from './modelRecord';
import { unpackNativeRecords } from './recordStream';
import { NativeCatalogStore } from './catalogStore';
import { NativeCommonPropertyReader, encodeNativeCommonProperty } from './commonProperty';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { readNativeDefinitionOrder } from './definitionOrder';
import type { NativeDefinitionMetadata, DefinitionExtensions } from './definition';
import { readNativeSketch } from './sketch';
import type { NativePackedSketch } from './sketch';
import { readNativeBody } from './body';
import type { NativePackedBody } from './body';
import { readNativeMeshPart } from './meshPart';
import type { NativePackedMeshPart } from './meshPart';
import { readNativeImageAsset } from './imageAsset';
import { validateNativeModelIds } from './modelIds';

export interface NativePackedDefinition {
  metadata: NativeDefinitionMetadata; order: Uint32Array; activeSectionPlaneId: Id | null; extensions: DefinitionExtensions;
  sketch: NativePackedSketch | undefined; bodies: Map<Id, NativePackedBody>; meshParts: Map<Id, NativePackedMeshPart>; instances: Map<Id, ComponentInstance>;
  guides: Map<Id, Guide>; images: Map<Id, ImageEntity>; sectionPlanes: Map<Id, SectionPlane>; texts: Map<Id, TextEntity>; dimensions: Map<Id, Dimension>;
}
const fail = (message: string): never => { throw new NativeChunkError(message); };
function hasExtensions(value: unknown): boolean {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
  if (value instanceof Map) return [...value.values()].some(child =>
    (Array.isArray(child) && child.some(part => part instanceof Uint8Array)) || hasExtensions(child));
  if (Array.isArray(value)) return value.some(hasExtensions);
  return Object.entries(value).some(([key, child]) =>
    ((key === 'unknownFields' || key === 'envelopeUnknown') && Array.isArray(child) && child.length > 0) ||
    (key === 'extensions' && child instanceof Map && child.size > 0) || hasExtensions(child));
}
function insert<K, V>(map: Map<K, V>, key: K, value: V): void { if (map.has(key)) fail('Duplicate native entity ID'); map.set(key, value); }
/** Stage a model in packed storage. Does not install legacy DocumentState or rebuild spatial indexes. */
export async function readNativeModel(source: NativeFileSource, options: { signal?: AbortSignal; budget?: NativeColumnBudget } = {}) {
  const signal = options.signal, index = await openNativeDocumentIndex(source, NATIVE_MODEL_CAPABILITIES, (kind, schema) => (schema === 1 && [2, 3, 4].includes(kind)) || (kind === 2 && schema === 2), signal);
  if (index.root.documentKind !== 1) return fail('Expected native Modeling document');
  const settings = decodeNativeModelSettings(await index.container.read(index.metadata)), catalogs = new NativeCatalogStore(), properties = new NativeCommonPropertyReader();
  let hasUnsupportedExtensions =
    index.container.entries.some(e => ![1, 2, 3, 4].includes(e.descriptor.kind) || e.descriptor.schemaId !== 1 || hasExtensions(e.descriptor));
  const definitions = new Map<DefId, NativePackedDefinition>(), imageBlobs = new Map<ImageId, ImageBlob>(), budget = options.budget ?? new NativeColumnBudget();
  const consumed = new Set<number>(), entries = new Map(index.container.entries.map(e => [e.descriptor.id, e]));
  const columns = new NativeColumnReader({ entries: index.container.entries, read: async entry => {
    const id = entry.descriptor.id; if (consumed.has(id)) return fail('Aliased native numeric/asset chunk'); consumed.add(id); return index.container.read(entry);
  } }, budget);
  const unknown: Extract<NativeModelRecord, { kind: 'unknown' }>[] = [], extras = new Map<string, Omit<NativeModelRecord, 'value'>>();
  function remember(key: string, record: NativeModelRecord): void {
    const { value: _value, ...extra } = record as Exclude<NativeModelRecord, { kind: 'unknown' }>;
    if (record.required === false || record.envelopeUnknown?.length || ('extensions' in record && record.extensions instanceof Map && record.extensions.size)) extras.set(key, extra);
  }
  async function* records() {
    async function* pages() {
      for (const id of index.root.recordChunks) {
        signal?.throwIfAborted(); const entry = entries.get(id)!;
        if (entry.descriptor.kind !== 3 || entry.descriptor.schemaId !== 1) return fail('Invalid native model record chunk');
        yield await index.container.read(entry);
      }
    }
    for await (const bytes of unpackNativeRecords(pages(), signal)) {
      const record = decodeNativeModelRecord(bytes);
      if (record.kind === 'commonProperty') {
        for (const path of record.value.extensions.attributes.keys()) if (nativeAttributeScope(record.value.value.attributes, path) !== 'present') hasUnsupportedExtensions = true;
        yield record; continue;
      }
      if (!['sketch', 'body', 'dimension', 'instance', 'definition', 'style', 'scene', 'image', 'material', 'tag', 'tagFolder', 'guide', 'imagePlacement', 'sectionPlane', 'text', 'meshPart'].includes(record.kind) &&
          (record.kind === 'unknown' || hasExtensions(record))) hasUnsupportedExtensions = true;
      yield record;
    }
  }
  // Two metadata passes avoid retaining all geometry references and decoded record wrappers.
  for await (const r of records()) {
    switch (r.kind) {
      case 'material': case 'tag': case 'tagFolder': case 'style': case 'scene': case 'image': catalogs.add(r); break;
      case 'commonProperty': properties.add(encodeNativeCommonProperty(r.value), r); remember(`property/${r.value.id}`, r); break;
      case 'unknown': unknown.push(r); break;
      case 'definition': {
        const d = r.value, id = d.metadata.id;
        insert(definitions, id, { metadata: d.metadata, order: await readNativeDefinitionOrder(d.entityOrder, columns, signal), activeSectionPlaneId: d.activeSectionPlaneId,
          extensions: r.extensions ?? new Map(), sketch: undefined, bodies: new Map(), meshParts: new Map(), instances: new Map(), guides: new Map(), images: new Map(), sectionPlanes: new Map(), texts: new Map(), dimensions: new Map() });
        remember(`definition/${id}`, r); break;
      }
    }
  }
  validateNativeModelCatalogs(settings.value, { ...catalogs.values, definitions });
  const hasMaterial = (id: number): boolean => catalogs.values.materials.has(id as MaterialId), hasTag = (id: number): boolean => catalogs.values.tags.has(id as TagId);
  function common(id: number): CommonAttrs { const value = properties.get(id).value; if (!hasTag(value.tagId)) return fail('Missing native entity tag'); return value; }
  for (const id of catalogs.values.images.keys()) { const blob = await readNativeImageAsset(catalogs.imageRecord(id), columns, signal); if (blob) imageBlobs.set(id, blob); }
  for await (const r of records()) {
    if (r.kind === 'commonProperty') { common(r.value.id); continue; }
    if (!('ownerDefinitionId' in r) || r.kind === 'unknown') continue;
    const d = definitions.get(r.ownerDefinitionId); if (!d) return fail('Missing native owner definition');
    if (r.kind === 'sketch') {
      if (d.sketch) return fail('Duplicate native definition sketch');
      d.sketch = await readNativeSketch(r.value, columns, properties, hasMaterial, signal); remember(`sketch/${r.ownerDefinitionId}`, r); continue;
    }
    if (r.kind === 'body') {
      const body = await readNativeBody(r.value, columns, properties, hasMaterial, hasTag, undefined, signal); insert(d.bodies, body.id as Id, body); remember(`body/${body.id}`, r); continue;
    }
    if (r.kind === 'meshPart') {
      const part = await readNativeMeshPart(r.value, columns, properties, hasMaterial, hasTag, signal); insert(d.meshParts, part.id, part); remember(`meshPart/${part.id}`, r); continue;
    }
    const id = r.value.value.id, value = { ...common(r.value.properties), ...r.value.value };
    if ('unknownFields' in r.value && (r.required === false || r.envelopeUnknown?.length || r.value.unknownFields.length)) {
      (value as Guide | ImageEntity | SectionPlane | TextEntity).nativeUnknownFields = {
        ...(r.required === false ? { required: false } : {}),
        ...(r.envelopeUnknown?.length ? { envelopeUnknown: r.envelopeUnknown } : {}), unknownFields: r.value.unknownFields,
      };
    }
    switch (r.kind) {
      case 'instance': {
        const v = value as ComponentInstance;
        if (r.required === false || r.envelopeUnknown?.length || r.extensions?.size) v.nativeUnknownFields = {
          ...(r.required === false ? { required: false } : {}),
          ...(r.envelopeUnknown?.length ? { envelopeUnknown: r.envelopeUnknown } : {}),
          ...(r.extensions?.size ? { extensions: r.extensions } : {}),
        };
        if (!definitions.has(v.definitionId) || (v.materialId !== null && !hasMaterial(v.materialId))) return fail('Missing native instance reference');
        insert(d.instances, id, v); break;
      }
      case 'guide': insert(d.guides, id, value as Guide); break;
      case 'imagePlacement': {
        const v = value as ImageEntity; if (!catalogs.values.images.has(v.imageId)) return fail('Missing native placed image'); insert(d.images, id, v); break;
      }
      case 'sectionPlane': insert(d.sectionPlanes, id, value as SectionPlane); break;
      case 'text': insert(d.texts, id, value as TextEntity); break;
      case 'dimension': {
        const v = value as Dimension, extensions = new Map(r.extensions);
        for (const [index, scope] of ['anchors.start', 'anchors.end'].entries()) {
          const anchor = v.anchors?.[index], fields = extensions.get(scope);
          if (anchor && fields) { anchor.nativeUnknownFields = fields; extensions.delete(scope); }
        }
        const curveFields = extensions.get('curve');
        if (v.curve && curveFields) { v.curve.nativeUnknownFields = curveFields; extensions.delete('curve'); }
        if (r.required === false || r.envelopeUnknown?.length || extensions.size) v.nativeUnknownFields = {
          ...(r.required === false ? { required: false } : {}), ...(r.envelopeUnknown?.length ? { envelopeUnknown: r.envelopeUnknown } : {}),
          ...(extensions.size ? { extensions } : {}),
        };
        insert(d.dimensions, id, v); break;
      }
    }
    remember(`${r.kind}/${id}`, r);
    if ('unknownFields' in r.value && r.value.unknownFields.length) extras.set(`${r.kind}/${id}/payload`, { kind: r.kind, envelopeUnknown: r.value.unknownFields });
  }
  for (const d of definitions.values()) {
    if (!d.sketch) return fail('Missing native definition sketch');
    if (d.activeSectionPlaneId !== null && !d.sectionPlanes.has(d.activeSectionPlaneId)) return fail('Missing native active section plane');
    const seen = new Set<Id>();
    for (const map of [d.bodies, d.meshParts, d.instances, d.guides, d.images, d.sectionPlanes, d.texts, d.dimensions]) for (const id of map.keys()) {
      if (seen.has(id) || d.sketch.indexes.vertices.has(id) || d.sketch.indexes.edges.has(id) || d.sketch.indexes.faces.has(id)) return fail('Native entity ID collision'); seen.add(id);
    }
    columns.validateUniqueIds(d.order, signal);
    for (const id of d.order) if (!seen.has(id as Id) && !d.sketch.indexes.vertices.has(id) && !d.sketch.indexes.edges.has(id) && !d.sketch.indexes.faces.has(id)) return fail('Missing native ordered entity');
  }
  validateNativeModelIds({ settings: settings.value, catalogs, definitions }, budget, signal);
  // Iterative DFS bounds stack usage even for deeply nested component hierarchies.
  const visited = new Set<DefId>(), active = new Set<DefId>();
  for (const id of definitions.keys()) {
    if (visited.has(id)) continue;
    const stack: { id: DefId; children: Iterator<ComponentInstance> }[] = [{ id, children: definitions.get(id)!.instances.values() }]; active.add(id);
    while (stack.length) {
      signal?.throwIfAborted(); const frame = stack[stack.length - 1]!, child = frame.children.next();
      if (child.done) { visited.add(frame.id); active.delete(frame.id); stack.pop(); continue; }
      const target = child.value.definitionId; if (active.has(target)) return fail('Cyclic native definition hierarchy');
      if (!visited.has(target)) { active.add(target); stack.push({ id: target, children: definitions.get(target)!.instances.values() }); }
    }
  }
  signal?.throwIfAborted();
  return { settings: settings.value, settingsExtensions: settings.extensions, catalogs, properties, definitions, imageBlobs, unknown, extras,
    rootExtensions: index.root.unknownFields, canonicalAndIndexBytes: budget.usedBytes, hasUnsupportedExtensions };
}
export type NativePackedModel = Awaited<ReturnType<typeof readNativeModel>>;
