// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, Vec2 } from '@pushform/core';
import { basisToLocal, MERGE_TOL, AREA_TOL } from '@pushform/core';
import {
  planarArrangement,
  pointInPolygon,
  polygonArea,
  polygonInteriorPoint,
  ringSegmentRefs,
  type ArrangementSegment,
  type PolygonsWithHoles,
} from '@pushform/geom';
import type { Body, FaceRecord } from '../entities/body';

/** What bounds a region: an edge of a face loop or an imprint edge (direction = traversal). */
export type RegionBoundaryRef =
  | { kind: 'loop'; loop: number; edge: number; forward: boolean }
  | { kind: 'imprint'; edgeId: number; forward: boolean };

export interface Region {
  index: number;
  /** In the face basis (u, v): outer CCW, holes CW. */
  polygon: PolygonsWithHoles;
  area: number;
  outer: RegionBoundaryRef[];
  holes: RegionBoundaryRef[][];
  /** True when the region is the whole face (no imprints). */
  wholeFace: boolean;
}

/** Face polygon in its own basis. */
export function facePolygonUv(face: FaceRecord): PolygonsWithHoles {
  return face.loops.map((loop) =>
    loop.map((p) => {
      const l = basisToLocal(face.basis, p);
      return [l[0], l[1]];
    }),
  );
}

/**
 * Regions of a face: the bounded cells of the arrangement of its loops plus its imprint edges.
 * Without imprints the single region is the face itself.
 */
export function computeRegions(body: Body, faceId: FaceLocalId): Region[] {
  const face = body.faces.get(faceId);
  if (!face) return [];
  const poly = facePolygonUv(face);
  const imprint = body.imprints.get(faceId);
  if (!imprint || imprint.edges.size === 0) {
    const outer = face.loops[0] ?? [];
    return [
      {
        index: 0,
        polygon: poly,
        area: polygonArea(poly),
        outer: outer.map((_, i) => ({ kind: 'loop', loop: 0, edge: i, forward: true })),
        holes: face.loops.slice(1).map((l, li) => l.map((_, i) => ({ kind: 'loop', loop: li + 1, edge: i, forward: true }))),
        wholeFace: true,
      },
    ];
  }
  const refs: RegionBoundaryRef[] = [];
  const segs: ArrangementSegment[] = [];
  poly.forEach((ring, li) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      segs.push({ id: refs.length, a: [a[0]!, a[1]!], b: [b[0]!, b[1]!] });
      refs.push({ kind: 'loop', loop: li, edge: i, forward: true });
    }
  });
  for (const e of imprint.edges.values()) {
    const a = imprint.vertices.get(e.a), b = imprint.vertices.get(e.b);
    if (!a || !b) continue;
    segs.push({ id: refs.length, a: [a[0], a[1]], b: [b[0], b[1]] });
    refs.push({ kind: 'imprint', edgeId: e.id, forward: true });
  }
  const arr = planarArrangement(segs, { tol: MERGE_TOL, areaTol: AREA_TOL });
  const toRefs = (edges: Parameters<typeof ringSegmentRefs>[1]): RegionBoundaryRef[] =>
    ringSegmentRefs(arr, edges).map((r) => {
      const ref = refs[r.id]!;
      return { ...ref, forward: r.forward };
    });
  // only cells inside the face polygon (imprint edges never leave the face, but be safe)
  const regions: Region[] = [];
  for (const cell of arr.cells) {
    const polygon: PolygonsWithHoles = [cell.outer.map((p) => [p[0], p[1]]), ...cell.holes.map((h) => h.map((p) => [p[0], p[1]]))];
    const probe = polygonInteriorPoint(polygon);
    if (!probe || !pointInPolygon(probe, poly)) continue;
    regions.push({
      index: regions.length,
      polygon,
      area: cell.area,
      outer: toRefs(cell.outerEdges),
      holes: cell.holeEdges.map(toRefs),
      wholeFace: false,
    });
  }
  return regions;
}

/** Index of the region containing the (u, v) point, or -1. */
export function regionAt(regions: readonly Region[], uv: Vec2): number {
  for (const r of regions) if (pointInPolygon(uv, r.polygon)) return r.index;
  return -1;
}

/** Memoizes `computeRegions` by (body id, version, faceId, imprint version). */
export class RegionCache {
  private cache = new Map<string, Region[]>();
  constructor(readonly cap = 512) {}

  get(body: Body, faceId: FaceLocalId): Region[] {
    const key = `${body.id}:${body.version}:${faceId}:${body.imprints.get(faceId)?.version ?? 0}`;
    const hit = this.cache.get(key);
    if (hit) {
      // refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const regions = computeRegions(body, faceId);
    this.cache.set(key, regions);
    if (this.cache.size > this.cap) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return regions;
  }
  clear(): void {
    this.cache.clear();
  }
}
