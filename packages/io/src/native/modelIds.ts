// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeChunkError } from './chunks';
import type { NativeColumnBudget } from './columns';
import type { NativePackedModel } from './modelReader';

type ModelIds = Pick<NativePackedModel, 'settings' | 'catalogs' | 'definitions'>;
/** Persistent IDs share one allocator. Body face IDs and imprint IDs are owner-local. */
function* persistentIds(model: ModelIds): Generator<number> {
  yield* model.definitions.keys();
  for (const map of Object.values(model.catalogs.values)) yield* map.keys();
  for (const definition of model.definitions.values()) {
    for (const map of [definition.bodies, definition.meshParts, definition.instances, definition.guides, definition.images,
      definition.sectionPlanes, definition.texts, definition.dimensions]) yield* map.keys();
    const sketch = definition.sketch;
    if (sketch) for (const table of [sketch.vertices, sketch.edges, sketch.faces, sketch.curves]) yield* table.ids;
    for (const body of definition.bodies.values()) { yield* body.curves.ids; yield* body.surfaces.ids; }
  }
}

/** Four temporary bytes per persistent ID, charged to the decode budget; no boxed global Set. */
export function validateNativeModelIds(model: ModelIds, budget: NativeColumnBudget, signal?: AbortSignal): void {
  const nextId = model.settings.meta.nextId;
  if (!Number.isSafeInteger(nextId) || nextId < 1) throw new NativeChunkError('Invalid native next ID');
  let count = 0;
  for (const id of persistentIds(model)) {
    if ((count++ & 4095) === 0) signal?.throwIfAborted();
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || id >= nextId) {
      throw new NativeChunkError('Native persistent ID exceeds allocator');
    }
  }
  const bytes = count * 4;
  budget.reserve(bytes);
  try {
    const ids = new Uint32Array(count); let at = 0;
    for (const id of persistentIds(model)) {
      if ((at & 4095) === 0) signal?.throwIfAborted();
      ids[at++] = id;
    }
    ids.sort();
    for (let i = 1; i < ids.length; i++) {
      if ((i & 4095) === 0) signal?.throwIfAborted();
      if (ids[i] === ids[i - 1]) throw new NativeChunkError('Duplicate native global persistent ID');
    }
    signal?.throwIfAborted();
  } finally { budget.release(bytes); }
}
