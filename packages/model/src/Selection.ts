// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter } from '@pushform/core';
import { entityRefKey, type EntityRef } from './entities/common';

export type SelectionEvents = { change: { refs: EntityRef[] } };

/** Runtime-only selection: a set of EntityRefs keyed by `entityRefKey`. Never part of the document state. */
export class Selection implements Iterable<EntityRef> {
  private items = new Map<string, EntityRef>();
  readonly events = new Emitter<SelectionEvents>();

  get size(): number {
    return this.items.size;
  }
  get isEmpty(): boolean {
    return this.items.size === 0;
  }
  /** Current refs in insertion order (a fresh array). */
  get refs(): EntityRef[] {
    return [...this.items.values()];
  }
  [Symbol.iterator](): Iterator<EntityRef> {
    return this.items.values();
  }
  has(ref: EntityRef): boolean {
    return this.items.has(entityRefKey(ref));
  }
  get(key: string): EntityRef | undefined {
    return this.items.get(key);
  }

  add(refs: EntityRef | Iterable<EntityRef>): void {
    let changed = false;
    for (const r of iter(refs)) {
      const k = entityRefKey(r);
      if (!this.items.has(k)) {
        this.items.set(k, r);
        changed = true;
      }
    }
    if (changed) this.emit();
  }
  remove(refs: EntityRef | Iterable<EntityRef>): void {
    let changed = false;
    for (const r of iter(refs)) changed = this.items.delete(entityRefKey(r)) || changed;
    if (changed) this.emit();
  }
  toggle(refs: EntityRef | Iterable<EntityRef>): void {
    for (const r of iter(refs)) {
      const k = entityRefKey(r);
      if (this.items.has(k)) this.items.delete(k);
      else this.items.set(k, r);
    }
    this.emit();
  }
  /** Replace the selection wholesale. */
  set(refs: Iterable<EntityRef>): void {
    this.items.clear();
    for (const r of refs) this.items.set(entityRefKey(r), r);
    this.emit();
  }
  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.emit();
  }
  /** Immutable snapshot for undo entries. */
  snapshot(): EntityRef[] {
    return this.refs;
  }
  restore(refs: readonly EntityRef[]): void {
    this.set(refs);
  }

  private emit(): void {
    this.events.emit('change', { refs: this.refs });
  }
}

function iter(refs: EntityRef | Iterable<EntityRef>): Iterable<EntityRef> {
  return 'kind' in refs ? [refs] : refs;
}
