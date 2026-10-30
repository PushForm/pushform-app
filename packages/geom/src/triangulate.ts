// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import earcut from 'earcut';
import type { MVec2, PlaneBasis, Vec3 } from '@pushform/core';
import { basisToLocal } from '@pushform/core';
import { normalizePolygon, type PolygonsWithHoles } from './polygon2d';

export interface Triangulation {
  /** Flat (x, y) coordinates of all rings in order (outer first). */
  coords: Float64Array;
  /** Triangle vertex indices into `coords` (CCW in the plane for a normalized polygon). */
  indices: Uint32Array;
  /** Start vertex index of each ring. */
  ringStarts: number[];
}

/** Earcut over a polygon with holes. The polygon is normalized (outer CCW, holes CW) first. */
export function triangulatePolygon(poly: PolygonsWithHoles): Triangulation {
  const norm = normalizePolygon(poly);
  let n = 0;
  for (const r of norm) n += r.length;
  const coords = new Float64Array(n * 2);
  const ringStarts: number[] = [];
  const holeIndices: number[] = [];
  let k = 0;
  for (let i = 0; i < norm.length; i++) {
    ringStarts.push(k);
    if (i > 0) holeIndices.push(k);
    for (const p of norm[i]!) {
      coords[k * 2] = p[0]!;
      coords[k * 2 + 1] = p[1]!;
      k++;
    }
  }
  const tris = earcut(coords, holeIndices.length ? holeIndices : null, 2);
  return { coords, indices: Uint32Array.from(tris), ringStarts };
}

export interface FaceTriangulation {
  /** Flat 3D positions of all ring vertices (outer first). */
  positions: Float64Array;
  /** Flat (u, v) of the same vertices. */
  uv: Float64Array;
  /** CCW about the basis normal. */
  indices: Uint32Array;
  ringStarts: number[];
}

/**
 * Triangulate a planar 3D face given as rings of points (outer first) by projecting onto the basis.
 * The ring orientation is normalized, so the output triangles are CCW about `basis.n` regardless
 * of the input winding.
 */
export function triangulatePlanarFace(points3d: readonly (readonly Vec3[])[], basis: PlaneBasis): FaceTriangulation {
  const poly: PolygonsWithHoles = points3d.map((ring) =>
    ring.map((p) => {
      const l = basisToLocal(basis, p);
      return [l[0], l[1]];
    }),
  );
  // keep 3D positions aligned with the normalized ring order
  const norm = normalizePolygon(poly);
  const positionsList: number[] = [];
  const uvList: number[] = [];
  const ringStarts: number[] = [];
  const holeIndices: number[] = [];
  let k = 0;
  for (let i = 0; i < norm.length; i++) {
    const src = points3d[i]!;
    const reversed = norm[i]!.length > 1 && !sameOrder(poly[i]!, norm[i]!);
    ringStarts.push(k);
    if (i > 0) holeIndices.push(k);
    for (let j = 0; j < src.length; j++) {
      const idx = reversed ? src.length - 1 - j : j;
      const p = src[idx]!, uv = poly[i]![idx]!;
      positionsList.push(p[0], p[1], p[2]);
      uvList.push(uv[0]!, uv[1]!);
      k++;
    }
  }
  const uv = Float64Array.from(uvList);
  const tris = earcut(uv, holeIndices.length ? holeIndices : null, 2);
  return { positions: Float64Array.from(positionsList), uv, indices: Uint32Array.from(tris), ringStarts };
}

function sameOrder(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}

/** A point strictly inside the polygon (centroid of its largest triangle), or null if degenerate. */
export function polygonInteriorPoint(poly: PolygonsWithHoles): MVec2 | null {
  const t = triangulatePolygon(poly);
  let best: MVec2 | null = null, bestArea = 0;
  const c = t.coords;
  for (let i = 0; i + 2 < t.indices.length; i += 3) {
    const a = t.indices[i]! * 2, b = t.indices[i + 1]! * 2, d = t.indices[i + 2]! * 2;
    const area = Math.abs((c[b]! - c[a]!) * (c[d + 1]! - c[a + 1]!) - (c[d]! - c[a]!) * (c[b + 1]! - c[a + 1]!));
    if (area > bestArea) {
      bestArea = area;
      best = [(c[a]! + c[b]! + c[d]!) / 3, (c[a + 1]! + c[b + 1]! + c[d + 1]!) / 3];
    }
  }
  return best;
}
