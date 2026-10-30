// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produce } from 'immer';
import type { LayoutDocumentState, LayoutEntity } from './LayoutDocument';

/** Structured clone restores Object.prototype; normalize special dictionaries before Immer owns them. */
export function prepareNativeAnnotationDictionaries(state: LayoutDocumentState): LayoutDocumentState {
  const owners: { pageId: number; id: number; key: 'modelAnnotation' | 'preservedModelConnections' }[] = [];
  const inspect = (entities: ReadonlyMap<number, LayoutEntity>, pageId: number) => {
    for (const [id, entity] of entities) for (const key of ['modelAnnotation', 'preservedModelConnections'] as const) {
      const fields = entity[key]?.fields;
      if (fields && Object.hasOwn(fields, '__proto__') && Object.getPrototypeOf(fields) !== null) owners.push({ pageId, id, key });
    }
  };
  inspect(state.sharedEntities, 0);
  for (const [pageId, page] of state.pages) inspect(page.entities, pageId);
  if (!owners.length) return state;
  return produce(state, draft => {
    for (const { pageId, id, key } of owners) {
      const owner = (pageId === 0 ? draft.sharedEntities : draft.pages.get(pageId)!.entities).get(id)![key]!;
      owner.fields = Object.assign(Object.create(null) as Record<string, string>, owner.fields);
    }
  });
}

/** Auto-Text entry fields follow exact authored names, including slashes and prototype-like names. */
export function reconcileNativeAnnotationFields(annotation: NonNullable<LayoutEntity['modelAnnotation'] | LayoutEntity['preservedModelConnections']>, apply = false): boolean {
  const extra = annotation.nativeUnknownFields;
  if (!extra?.extensions) return false;
  let changed = false;
  for (const key of extra.extensions.keys()) {
    const obsolete = key === 'fields' ? !Object.hasOwn(annotation, 'fields') : key.startsWith('fields/') &&
      (!annotation.fields || !Object.hasOwn(annotation.fields, key.slice('fields/'.length)));
    if (obsolete) { changed = true; if (apply) extra.extensions.delete(key); }
  }
  if (apply && !extra.extensions.size) {
    delete extra.extensions;
    if (!extra.envelope?.length && !extra.outerEnvelope?.length) delete annotation.nativeUnknownFields;
  }
  return changed;
}
