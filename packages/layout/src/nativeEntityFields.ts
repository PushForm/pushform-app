// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { LayoutDocumentState, LayoutEntity, LayoutEntityPayload } from './LayoutDocument';
import { reconcileNativeLayoutDimensionFields, reconcileNativeLayoutAnchorFields } from './nativeDimensionFields';
import { reconcileNativeAnnotationFields } from './nativeAnnotationFields';
import { reconcileNativeImageFields } from './nativeImageFields';
import { reconcileNativeTableFields } from './nativeTableFields';
import { reconcileNativeTextFields } from './nativeTextFields';

/** Page 0 denotes shared entities; only authored entity/container paths are inspected. */
export function reconcileNativeEntityFields(state: LayoutDocumentState, patches: readonly Patch[]): [LayoutDocumentState, Patch[], Patch[]] | null {
  const touched = new Map<number, Set<number> | null>();
  for (const { path } of patches) {
    if (path[0] === 'pages' && path.length === 1) { for (const id of state.pages.keys()) touched.set(id, null); continue; }
    const shared = path[0] === 'sharedEntities';
    if (!shared && (path[0] !== 'pages' || path.length > 2 && path[2] !== 'entities')) continue;
    const page = shared ? 0 : path[1] as number, entityAt = shared ? 1 : 3;
    if (path.length <= entityAt) { touched.set(page, null); continue; }
    if (touched.get(page) === null) continue;
    const ids = touched.get(page) ?? new Set<number>(); ids.add(path[entityAt] as number); touched.set(page, ids);
  }
  const cleanup: { pageId: number; id: number; geometry: string[]; metadata: string[]; emptyPayloads: LayoutEntityPayload[]; dash: boolean; arrows: ('startArrow' | 'endArrow')[]; text: boolean; table: boolean; dimensions: boolean; label: boolean; annotation: boolean; image: boolean }[] = [];
  for (const [pageId, ids] of touched) {
    const entities = pageId === 0 ? state.sharedEntities : state.pages.get(pageId)?.entities;
    if (!entities) continue;
    for (const id of ids ?? entities.keys()) {
      const entity = entities.get(id); if (!entity) continue;
      const extra = entity.nativeUnknownFields, style = entity.style?.nativeUnknownFields;
      const emptyPayloads = [...extra?.emptyPayloads?.keys() ?? []].filter(key => !Object.hasOwn(entity, key) || entity[key] !== undefined);
      const geometry = [...extra?.geometry?.keys() ?? []].filter(key => !owns(entity, key));
      const metadata = [...extra?.metadata?.keys() ?? []].filter(key =>
        (key === 'name' || key === 'nestedGroupIds' || key === 'style') && !Object.hasOwn(entity, key));
      const dash = !!style?.records.has('style/dash') && !Object.hasOwn(entity.style!, 'strokeDashMm');
      const arrows = (['startArrow', 'endArrow'] as const).filter(key => style?.style.has(key) &&
        (!Object.hasOwn(entity.style!, key) || entity.style![key] !== undefined));
      const text = entity.text ? reconcileNativeTextFields(entity.text) : false;
      const table = entity.table ? reconcileNativeTableFields(entity.table) : false;
      const dimensions = [entity.dimension, entity.angularDimension].some(value => value && reconcileNativeLayoutDimensionFields(value));
      const label = entity.labelAnchor ? reconcileNativeLayoutAnchorFields(entity.labelAnchor) : false;
      const annotation = [entity.modelAnnotation, entity.preservedModelConnections].some(value => value && reconcileNativeAnnotationFields(value));
      const image = entity.image ? reconcileNativeImageFields(entity.image) : false;
      if (emptyPayloads.length || geometry.length || metadata.length || dash || arrows.length || text || table || dimensions || label || annotation || image) cleanup.push({ pageId, id, geometry, metadata, emptyPayloads, dash, arrows, text, table, dimensions, label, annotation, image });
    }
  }
  if (!cleanup.length) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const change of cleanup) {
      const entity = (change.pageId === 0 ? draft.sharedEntities : draft.pages.get(change.pageId)!.entities).get(change.id)!, extra = entity.nativeUnknownFields;
      if (extra) {
        for (const key of change.emptyPayloads) extra.emptyPayloads!.delete(key);
        if (extra.emptyPayloads && !extra.emptyPayloads.size) delete extra.emptyPayloads;
        for (const key of change.geometry) extra.geometry!.delete(key);
        for (const key of change.metadata) extra.metadata!.delete(key);
        if (extra.geometry && !extra.geometry.size) delete extra.geometry;
        if (extra.metadata && !extra.metadata.size) delete extra.metadata;
        if (!extra.outerHeader?.length && !extra.headerEnvelope?.length && !extra.header?.length && !extra.geometry && !extra.metadata && !extra.emptyPayloads) delete entity.nativeUnknownFields;
      }
      const style = entity.style?.nativeUnknownFields;
      if (style) {
        if (change.dash) style.records.delete('style/dash');
        for (const key of change.arrows) style.style.delete(key);
        if (!style.records.size && !style.style.size) delete entity.style!.nativeUnknownFields;
      }
      if (change.text) reconcileNativeTextFields(entity.text!, true);
      if (change.table) reconcileNativeTableFields(entity.table!, true);
      if (change.annotation) for (const value of [entity.modelAnnotation, entity.preservedModelConnections]) if (value) reconcileNativeAnnotationFields(value, true);
      if (change.image) reconcileNativeImageFields(entity.image!, true);
      if (change.label) reconcileNativeLayoutAnchorFields(entity.labelAnchor!, true);
      if (change.dimensions) for (const value of [entity.dimension, entity.angularDimension]) if (value) reconcileNativeLayoutDimensionFields(value, true);
    }
  });
  return [next, forward, inverse];
}
function owns(entity: LayoutEntity, scope: string): boolean {
  if (scope === 'handleValues') return entity.handles !== undefined;
  if (scope === 'handleFlags') return Object.hasOwn(entity, 'handles');
  if (scope === 'contourStarts' || scope === 'openContours') return Object.hasOwn(entity, scope);
  return true;
}
