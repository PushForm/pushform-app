// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import type { AttributeDictionaries, CommonAttrs } from './entities/common';
import type { DocumentState } from './entities/document';

/** Resolve codec scopes by exact authored keys, never by splitting quoted keys on slashes. */
export function nativeAttributeScope(attributes: AttributeDictionaries, path: string): 'present' | 'missing' | 'indexed' {
  const parts: (string | { key: string })[] = [];
  while (path.length) {
    if (path[0] !== '/') return 'missing';
    path = path.slice(1);
    if (path[0] === '"') {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(path);
      if (!match) return 'missing';
      try { parts.push({ key: JSON.parse(match[0]) as string }); } catch { return 'missing'; }
      path = path.slice(match[0].length);
    } else {
      const end = path.indexOf('/');
      parts.push(end < 0 ? path : path.slice(0, end));
      path = end < 0 ? '' : path.slice(end);
    }
  }
  let value: unknown = attributes, dictionary = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (typeof part !== 'object' || !value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part.key)) return 'missing';
    value = (value as Record<string, unknown>)[part.key];
    if (++i === parts.length) return dictionary ? 'missing' : 'present';
    const scope = parts[i];
    if (scope === 'entry') return i === parts.length - 1 ? 'present' : 'missing';
    if (scope === 'null') return !dictionary && value === null && i === parts.length - 1 ? 'present' : 'missing';
    if (scope === 'list') {
      if (dictionary || !Array.isArray(value)) return 'missing';
      return i === parts.length - 1 ? 'present' : 'indexed';
    }
    if (scope !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return 'missing';
    dictionary = false;
  }
  return 'present';
}

const branches = ['definitions', 'entities', 'bodies', 'sketch', 'edges', 'faces', 'instances', 'guides', 'images', 'sectionPlanes', 'texts', 'dimensions'] as const;
type Path = Patch['path'];
function at(state: unknown, path: Path): unknown {
  for (const key of path) state = state instanceof Map ? state.get(key) : state && typeof state === 'object' ? (state as Record<string | number, unknown>)[key] : undefined;
  return state;
}

/** Prune removed named owners in the authored transaction, without visiting unrelated geometry. */
export function reconcileNativeAttributeFields(state: DocumentState, patches: readonly Patch[]): [DocumentState, Patch[], Patch[]] | null {
  const cleanup: { path: Path; keys: string[] }[] = [], visited = new WeakSet<object>();
  const inspect = (value: unknown, path: Path): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Object.hasOwn(value, 'attributes')) {
      const owner = value as CommonAttrs, extra = owner.nativePropertyUnknownFields?.attributes;
      const keys = extra ? [...extra.keys()].filter(key => nativeAttributeScope(owner.attributes, key) === 'missing') : [];
      if (keys.length) cleanup.push({ path, keys });
      return;
    }
    if (value instanceof Map) { for (const [key, child] of value) inspect(child, [...path, key]); }
    else for (const key of branches) if (Object.hasOwn(value, key)) inspect((value as Record<string, unknown>)[key], [...path, key]);
  };
  for (const { path } of patches) {
    if (path[0] !== 'definitions') continue;
    const ownerLength = path[3] === 'sketch' ? 6 : 5;
    if (path.length > ownerLength && path[ownerLength] !== 'attributes' && path[ownerLength] !== 'nativePropertyUnknownFields') continue;
    const prefix = path.slice(0, ownerLength);
    inspect(at(state, prefix), prefix);
  }
  if (!cleanup.length) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const { path, keys } of cleanup) {
      const owner = at(draft, path) as CommonAttrs, extra = owner.nativePropertyUnknownFields!;
      for (const key of keys) extra.attributes!.delete(key);
      if (!extra.attributes!.size) delete extra.attributes;
      if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.unknownFields?.length && !extra.fields?.length && !extra.attributes) delete owner.nativePropertyUnknownFields;
    }
  });
  return [next, forward, inverse];
}
