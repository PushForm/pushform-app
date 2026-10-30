// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState } from '@pushform/layout';
import { assertLayoutState } from './layoutFile';

/** Imported XML can contain literal NaN values or produce infinity through camera math.
 * Reject these before installing editable state; preserve source strings without interpreting
 * opaque archives or annotation snapshots. The walk retains only its current ancestry.
 */
export function validateImportedLayoutState(state: unknown): LayoutDocumentState {
  const path: string[] = ['state'];
  const active = new Set<object>();
  const fail = (reason: string): never => {
    throw new Error(`Cannot import LayOut: ${reason} at ${path.join('')}. Repair the source drawing and save a new copy in LayOut.`);
  };
  const visit = (value: unknown): void => {
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('nonfinite numeric data'); return; }
    if (value === null || typeof value !== 'object') return;
    if (active.has(value) || active.size >= 256) fail('cyclic or excessively nested data');
    active.add(value);
    try {
      if (value instanceof Map) {
        for (const [key, item] of value) {
          path.push(`[${String(key)}]`); visit(key); visit(item); path.pop();
        }
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) { path.push(`[${i}]`); visit(value[i]); path.pop(); }
      } else {
        for (const key of Object.keys(value)) { path.push(`.${key}`); visit((value as Record<string, unknown>)[key]); path.pop(); }
      }
    } finally { active.delete(value); }
  };
  visit(state);
  return assertLayoutState(state);
}
