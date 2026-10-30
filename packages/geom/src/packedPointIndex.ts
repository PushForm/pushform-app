// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';

export interface PackedPointIndexData { positions: Float64Array; rows: Uint32Array; axis: number }

/** Immutable Float64 points plus one four-byte row permutation per point.
 * Sort on the widest axis, binary-search the query slab, then test exact distances.
 * Callers own the positions and scratch array and must not mutate either after construction.
 */
export class PackedPointIndex {
  /** Plain data survives worker structured cloning without retaining class instances. */
  get data(): PackedPointIndexData { return { positions: this.positions, rows: this.rows, axis: this.axis }; }
  readonly axis: number;
  constructor(private readonly positions: Float64Array, private readonly rows: Uint32Array, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (positions.length !== rows.length * 3) throw new Error('Invalid packed point index size');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let row = 0; row < rows.length; row++) {
      rows[row] = row;
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[row * 3 + axis]!; if (!Number.isFinite(value)) throw new Error('Nonfinite packed point');
        min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
      }
    }
    let axis = 0;
    for (let candidate = 1; candidate < 3; candidate++) if (max[candidate]! - min[candidate]! > max[axis]! - min[axis]!) axis = candidate;
    this.axis = axis;
    rows.sort((a, b) => positions[a * 3 + axis]! - positions[b * 3 + axis]! || a - b);
    signal?.throwIfAborted();
  }
  /** Yields source rows, including coincident points. Never allocates a result collection. */
  *within(point: Vec3, radius = MERGE_TOL): Generator<number> {
    yield* packedPointsWithin(this.data, point, radius);
  }
}

export function* packedPointsWithin(data: PackedPointIndexData, point: Vec3, radius = MERGE_TOL): Generator<number> {
  const { positions, rows, axis } = data;
  if (point.length !== 3 || point.some(n => !Number.isFinite(n)) || !Number.isFinite(radius) || radius < 0) throw new Error('Invalid packed point query');
  const lower = point[axis]! - radius, upper = point[axis]! + radius;
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2), value = positions[rows[mid]! * 3 + axis]!;
    if (value < lower) low = mid + 1; else high = mid;
  }
  for (let i = low; i < rows.length; i++) {
    const row = rows[i]!, at = row * 3;
    if (positions[at + axis]! > upper) break;
    if (Math.hypot(positions[at]! - point[0], positions[at + 1]! - point[1], positions[at + 2]! - point[2]) <= radius) yield row;
  }
}
