// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { DefId } from '@pushform/core';
import type { DocumentState } from '../entities/document';
import type { Sketch } from '../entities/sketch';
import { materializeSketchVertexHash } from './vertexIndex';

/** Direct vertex replacements also invalidate native proximity data before publication. */
export function reconcilePackedVertexIndexes(state: DocumentState, patches: readonly Patch[]): [DocumentState, Patch[], Patch[]] | null {
  const touched = new Set<DefId>();
  for (const { path } of patches) {
    if (path[0] !== 'definitions' || (path.length > 2 && path[2] !== 'entities') ||
        (path.length > 3 && path[3] !== 'sketch') || (path.length > 4 && path[4] !== 'vertices')) continue;
    for (const id of path.length < 2 ? state.definitions.keys() : [path[1] as DefId]) {
      if (state.definitions.get(id)?.entities.sketch.packedVertexIndex) touched.add(id);
    }
  }
  if (!touched.size) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const id of touched) materializeSketchVertexHash(draft.definitions.get(id)!.entities.sketch as unknown as Sketch);
  });
  return [next, forward, inverse];
}
