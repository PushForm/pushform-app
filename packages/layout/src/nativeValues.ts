// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { current, isDraft } from 'immer';

/** Copy editable values without erasing Maps, byte arrays or explicit undefined fields. */
export function cloneLayoutValue<T>(value: T): T {
  const copy = structuredClone(isDraft(value) ? current(value) : value);
  // Structured clone resets null prototypes. Immer's replacement-patch cloning
  // uses assignment, so an own __proto__ key needs a null-prototype dictionary.
  const visited = new WeakSet<object>();
  const prepare = (item: unknown): void => {
    if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || visited.has(item)) return;
    visited.add(item);
    if (item instanceof Map) {
      for (const [key, entry] of item) { prepare(key); prepare(entry); }
    } else if (item instanceof Set || Array.isArray(item)) {
      for (const entry of item) prepare(entry);
    } else {
      if (Object.hasOwn(item, '__proto__')) Object.setPrototypeOf(item, null);
      for (const key in item) if (Object.hasOwn(item, key)) prepare((item as Record<string, unknown>)[key]);
    }
  };
  prepare(copy);
  return copy;
}

/** Exact content equality for plain Layout values, independent of map/property insertion order. */
export function layoutValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array &&
    a.length === b.length && a.every((value, i) => value === b[i]);
  if (a instanceof Map || b instanceof Map) return a instanceof Map && b instanceof Map && a.size === b.size &&
    [...a].every(([key, value]) => b.has(key) && layoutValuesEqual(value, b.get(key)));
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) &&
    layoutValuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
