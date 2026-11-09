// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL } from '@pushform/core';
import type { MeshData, Vec3 } from '@pushform/core';
import { triangulatePolygon } from '@pushform/geom';

export interface CutBox { readonly min: Vec3; readonly max: Vec3 }

/** A raised panel's cross-section: rings of [inset from the outline, height], back to front. */
export type PanelRing = readonly [inset: number, z: number];

function gridLines(size: number, cuts: readonly CutBox[], axis: number): number[] {
  const values = [0, size];
  for (const c of cuts) values.push(Math.min(size, Math.max(0, c.min[axis]!)), Math.min(size, Math.max(0, c.max[axis]!)));
  values.sort((a, b) => a - b);
  return values.filter((v, i) => i === 0 || v - values[i - 1]! > MERGE_TOL);
}

/**
 * A block of stock with rectilinear cuts taken out: the boundary of the occupied cells of the grid the cuts define.
 * Neighbouring cells share grid vertices, so the mesh is closed with no T-junctions.
 */
export function meshStock(size: Vec3, cuts: readonly CutBox[]): MeshData {
  const lines = [gridLines(size[0], cuts, 0), gridLines(size[1], cuts, 1), gridLines(size[2], cuts, 2)];
  const n = lines.map(l => l.length - 1);
  const cut = (i: number, j: number, k: number): boolean => {
    const mid: Vec3 = [(lines[0]![i]! + lines[0]![i + 1]!) / 2, (lines[1]![j]! + lines[1]![j + 1]!) / 2, (lines[2]![k]! + lines[2]![k + 1]!) / 2];
    return cuts.some(c => mid.every((m, a) => m > c.min[a]! && m < c.max[a]!));
  };
  const occupied = (cell: readonly number[]): boolean =>
    cell.every((v, a) => v >= 0 && v < n[a]!) && !cut(cell[0]!, cell[1]!, cell[2]!);

  const verts: number[] = [], tris: number[] = [];
  const index = new Map<string, number>();
  const vertex = (g: readonly number[]): number => {
    const key = g.join(',');
    let v = index.get(key);
    if (v === undefined) {
      v = verts.length / 3;
      index.set(key, v);
      verts.push(lines[0]![g[0]!]!, lines[1]![g[1]!]!, lines[2]![g[2]!]!);
    }
    return v;
  };
  for (let i = 0; i < n[0]!; i++) for (let j = 0; j < n[1]!; j++) for (let k = 0; k < n[2]!; k++) {
    const cell = [i, j, k];
    if (!occupied(cell)) continue;
    for (let a = 0; a < 3; a++) for (const dir of [1, -1]) {
      const beside = [...cell];
      beside[a]! += dir;
      if (occupied(beside)) continue;
      const b = (a + 1) % 3, c = (a + 2) % 3;
      const corner = (db: number, dc: number): number => {
        const g = [...cell];
        g[a] = cell[a]! + (dir > 0 ? 1 : 0);
        g[b] = cell[b]! + db;
        g[c] = cell[c]! + dc;
        return vertex(g);
      };
      const quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
      if (dir < 0) quad.reverse();
      tris.push(quad[0]!, quad[1]!, quad[2]!, quad[0]!, quad[2]!, quad[3]!);
    }
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(tris.length / 3) };
}

/** A panel lofted through nested rectangular rings, with flat caps on the first and last. */
export function meshLoftedPanel(length: number, width: number, rings: readonly PanelRing[]): MeshData {
  const verts: number[] = [], tris: number[] = [];
  for (const [inset, z] of rings)
    verts.push(inset, inset, z, length - inset, inset, z, length - inset, width - inset, z, inset, width - inset, z);
  tris.push(0, 2, 1, 0, 3, 2);
  for (let r = 0; r + 1 < rings.length; r++) for (let s = 0; s < 4; s++) {
    const a = r * 4 + s, b = r * 4 + (s + 1) % 4, c = a + 4, d = b + 4;
    tris.push(a, b, d, a, d, c);
  }
  const top = (rings.length - 1) * 4;
  tris.push(top, top + 1, top + 2, top, top + 2, top + 3);
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(tris.length / 3) };
}

/** A flat panel with a polygon outline (counter-clockwise, in the xy plane) extruded along +z. */
export function meshPrism(outline: readonly (readonly [number, number])[], thickness: number): MeshData {
  const n = outline.length;
  const verts: number[] = [];
  for (const z of [0, thickness]) for (const [x, y] of outline) verts.push(x, y, z);
  const caps = triangulatePolygon([outline.map(([x, y]) => [x, y])]).indices;
  const tris: number[] = [];
  for (let i = 0; i < caps.length; i += 3) {
    const a = caps[i]!, b = caps[i + 1]!, c = caps[i + 2]!;
    tris.push(a, c, b, a + n, b + n, c + n);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(i, j, j + n, i, j + n, i + n);
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(tris.length / 3) };
}
