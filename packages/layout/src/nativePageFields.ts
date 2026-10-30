// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { LayoutDocumentState } from './LayoutDocument';

/** Reconcile only pages touched by authored patches, including replaced page containers. */
export function reconcileNativePageFields(state: LayoutDocumentState, patches: readonly Patch[]): [LayoutDocumentState, Patch[], Patch[]] | null {
  const ids = new Set<number>();
  for (const { path } of patches) {
    if (path[0] !== 'pages') continue;
    if (path.length === 1) { for (const id of state.pages.keys()) ids.add(id); break; }
    ids.add(path[1] as number);
  }
  const cleanup = new Map<number, string[]>();
  for (const id of ids) {
    const page = state.pages.get(id), fields = page?.nativeUnknownFields?.extensions;
    if (!page || !fields) continue;
    const keys = [...fields.keys()].filter(key => key === 'layerVisibility' ? !Object.hasOwn(page, 'layerVisibility') :
      key.startsWith('visibility/') && !page.layerVisibility?.has(Number(key.slice('visibility/'.length))));
    if (keys.length) cleanup.set(id, keys);
  }
  if (!cleanup.size) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const [id, keys] of cleanup) {
      const page = draft.pages.get(id)!, extra = page.nativeUnknownFields!;
      for (const key of keys) extra.extensions!.delete(key);
      if (!extra.extensions!.size) delete extra.extensions;
      if (!extra.envelopeUnknown?.length && !extra.extensions) delete page.nativeUnknownFields;
    }
  });
  return [next, forward, inverse];
}
