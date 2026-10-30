// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState, LayoutEntity } from '@pushform/layout';
import { assertLayoutState } from '../layoutFile';
import { NativeChunkError } from './chunks';
import type { NativePackedLayout } from './layoutReader';
import type { NativePackedLayoutEntity } from './layoutEntityReader';
import { materializeNativeLayoutEntity } from './layoutEntityReader';
import { materializeNativeLayoutAsset } from './layoutAsset';
import { materializeNativeLayoutArchive } from './layoutArchive';
import { validateNativeLayoutViewportReferences } from './layoutViewport';
/** Transitional editor bridge. Keep rejecting future extensions until editable state can retain/rewrite their sidecars. */
export function nativeLayoutState(packed: NativePackedLayout): LayoutDocumentState {
  if (packed.hasUnsupportedExtensions) throw new NativeChunkError('This Layout file contains extensions the current editor cannot preserve');
  const strings = new Map<number, string>(); for (const [id, asset] of packed.assets) strings.set(id, materializeNativeLayoutAsset(asset));
  const entities = (values: ReadonlyMap<number, NativePackedLayoutEntity>): Map<number, LayoutEntity> => {
    const result = new Map<number, LayoutEntity>(); for (const [id, entity] of values) result.set(id, materializeNativeLayoutEntity(entity, strings)); return result;
  };
  const state: LayoutDocumentState = { ...packed.document.value.metadata, references: new Map(Array.from(packed.references, ([id, r]) => [id, r.value])),
    pages: new Map(), pageOrder: Array.from(packed.orders.pageOrder), layers: new Map(Array.from(packed.layers, ([id, r]) => [id, r.value])), layerOrder: Array.from(packed.orders.layerOrder),
    sharedEntities: entities(packed.sharedEntities), sharedEntityOrder: Array.from(packed.orders.sharedEntityOrder), customFields: new Map(Array.from(packed.customFields, ([name, field]) => [name, field.value])) };
  for (const [id, p] of packed.pages) state.pages.set(id, { ...p.record.value.metadata, entities: entities(p.entities), entityOrder: Array.from(p.order),
    ...(p.nativeUnknownFields ? { nativeUnknownFields: p.nativeUnknownFields } : {}) });
  if (packed.document.value.archivesState === 1) Object.defineProperty(state, 'modelArchives', { value: undefined, enumerable: true, writable: true, configurable: true });
  else if (packed.document.value.archivesState === 2) state.modelArchives = new Map(Array.from(packed.archives, ([id, archive]) => [id, materializeNativeLayoutArchive(archive, strings)]));
  if (packed.document.value.numberingState === 1) Object.defineProperty(state, 'pageNumberFields', { value: undefined, enumerable: true, writable: true, configurable: true });
  else if (packed.document.value.numberingState === 2) state.pageNumberFields = new Map(Array.from(packed.numbering, ([name, field]) => [name, field.value]));
  if (packed.rootExtensions.length) state.nativeRootUnknownFields = packed.rootExtensions;
  if (packed.fieldUnknownFields.custom.size || packed.fieldUnknownFields.numbering.size) state.nativeFieldUnknownFields = packed.fieldUnknownFields;
  const ext = packed.document.extensions, style = new Map(ext.metadata.style);
  for (const key of ['startArrow', 'endArrow'] as const) {
    const arrow = state.defaultStyle[key], fields = style.get(key);
    if (arrow && fields) { arrow.nativeUnknownFields = fields; style.delete(key); }
  }
  if (ext.records.size || ext.metadata.records.size || ext.metadata.settings.size || style.size) state.nativeDocumentUnknownFields = {
    records: ext.records, metadata: { ...ext.metadata, style },
  };
  assertLayoutState(state);
  for (const map of [state.sharedEntities, ...Array.from(state.pages.values(), p => p.entities)]) for (const entity of map.values()) {
    if (entity.image?.viewport) validateNativeLayoutViewportReferences(entity.image.viewport, state.references, state.modelArchives ?? new Map());
  }
  return state;
}
