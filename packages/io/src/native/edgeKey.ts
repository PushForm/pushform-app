// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { EdgeKey } from '@pushform/model';
import { NativeChunkError } from './chunks';
import type { NativeColumnBudget } from './columns';
const fail = (): never => { throw new NativeChunkError('Invalid native body edge key'); };
export function parseNativeEdgeKey(key: EdgeKey): [number, number, number] {
  if (!/^(0|[1-9]\d*):(0|[1-9]\d*):(0|[1-9]\d*)$/.test(key)) return fail();
  const values = key.split(':').map(Number);
  for (const n of values) if (!Number.isInteger(n) || n > 0xffff_ffff) return fail();
  if (values[0]! >= values[1]!) return fail(); return [values[0]!, values[1]!, values[2]!];
}

/** Index of the first three values in each five-Uint32 body-edge row. */
export class NativeEdgeIndex {
  private readonly order: Uint32Array;
  constructor(private readonly rows: Uint32Array, budget: NativeColumnBudget, signal?: AbortSignal) {
    if (rows.length % 5) throw new NativeChunkError('Invalid native body edge row size'); const count = rows.length / 5, bytes = count * 4;
    signal?.throwIfAborted(); budget.reserve(bytes);
    try {
      this.order = new Uint32Array(count);
      for (let row = 0; row < count; row++) { if (rows[row * 5]! >= rows[row * 5 + 1]!) return fail(); this.order[row] = row; }
      const compare = (a: number, b: number): number => rows[a * 5]! - rows[b * 5]! || rows[a * 5 + 1]! - rows[b * 5 + 1]! || rows[a * 5 + 2]! - rows[b * 5 + 2]!;
      this.order.sort(compare);
      for (let i = 1; i < count; i++) if (compare(this.order[i - 1]!, this.order[i]!) === 0) throw new NativeChunkError('Duplicate native body edge key');
      signal?.throwIfAborted();
    } catch (error) { budget.release(bytes); throw error; }
  }
  /** Rows remain immutable; the index preserves their original order. */
  find(faceA: number, faceB: number, run: number): number {
    for (const n of [faceA, faceB, run]) if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) return -1;
    if (faceA >= faceB) return -1;
    let low = 0, high = this.order.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2), row = this.order[mid]!, at = row * 5;
      const comparison = this.rows[at]! - faceA || this.rows[at + 1]! - faceB || this.rows[at + 2]! - run;
      if (comparison < 0) low = mid + 1; else if (comparison > 0) high = mid; else return row;
    }
    return -1;
  }
}
