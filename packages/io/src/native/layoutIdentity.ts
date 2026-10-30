// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState } from '@pushform/layout';
import { Fingerprint } from './modelIdentity';

const identities = new WeakMap<LayoutDocumentState, string>();

/** Saved-state identity without retaining JSON or copying embedded asset strings.
 * The allocator is monotonic bookkeeping; all authored state remains significant.
 * Object/Map insertion order is ignored; explicit order arrays retain display order.
 */
export function layoutContentIdentity(state: LayoutDocumentState): string {
  const cached = identities.get(state); if (cached) return cached;
  const stream = new Fingerprint((object, key) => object === state.meta && key === 'nextId');
  stream.write('pushform-layout-content-v1'); stream.write(state);
  const result = `pf-layout-v1-sha256:${Array.from(stream.finish(), b => b.toString(16).padStart(2, '0')).join('')}`;
  if (Object.isFrozen(state)) identities.set(state, result);
  return result;
}
