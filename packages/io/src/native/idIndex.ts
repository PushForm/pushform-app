// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeChunkError } from './chunks';
import type { NativeColumnBudget } from './columns';

/** Sorted row permutation: four retained bytes per ID, without changing source iteration order. */
export class NativeIdIndex {
  private readonly rows: Uint32Array;
  constructor(private readonly ids: Uint32Array, budget: NativeColumnBudget, signal?: AbortSignal) {
    signal?.throwIfAborted(); budget.reserve(ids.byteLength);
    try {
      this.rows = new Uint32Array(ids.length);
      for (let row = 0; row < ids.length; row++) this.rows[row] = row;
      this.rows.sort((a, b) => ids[a]! - ids[b]!);
      for (let i = 1; i < this.rows.length; i++) if (ids[this.rows[i]!] === ids[this.rows[i - 1]!]) throw new NativeChunkError('Duplicate native indexed ID');
      signal?.throwIfAborted();
    } catch (error) { budget.release(ids.byteLength); throw error; }
  }
  /** Source ID columns must remain immutable for the lifetime of this index. */
  find(id: number): number {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) return -1;
    let low = 0, high = this.rows.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2), row = this.rows[mid]!, value = this.ids[row]!;
      if (value < id) low = mid + 1; else if (value > id) high = mid; else return row;
    }
    return -1;
  }
  has(id: number): boolean { return this.find(id) !== -1; }
}
