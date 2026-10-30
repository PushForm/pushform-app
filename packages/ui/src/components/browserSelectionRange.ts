// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Rows between the anchor and endpoint, including descendants of collapsed rows. */
export function browserSelectionRange<T extends { readonly key: string; readonly children: readonly T[] }>(
  visible: readonly T[], anchor: string | null, endpoint: T,
): T[] {
  const start = visible.findIndex(node => node.key === anchor);
  const end = visible.findIndex(node => node.key === endpoint.key);
  const rows = start < 0 || end < 0 ? [endpoint] : visible.slice(Math.min(start, end), Math.max(start, end) + 1);
  const result = new Map<string, T>();
  const visit = (node: T): void => { result.set(node.key, node); node.children.forEach(visit); };
  rows.forEach(visit);
  return [...result.values()];
}
