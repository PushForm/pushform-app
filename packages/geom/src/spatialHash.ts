// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';

/** Grid cell key for a point at the given cell size (used by both SpatialHash and model vertex hashes). */
export function cellKey(p: Vec3, cellSize: number): string {
  return `${Math.floor(p[0] / cellSize)},${Math.floor(p[1] / cellSize)},${Math.floor(p[2] / cellSize)}`;
}

/** The 27 cell keys around p (including its own); call when searching within one cell size. */
export function neighborCellKeys(p: Vec3, cellSize: number): string[] {
  const cx = Math.floor(p[0] / cellSize), cy = Math.floor(p[1] / cellSize), cz = Math.floor(p[2] / cellSize);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) keys.push(`${cx + dx},${cy + dy},${cz + dz}`);
  return keys;
}

/**
 * Numeric key of a grid cell. Distinct cells can share a key; lookups check distances, so a shared key only adds
 * candidates. Numbers avoid building strings, which dominated index builds (PF-189).
 */
function numericCellKey(cx: number, cy: number, cz: number): number {
  return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) | 0;
}

/**
 * Uniform-grid point hash for tolerance lookups. The cell size should be ≥ the search radius so
 * that querying the 27 neighbouring cells is exhaustive.
 */
export class SpatialHash<T> {
  private cells = new Map<number, { p: Vec3; item: T }[]>();
  constructor(readonly cellSize: number) {}

  private key(p: Vec3): number {
    const s = this.cellSize;
    return numericCellKey(Math.floor(p[0] / s), Math.floor(p[1] / s), Math.floor(p[2] / s));
  }

  insert(p: Vec3, item: T): void {
    const k = this.key(p);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push({ p: [p[0], p[1], p[2]], item });
  }

  remove(p: Vec3, item: T): boolean {
    const k = this.key(p);
    const list = this.cells.get(k);
    if (!list) return false;
    const i = list.findIndex((e) => e.item === item);
    if (i < 0) return false;
    list.splice(i, 1);
    if (list.length === 0) this.cells.delete(k);
    return true;
  }

  /** Visit every stored point within `radius` (≤ cellSize) of p, once per entry. */
  private each(p: Vec3, radius: number, visit: (item: T, distSq: number) => void): void {
    const r2 = radius * radius, s = this.cellSize;
    const cx = Math.floor(p[0] / s), cy = Math.floor(p[1] / s), cz = Math.floor(p[2] / s);
    // Neighbouring cells can share a numeric key; each list is scanned only once.
    let scanned: Set<number> | null = null;
    let first: number | undefined;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const k = numericCellKey(cx + dx, cy + dy, cz + dz);
          const list = this.cells.get(k);
          if (!list) continue;
          if (first === undefined) first = k;
          else if (k === first || scanned?.has(k)) continue;
          else (scanned ??= new Set([first])).add(k);
          for (const e of list) {
            const ex = e.p[0] - p[0], ey = e.p[1] - p[1], ez = e.p[2] - p[2];
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 <= r2) visit(e.item, d2);
          }
        }
  }

  /** All items within `radius` (≤ cellSize) of p, nearest first. */
  query(p: Vec3, radius: number): { item: T; distSq: number }[] {
    const out: { item: T; distSq: number }[] = [];
    this.each(p, radius, (item, distSq) => out.push({ item, distSq }));
    if (out.length > 1) out.sort((a, b) => a.distSq - b.distSq);
    return out;
  }

  /** Nearest item within `radius`, or undefined. */
  find(p: Vec3, radius: number): T | undefined {
    let best: T | undefined, bestSq = Infinity;
    this.each(p, radius, (item, distSq) => { if (distSq < bestSq) { best = item; bestSq = distSq; } });
    return best;
  }

  get size(): number {
    let n = 0;
    for (const l of this.cells.values()) n += l.length;
    return n;
  }
}
