// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { DefId, Id } from '@pushform/core';
import type { Dimension } from './entities/misc';
import type { DocumentState } from './entities/document';
import { nativeEntityPatchTargets } from './nativeInstanceFields';

function obsolete(value: Dimension): string[] {
  const fields = value.nativeUnknownFields?.extensions;
  if (!fields) return [];
  const keys: string[] = [];
  if (!Object.hasOwn(value, 'anchors')) keys.push('anchors');
  for (const [index, scope] of ['anchors.start', 'anchors.end'].entries()) {
    if (value.anchors === undefined || value.anchors[index] !== null) keys.push(scope);
  }
  if (!Object.hasOwn(value, 'curve') || value.curve !== undefined) keys.push('curve');
  return keys.filter(key => fields.has(key));
}

export function reconcileNativeDimensionFields(state: DocumentState, patches: readonly Patch[]): [DocumentState, Patch[], Patch[]] | null {
  const cleanup: [DefId, Id, string[]][] = [];
  for (const [definitionId, ids] of nativeEntityPatchTargets(state, patches, 'dimensions')) {
    const dimensions = state.definitions.get(definitionId)?.entities.dimensions;
    if (!dimensions) continue;
    for (const id of ids ?? dimensions.keys()) {
      const value = dimensions.get(id), keys = value ? obsolete(value) : [];
      if (keys.length) cleanup.push([definitionId, id, keys]);
    }
  }
  if (!cleanup.length) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const [definitionId, id, keys] of cleanup) {
      const value = draft.definitions.get(definitionId)!.entities.dimensions.get(id)!, extra = value.nativeUnknownFields!;
      for (const key of keys) extra.extensions!.delete(key);
      if (!extra.extensions!.size) delete extra.extensions;
      if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.extensions) delete value.nativeUnknownFields;
    }
  });
  return [next, forward, inverse];
}
