// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Plane, PlaneBasis, Vec3 } from '@pushform/core';
import {
  AREA_TOL,
  basisToLocal,
  basisToWorld,
  COPLANAR_TOL,
  planeBasis,
  planeDistance,
  planeFromPointNormal,
  planesCoincide,
  v3cross,
  v3dot,
  v3len,
  v3neg,
  v3sub,
} from '@pushform/core';
import {
  planarArrangement,
  polygonInteriorPoint,
  ringSegmentRefs,
  type Arrangement,
  type ArrangementCell,
  type ArrangementSegment,
} from '@pushform/geom';
import type { LoopRef, SketchFace } from '../entities/sketch';
import { UV_AUTO } from '../entities/attrs';
import { uvRebaseSides } from '../uv';
import type { SketchGraph } from './SketchGraph';
import { loopKey, reverseLoop, sketchFaceContainsPoint } from './sketchFace';

/** A face deleted by `removeEdge`, used to heal merged regions and carry attributes. */
export interface RemovedFace {
  face: SketchFace;
  /** Edge ids that bounded the face, minus the removed edge. */
  edgeIds: Set<Id>;
}

const MAX_BFS_EDGES = 64;

/**
 * Automatic face creation on a sketch.
 * - `onEdgesAdded`: for every plane the new edges could close a loop in, arrange all coplanar
 *   edges and create faces for new bounded cells touching a new edge. A cell whose outer loop
 *   matches an existing face only updates that face's holes (a loop drawn inside a face); a new
 *   cell lying inside an existing face replaces it (a line splitting a face).
 * - `heal`: after an edge removal, recreate the merged cell bounded only by the removed faces'
 *   remaining edges.
 */
export const FaceFinder = {
  onEdgesAdded(g: SketchGraph, edgeIds: readonly Id[]): Id[] {
    const newIds = edgeIds.filter((id) => g.sketch.edges.has(id));
    if (!newIds.length) return [];
    const result: Id[] = [];
    for (const plane of candidatePlanes(g, newIds)) {
      const { arr, basis } = arrangePlane(g, plane);
      const newSet = new Set(newIds);
      const touching = arr.cells.filter((c) => c.segIds.some((id) => newSet.has(id as Id)));
      if (!touching.length) continue;
      const coplanarFaces = (): SketchFace[] =>
        [...g.sketch.faces.values()].filter((f) => planesCoincide(f.plane, plane));
      const pending: { cell: ArrangementCell; loops: LoopRef[][] }[] = [];
      for (const cell of touching) {
        const loops = cellLoops(arr, cell);
        const key = loopKey(loops[0]!);
        const match = coplanarFaces().find((f) => loopKey(f.loops[0]!) === key);
        if (match) {
          const flip = v3dot(match.plane.n, plane.n) < 0;
          match.loops = flip ? loops.map(reverseLoop) : loops;
          result.push(match.id);
        } else pending.push({ cell, loops });
      }
      const created = new Set<Id>();
      for (const { cell, loops } of pending) {
        const ip = polygonInteriorPoint([cell.outer, ...cell.holes]);
        let template: SketchFace | undefined;
        if (ip) {
          const p3 = basisToWorld(basis, ip[0], ip[1]);
          for (const f of coplanarFaces()) {
            if (created.has(f.id)) continue;
            if (sketchFaceContainsPoint(g.sketch, f, p3)) {
              template ??= f;
              g.sketch.faces.delete(f.id);
            }
          }
        }
        const id = createFace(g, plane, basis, loops, template);
        created.add(id);
        result.push(id);
      }
    }
    return result;
  },

  heal(g: SketchGraph, removed: readonly RemovedFace[]): Id[] {
    const result: Id[] = [];
    const groups: { plane: Plane; faces: RemovedFace[] }[] = [];
    for (const r of removed) {
      const grp = groups.find((x) => planesCoincide(x.plane, r.face.plane));
      if (grp) grp.faces.push(r);
      else groups.push({ plane: r.face.plane, faces: [r] });
    }
    for (const grp of groups) {
      const union = new Set<Id>();
      for (const r of grp.faces) for (const id of r.edgeIds) union.add(id);
      if (!union.size) continue;
      const { arr, basis } = arrangePlane(g, grp.plane);
      const existingKeys = new Set([...g.sketch.faces.values()].map((f) => loopKey(f.loops[0]!)));
      for (const cell of arr.cells) {
        if (!cell.segIds.every((id) => union.has(id as Id))) continue;
        const loops = cellLoops(arr, cell);
        if (existingKeys.has(loopKey(loops[0]!))) continue;
        result.push(createFace(g, grp.plane, basis, loops, grp.faces[0]!.face));
      }
    }
    return result;
  },
};

/** Planes in which the new edges might close a loop: existing faces at their endpoints and planes spanned with nearby edges. */
function candidatePlanes(g: SketchGraph, newIds: readonly Id[]): Plane[] {
  const planes: Plane[] = [];
  const add = (pl: Plane): void => {
    if (!planes.some((p) => planesCoincide(p, pl))) planes.push(pl);
  };
  const adj = g.adjacency();
  for (const id of newIds) {
    const e = g.edge(id);
    const A = g.pos(e.a), B = g.pos(e.b);
    const dir = v3sub(B, A);
    const dl = v3len(dir);
    if (dl === 0) continue;
    for (const f of g.sketch.faces.values()) {
      if (Math.abs(planeDistance(f.plane, A)) <= COPLANAR_TOL && Math.abs(planeDistance(f.plane, B)) <= COPLANAR_TOL) {
        add(f.plane);
      }
    }
    const seen = new Set<Id>([id]);
    const queue: Id[] = [e.a, e.b];
    const seenV = new Set<Id>(queue);
    let count = 0;
    while (queue.length && count < MAX_BFS_EDGES) {
      const v = queue.shift()!;
      for (const fid of adj.get(v) ?? []) {
        if (seen.has(fid)) continue;
        seen.add(fid);
        count++;
        const f = g.edge(fid);
        const P = g.pos(f.a), Q = g.pos(f.b);
        const n = v3cross(dir, v3sub(Q, P));
        const nl = v3len(n);
        if (nl > 1e-9 * dl * v3len(v3sub(Q, P))) {
          // both endpoints of f must lie in the plane through the new edge for it to be a loop candidate
          const pl = planeFromPointNormal(A, canonicalNormal(n));
          if (Math.abs(planeDistance(pl, P)) <= COPLANAR_TOL && Math.abs(planeDistance(pl, Q)) <= COPLANAR_TOL) add(pl);
        }
        const other = f.a === v ? f.b : f.a;
        if (!seenV.has(other)) {
          seenV.add(other);
          queue.push(other);
        }
      }
    }
  }
  return planes;
}

/** Deterministic normal sign: horizontal faces point down, others toward +y then +x. */
function canonicalNormal(n: Vec3): Vec3 {
  const eps = 1e-9;
  if (Math.abs(n[2]) > eps) return n[2] > 0 ? v3neg(n) : n;
  if (Math.abs(n[1]) > eps) return n[1] < 0 ? v3neg(n) : n;
  return n[0] < 0 ? v3neg(n) : n;
}

function arrangePlane(g: SketchGraph, plane: Plane): { arr: Arrangement; basis: PlaneBasis } {
  // origin: a point on the plane
  const origin: Vec3 = [-plane.n[0] * plane.d, -plane.n[1] * plane.d, -plane.n[2] * plane.d];
  const basis = planeBasis(origin, plane.n);
  const segs: ArrangementSegment[] = [];
  for (const e of g.sketch.edges.values()) {
    const P = g.pos(e.a), Q = g.pos(e.b);
    if (Math.abs(planeDistance(plane, P)) > COPLANAR_TOL || Math.abs(planeDistance(plane, Q)) > COPLANAR_TOL) continue;
    const p = basisToLocal(basis, P), q = basisToLocal(basis, Q);
    segs.push({ id: e.id, a: [p[0], p[1]], b: [q[0], q[1]] });
  }
  return { arr: planarArrangement(segs, { tol: g.tol, areaTol: AREA_TOL }), basis };
}

function cellLoops(arr: Arrangement, cell: ArrangementCell): LoopRef[][] {
  const toRefs = (refs: ReturnType<typeof ringSegmentRefs>): LoopRef[] =>
    refs.map((r) => ({ edgeId: r.id as Id, forward: r.forward }));
  return [toRefs(ringSegmentRefs(arr, cell.outerEdges)), ...cell.holeEdges.map((h) => toRefs(ringSegmentRefs(arr, h)))];
}

function createFace(g: SketchGraph, plane: Plane, basis: PlaneBasis, loops: LoopRef[][], template?: SketchFace): Id {
  const id = g.alloc<Id>();
  const face: SketchFace = {
    id,
    plane: { n: [plane.n[0], plane.n[1], plane.n[2]], d: plane.d },
    basis: {
      origin: [basis.origin[0], basis.origin[1], basis.origin[2]],
      u: [basis.u[0], basis.u[1], basis.u[2]],
      v: [basis.v[0], basis.v[1], basis.v[2]],
      n: [basis.n[0], basis.n[1], basis.n[2]],
    },
    loops,
    frontMaterialId: template?.frontMaterialId ?? null,
    backMaterialId: template?.backMaterialId ?? null,
    uv: template?.uv ?? UV_AUTO,
    tagId: template?.tagId ?? g.defaultTagId,
    hidden: template?.hidden ?? false,
    locked: template?.locked ?? false,
    castShadows: template?.castShadows ?? true,
    receiveShadows: template?.receiveShadows ?? true,
    attributes: template ? JSON.parse(JSON.stringify(template.attributes)) : {},
  };
  // a template with a flipped normal: keep this face's orientation (loops are CCW about `plane.n`)
  const flipped = !!template && v3dot(template.plane.n, plane.n) < 0;
  if (template && flipped) {
    face.frontMaterialId = template.backMaterialId;
    face.backMaterialId = template.frontMaterialId;
  }
  if (template) {
    // each side keeps its texture placement, re-expressed in this face's basis (an automatic
    // placement stays automatic: the face finder does not know the texture sizes)
    const sides = flipped && template.uvBack ? { uv: template.uvBack, uvBack: template.uv } : template;
    const r = uvRebaseSides(sides, template.basis, face.basis, null, null);
    face.uv = r.uv;
    if (r.uvBack) face.uvBack = r.uvBack;
  }
  g.sketch.faces.set(id, face);
  return id;
}
