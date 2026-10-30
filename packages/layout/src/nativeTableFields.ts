// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutTable } from './LayoutDocument';
import { reconcileNativeTextFields } from './nativeTextFields';

/** Prune removed optional records in the same transaction as the authored table edit. */
export function reconcileNativeTableFields(table: LayoutTable, apply = false): boolean {
  let changed = false;
  const prune = (owner: { nativeUnknownFields?: { extensions?: Map<string, Uint8Array[]>; envelope?: Uint8Array[]; outerEnvelope?: Uint8Array[] } }, keys: string[]) => {
    const extra = owner.nativeUnknownFields;
    for (const key of keys) if (!Object.hasOwn(owner, key) && extra?.extensions?.has(key)) {
      changed = true; if (apply) extra.extensions.delete(key);
    }
    if (apply && extra) {
      if (extra.extensions && !extra.extensions.size) delete extra.extensions;
      if (!extra.extensions && !extra.envelope?.length && !extra.outerEnvelope?.length) delete owner.nativeUnknownFields;
    }
  };
  prune(table, ['rowEdges', 'columnEdges']);
  for (const cell of table.cells) {
    prune(cell, ['fillColor']);
    if (reconcileNativeTextFields(cell.text, apply)) changed = true;
  }
  return changed;
}
