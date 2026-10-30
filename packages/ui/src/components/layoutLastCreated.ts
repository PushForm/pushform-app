// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { entityOnPage, entitiesForLayer, type LayoutDocument, type LayoutDocumentState, type LayoutEntity, type LayoutPage } from '@pushform/layout';

function objects(state: LayoutDocumentState): Map<number, LayoutEntity> {
  return new Map([...state.sharedEntities, ...[...state.pages.values()].flatMap(page => [...page.entities])]);
}

/** Session memory follows object creation across pages, edits and workspace remounts. */
const histories = new WeakMap<LayoutDocument, number[]>();
export function trackLayoutCreations(doc: LayoutDocument): void {
  if (histories.has(doc)) return;
  const history: number[] = [];
  histories.set(doc, history);
  let previous = objects(doc.state);
  doc.events.on('change', event => {
    const current = objects(doc.state);
    if (event.source === 'load') history.length = 0;
    else if (event.source === 'transact') {
      for (const id of current.keys()) if (!previous.has(id)) {
        const old = history.indexOf(id);
        if (old !== -1) history.splice(old, 1);
        history.push(id);
      }
    }
    previous = current;
  });
}

export function lastCreatedLayoutObjects(doc: LayoutDocument, page: LayoutPage): LayoutEntity[] {
  const history = histories.get(doc) ?? [];
  for (let index = history.length - 1; index >= 0; index--) {
    const id = history[index]!;
    const source = entityOnPage(page, doc.state, id) ? page : [...doc.state.pages.values()].find(candidate => candidate.entities.has(id));
    if (!source) continue;
    const entity = entityOnPage(source, doc.state, id)!;
    return entity.groupId === undefined ? [entity] : doc.state.layerOrder.flatMap(layerId => entitiesForLayer(source, doc.state, layerId))
      .filter(candidate => candidate.groupId === entity.groupId);
  }
  return [];
}
