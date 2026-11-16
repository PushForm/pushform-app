// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { containerAt, pluginTargetKey, type DocumentState, type EntityRef, type PluginTarget } from '@pushform/model';
import type { InspectorDeclaration } from '@pushform/extension-protocol';
import type { DefId, Id } from '@pushform/core';

/** Build the complete edit set before offering a field: never silently skip unsupported selections. */
export function inspectorTargets(state: DocumentState, refs: readonly EntityRef[], declaration: InspectorDeclaration, scope: 'placement' | 'shared') {
  const targets = new Map<string, PluginTarget>();
  let unsupported = 0, overflow = false;
  let visits = 0;
  const visitedShared = new Set<DefId>();
  const add = (target: PluginTarget) => { targets.set(pluginTargetKey(target), target); if (targets.size > 200) overflow = true; };
  const body = (id: number, path: readonly number[]) => {
    const kind = scope === 'placement' ? 'bodyOccurrence' : 'body';
    if (!declaration.targets.includes(kind)) { unsupported++; return; }
    add(kind === 'body' ? { kind, id } : { kind, id, path: [...path] });
  };
  const visit = (definitionId: DefId, path: number[], seen: Set<number>) => {
    if (++visits > 10000) { overflow = true; return; }
    if (scope === 'shared' && visitedShared.has(definitionId)) return;
    if (seen.has(definitionId) || path.length > 32) { unsupported++; return; }
    const def = state.definitions.get(definitionId);
    if (!def) { unsupported++; return; }
    if (scope === 'shared') visitedShared.add(definitionId);
    for (const id of def.entities.bodies.keys()) { body(id, path); if (overflow) return; }
    const next = new Set([...seen, definitionId]);
    for (const inst of def.entities.instances.values()) { visit(inst.definitionId, [...path, inst.id], next); if (overflow) return; }
    // Non-solid entities are explicitly counted when a plugin is editing the group's parts.
    unsupported += def.entities.meshParts.size;
  };
  for (const ref of refs) {
    const container = containerAt(state, ref.path);
    if (ref.kind === 'body' && container.bodies.has(ref.id)) body(ref.id, ref.path);
    else if (ref.kind === 'instance') {
      const inst = container.instances.get(ref.id), def = inst && state.definitions.get(inst.definitionId);
      if (!inst || !def) { unsupported++; continue; }
      const kind = def.isGroup ? 'group' : 'instance';
      if (declaration.targets.includes(kind)) add({ kind, id: inst.id });
      else if (declaration.targets.includes('definition')) add({ kind: 'definition', id: def.id });
      else visit(inst.definitionId, [...ref.path, inst.id], new Set());
    } else unsupported++;
    if (overflow) break;
  }
  if (declaration.multiSelection === 'none' && targets.size > 1 || declaration.multiSelection === 'homogeneous' && new Set([...targets.values()].map(target => target.kind)).size > 1) unsupported = Math.max(1, unsupported);
  return { targets: [...targets.values()].slice(0, 200), unsupported, overflow };
}

/** Count repeated placements by definition, without expanding every occurrence in a repeated assembly. */
export function inspectorPlacementCount(state: DocumentState, targets: readonly PluginTarget[]): number {
  const bodies = new Set(targets.filter(target => target.kind === 'body' || target.kind === 'bodyOccurrence').map(target => 'id' in target ? target.id : 0));
  const memo = new Map<DefId, number>(), active = new Set<DefId>();
  const count = (id: DefId): number => {
    const known = memo.get(id); if (known !== undefined) return known;
    if (active.has(id) || active.size > 32) throw new Error('This model has a recursive or excessively deep component hierarchy.');
    active.add(id);
    const def = state.definitions.get(id);
    let total = [...def?.entities.bodies.keys() ?? []].filter(body => bodies.has(body)).length;
    for (const inst of def?.entities.instances.values() ?? []) { total += count(inst.definitionId); if (!Number.isSafeInteger(total)) throw new Error('The placement count is too large to edit safely.'); }
    active.delete(id); memo.set(id, total); return total;
  };
  return bodies.size ? count(state.rootDefinitionId) : targets.length;
}

export function inspectorNoticeTargets(state: DocumentState, refs: readonly EntityRef[]): Set<string> {
  const keys = new Set<string>();
  const selection = inspectorTargets(state, refs, { targets: ['bodyOccurrence'], multiSelection: 'mixed' }, 'placement');
  for (const target of selection.targets) {
    keys.add(pluginTargetKey(target));
    if (target.kind !== 'bodyOccurrence') continue;
    keys.add(pluginTargetKey({ kind: 'body', id: target.id }));
    const container = containerAt(state, target.path as Id[]), body = container.bodies.get(target.id as Id);
    let material = body?.materialId;
    if (material == null) for (let length = target.path.length; length > 0; length--) {
      material = containerAt(state, target.path.slice(0, length - 1) as Id[]).instances.get(target.path[length - 1]! as Id)?.materialId;
      if (material != null) break;
    }
    keys.add(pluginTargetKey({ kind: 'material', id: material ?? state.defaultMaterialId }));
  }
  for (const ref of refs) if (ref.kind === 'instance') {
    const inst = containerAt(state, ref.path).instances.get(ref.id);
    if (inst) {
      keys.add(pluginTargetKey({ kind: 'instance', id: inst.id }));
      keys.add(pluginTargetKey({ kind: 'group', id: inst.id }));
      keys.add(pluginTargetKey({ kind: 'definition', id: inst.definitionId }));
    }
  }
  if (!refs.length) keys.add('document');
  return keys;
}
