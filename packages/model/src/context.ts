// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4identity, m4invert, m4mul } from '@pushform/core';
import type { Id, MMat4, Mat4 } from '@pushform/core';
import type { ComponentDefinition, ComponentInstance, EntityContainer } from './entities/definition';
import type { DocumentState } from './entities/document';
import type { EditContext } from './entities/common';

/** Stable string key for an instance path (empty path = root). */
export const pathKey = (path: readonly Id[]): string => path.join('.');

/** Instance at `path` (the last id), or null at the root. Throws when a step does not exist. */
export function instanceAt(state: DocumentState, path: readonly Id[]): ComponentInstance | null {
  let def = state.definitions.get(state.rootDefinitionId);
  let inst: ComponentInstance | null = null;
  for (const id of path) {
    const next = def?.entities.instances.get(id);
    if (!next) throw new Error(`instanceAt: no instance ${id} on path ${pathKey(path)}`);
    inst = next;
    def = state.definitions.get(next.definitionId);
  }
  return inst;
}

/** Definition whose entities are being edited at `path` (root definition for the empty path). */
export function definitionAt(state: DocumentState, path: readonly Id[]): ComponentDefinition {
  const inst = instanceAt(state, path);
  const id = inst ? inst.definitionId : state.rootDefinitionId;
  const def = state.definitions.get(id);
  if (!def) throw new Error(`definitionAt: missing definition ${id}`);
  return def;
}

export function containerAt(state: DocumentState, path: readonly Id[]): EntityContainer {
  return definitionAt(state, path).entities;
}

export function contextAt(state: DocumentState, path: readonly Id[]): EditContext {
  return { path: [...path], definitionId: definitionAt(state, path).id };
}

/** Accumulated local→world matrix of the context at `path` (identity at the root). */
export function contextMatrix(state: DocumentState, path: readonly Id[]): MMat4 {
  let m: MMat4 = m4identity();
  let def = state.definitions.get(state.rootDefinitionId);
  for (const id of path) {
    const inst = def?.entities.instances.get(id);
    if (!inst) throw new Error(`contextMatrix: no instance ${id} on path ${pathKey(path)}`);
    m = m4mul(m, inst.transform as Mat4);
    def = state.definitions.get(inst.definitionId);
  }
  return m;
}

/** World→local matrix of the context at `path`. */
export function contextInverse(state: DocumentState, path: readonly Id[]): MMat4 {
  const inv = m4invert(contextMatrix(state, path));
  if (!inv) throw new Error(`contextInverse: singular transform on path ${pathKey(path)}`);
  return inv;
}

export interface InstanceVisit {
  readonly path: readonly Id[];
  readonly instance: ComponentInstance;
  readonly definition: ComponentDefinition;
  /** local→world matrix of the instance's definition entities. */
  readonly matrix: MMat4;
  readonly depth: number;
}

/**
 * Depth-first walk over every instance reachable from the root (or from `from`), with the
 * accumulated transform. Cycles (a definition containing itself) are skipped.
 */
export function* walkInstances(state: DocumentState, from: readonly Id[] = []): Generator<InstanceVisit> {
  const start = definitionAt(state, from);
  const stack: Array<{ path: Id[]; def: ComponentDefinition; matrix: MMat4; depth: number; seen: Set<number> }> = [
    { path: [...from], def: start, matrix: contextMatrix(state, from), depth: from.length, seen: new Set([start.id]) },
  ];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const inst of cur.def.entities.instances.values()) {
      const def = state.definitions.get(inst.definitionId);
      if (!def || cur.seen.has(def.id)) continue;
      const path = [...cur.path, inst.id];
      const matrix = m4mul(cur.matrix, inst.transform as Mat4);
      yield { path, instance: inst, definition: def, matrix, depth: path.length };
      stack.push({ path, def, matrix, depth: path.length, seen: new Set([...cur.seen, def.id]) });
    }
  }
}

/** True when `path` starts with `prefix` (an entity at `path` lives inside the context `prefix`). */
export function pathWithin(path: readonly Id[], prefix: readonly Id[]): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}
