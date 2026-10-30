// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState, LayoutEntity } from './LayoutDocument';
import { isViewport } from './viewports';

/** Object browser kinds; default names are "<Kind> <n>". */
export type LayoutObjectKind = 'Line' | 'Shape' | 'Text' | 'Label' | 'Dimension' | 'Image' | 'View' | 'Table';

/** Longest custom object name after trimming. */
export const LAYOUT_OBJECT_NAME_MAX = 100;

/** A straight two-point open path is a line; every other path is a shape; a model view is a view. */
export function layoutObjectKind(entity: LayoutEntity): LayoutObjectKind {
  switch (entity.kind) {
    case 'path':
      return !entity.closed && entity.points.length === 2 && !(entity.handles ?? []).some(handle => handle.in || handle.out)
        ? 'Line' : 'Shape';
    case 'text': return 'Text';
    case 'label': return 'Label';
    case 'dimension':
    case 'angular-dimension': return 'Dimension';
    case 'image': return isViewport(entity) ? 'View' : 'Image';
    case 'table': return 'Table';
  }
}

/** Numbers each kind from 1 across the document in creation order; custom names still consume a number. */
export function layoutDefaultObjectNames(state: LayoutDocumentState): Map<number, string> {
  const entities = [...state.sharedEntities.values(), ...[...state.pages.values()].flatMap(page => [...page.entities.values()])]
    .sort((a, b) => a.id - b.id);
  const counts = new Map<LayoutObjectKind, number>(), names = new Map<number, string>();
  for (const entity of entities) {
    const kind = layoutObjectKind(entity), n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    names.set(entity.id, `${kind} ${n}`);
  }
  return names;
}

/** The trimmed custom name, else the default name. */
export function layoutObjectName(entity: LayoutEntity, defaults: ReadonlyMap<number, string>): string {
  const custom = entity.name?.trim();
  return custom ? custom : defaults.get(entity.id) ?? `${layoutObjectKind(entity)} ${entity.id}`;
}
