// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Manifold } from 'manifold-3d';
import type { ReadMesh } from './meshio';

/** A cached body: the Manifold handle, its originalID and (lazily) its triangles in world coordinates. */
export interface CacheEntry {
  manifold: Manifold;
  runId: number;
  mesh?: ReadMesh;
}

export const cacheKey = (bodyId: number, version: number): string => `${bodyId}:${version}`;

/**
 * LRU of Manifold handles keyed `${bodyId}:${version}`. Manifold objects live in wasm memory and are
 * not garbage collected, so eviction and removal call `delete()`.
 */
export class ManifoldCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly capacity = 64) {}

  get size(): number {
    return this.entries.size;
  }

  /** Returns the entry and marks it most recently used. */
  get(bodyId: number, version: number): CacheEntry | undefined {
    const key = cacheKey(bodyId, version);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  has(bodyId: number, version: number): boolean {
    return this.entries.has(cacheKey(bodyId, version));
  }

  /** Inserts (replacing and freeing any previous handle), evicting the least recently used entries. */
  set(bodyId: number, version: number, entry: CacheEntry): void {
    const key = cacheKey(bodyId, version);
    const prev = this.entries.get(key);
    if (prev !== undefined && prev.manifold !== entry.manifold) prev.manifold.delete();
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /** Frees one version, or every version of a body when `version` is omitted. Returns the count freed. */
  release(bodyId: number, version?: number): number {
    if (version !== undefined) return this.remove(cacheKey(bodyId, version)) ? 1 : 0;
    const prefix = `${bodyId}:`;
    let n = 0;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix) && this.remove(key)) n++;
    return n;
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    entry.manifold.delete();
    return true;
  }
}
