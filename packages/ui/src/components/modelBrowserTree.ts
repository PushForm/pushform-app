// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id } from '@pushform/core';
import { entityRefKey, pathKey } from '@pushform/model';
import type { ComponentDefinition, ComponentInstance, DocumentState, EntityContainer, EntityRef } from '@pushform/model';

/** What a Model object browser item lists. */
export type ModelBrowserKind = 'group' | 'component' | 'solid';

/** One item of the Model object browser tree; `key` is the `entityRefKey` of its ref, so it matches selection keys. */
export interface ModelBrowserNode {
  readonly key: string;
  /** 1-based tree depth (`aria-level`). */
  readonly level: number;
  readonly kind: ModelBrowserKind;
  readonly label: string;
  /** A component instance named apart from its definition shows the definition name too. */
  readonly definitionName?: string;
  readonly ref: EntityRef;
  /** Groups and components: the instance path that `context.enter` takes. */
  readonly fullPath?: readonly Id[];
  readonly parent: string | null;
  readonly children: readonly ModelBrowserNode[];
  /** The item's own hidden flag (its eye button). */
  readonly hidden: boolean;
  /** Inside a hidden group or component, so not drawn even when shown itself. */
  readonly inHidden: boolean;
  /** Groups and components only; solids have no lock. */
  readonly locked?: boolean;
  /** The instance has its own name, so an empty rename restores the definition name. */
  readonly custom?: boolean;
  readonly selected: boolean;
  /** The group or component open for editing. */
  readonly current: boolean;
}

/** Display name of an instance: its own name, else its definition's. */
export function instanceLabel(inst: ComponentInstance, def: ComponentDefinition): string {
  return inst.name || def.name;
}

/** "Solid N" numbers every solid of the model from 1 in creation (id) order; a component's solids keep one number. */
export function solidNumbers(state: Pick<DocumentState, 'definitions'>): Map<Id, number> {
  const ids: Id[] = [];
  for (const def of state.definitions.values()) for (const id of def.entities.bodies.keys()) ids.push(id);
  return new Map(ids.sort((a, b) => a - b).map((id, index) => [id, index + 1]));
}

/** A container's solids and instances in creation order (`order`), with any not listed there appended. */
function orderedEntities(container: EntityContainer): ({ kind: 'body'; id: Id } | { kind: 'instance'; inst: ComponentInstance })[] {
  const seen = new Set<Id>();
  const out: ({ kind: 'body'; id: Id } | { kind: 'instance'; inst: ComponentInstance })[] = [];
  const take = (id: Id): void => {
    if (seen.has(id)) return;
    const inst = container.instances.get(id);
    if (inst) { seen.add(id); out.push({ kind: 'instance', inst }); } else if (container.bodies.has(id)) { seen.add(id); out.push({ kind: 'body', id }); }
  };
  for (const id of container.order) take(id);
  for (const id of container.bodies.keys()) take(id);
  for (const id of container.instances.keys()) take(id);
  return out;
}

/**
 * The model's tree: the root's solids, groups and components, each group or component holding its definition's
 * in turn. A definition already on the current path is not descended into again, so a self-containing one is a leaf.
 */
export function modelBrowserTree(state: Pick<DocumentState, 'definitions' | 'rootDefinitionId'>, contextPath: readonly Id[], selectedKeys: ReadonlySet<string>): ModelBrowserNode[] {
  const root = state.definitions.get(state.rootDefinitionId);
  if (!root) return [];
  const numbers = solidNumbers(state);
  const contextKey = pathKey(contextPath);
  const build = (container: EntityContainer, path: readonly Id[], level: number, parent: string | null, inHidden: boolean, seen: ReadonlySet<number>): ModelBrowserNode[] =>
    orderedEntities(container).flatMap((entry): ModelBrowserNode[] => {
      if (entry.kind === 'body') {
        const body = container.bodies.get(entry.id)!;
        const ref: EntityRef = { kind: 'body', path, id: entry.id };
        const key = entityRefKey(ref);
        return [{ key, level, kind: 'solid', label: `Solid ${numbers.get(entry.id) ?? ''}`, ref, parent, children: [],
          hidden: body.hidden, inHidden, selected: selectedKeys.has(key), current: false }];
      }
      const { inst } = entry;
      const def = state.definitions.get(inst.definitionId);
      if (!def) return [];
      const ref: EntityRef = { kind: 'instance', path, id: inst.id };
      const key = entityRefKey(ref), fullPath = [...path, inst.id], label = instanceLabel(inst, def);
      const children = seen.has(def.id) ? [] : build(def.entities, fullPath, level + 1, key, inHidden || inst.hidden, new Set([...seen, def.id]));
      return [{ key, level, kind: def.isGroup ? 'group' : 'component', label, ...(!def.isGroup && label !== def.name ? { definitionName: def.name } : {}),
        ref, fullPath, parent, children, hidden: inst.hidden, inHidden, locked: inst.locked, custom: Boolean(inst.name), selected: selectedKeys.has(key),
        current: contextPath.length > 0 && pathKey(fullPath) === contextKey }];
    });
  return build(root.entities, [], 1, null, false, new Set([root.id]));
}
