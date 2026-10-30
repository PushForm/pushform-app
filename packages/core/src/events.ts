// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }
  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<Events[K]>)(payload);
  }
  clear(): void {
    this.listeners.clear();
  }
}
