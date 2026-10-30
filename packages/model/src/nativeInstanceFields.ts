// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { DefId, Id } from '@pushform/core';
import type { ComponentInstance } from './entities/definition';
import type { DocumentState } from './entities/document';

function stale(instance: ComponentInstance): boolean {
  const extra = instance.nativeUnknownFields;
  if (!extra) return false;
  const fields = extra.extensions;
  return (!Object.hasOwn(instance, 'gluedPlane') && !!fields?.has('gluedPlane')) ||
    ((!Object.hasOwn(instance, 'gluedPlane') || instance.gluedPlane !== undefined) && !!fields?.has('gluedPlane.undefined'));
}

/** Only inspect placements touched by authored patches; replacement containers inspect their own members. */
export function reconcileNativeInstanceFields(state: DocumentState, patches: readonly Patch[]): [DocumentState, Patch[], Patch[]] | null {
  const touched = nativeEntityPatchTargets(state, patches, 'instances');
  const cleanup: [DefId, Id][] = [];
  for (const [definitionId, ids] of touched) {
    const instances = state.definitions.get(definitionId)?.entities.instances;
    if (!instances) continue;
    for (const id of ids ?? instances.keys()) {
      const instance = instances.get(id);
      if (instance && stale(instance)) cleanup.push([definitionId, id]);
    }
  }
  if (!cleanup.length) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const [definitionId, id] of cleanup) {
      const instance = draft.definitions.get(definitionId)!.entities.instances.get(id)!;
      const extra = instance.nativeUnknownFields!, fields = extra.extensions!;
      if (!Object.hasOwn(instance, 'gluedPlane')) fields.delete('gluedPlane');
      if (!Object.hasOwn(instance, 'gluedPlane') || instance.gluedPlane !== undefined) fields.delete('gluedPlane.undefined');
      if (!fields.size) delete extra.extensions;
      if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.extensions) delete instance.nativeUnknownFields;
    }
  });
  return [next, forward, inverse];
}

/** Definition/container replacements affect their own members; unrelated geometry patches are skipped. */
export function nativeEntityPatchTargets(state: DocumentState, patches: readonly Patch[], kind: 'instances' | 'dimensions'): Map<DefId, Set<Id> | null> {
  const touched = new Map<DefId, Set<Id> | null>();
  for (const { path } of patches) {
    if (path[0] !== 'definitions') continue;
    if (path.length === 1) { for (const id of state.definitions.keys()) touched.set(id, null); break; }
    const id = path[1] as DefId;
    if (path.length > 2 && path[2] !== 'entities') continue;
    if (path.length > 3 && path[3] !== kind) continue;
    if (path.length <= 4) { touched.set(id, null); continue; }
    if (touched.get(id) === null) continue;
    const ids = touched.get(id) ?? new Set<Id>(); ids.add(path[4] as Id); touched.set(id, ids);
  }
  return touched;
}
