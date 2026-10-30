// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Vec3 } from '@pushform/core';
import { basisToLocal, COPLANAR_TOL, planeDistance } from '@pushform/core';
import { pointInPolygon, type PolygonsWithHoles } from '@pushform/geom';
import type { LoopRef, Sketch, SketchFace } from '../entities/sketch';

/** Start vertex of a loop edge reference. */
export function loopRefStart(sketch: Sketch, ref: LoopRef): Id {
  const e = sketch.edges.get(ref.edgeId);
  if (!e) throw new Error(`Sketch edge ${ref.edgeId} missing from loop`);
  return ref.forward ? e.a : e.b;
}

/** Vertex ids around a loop (one per edge, in traversal order). */
export function loopVertexIds(sketch: Sketch, loop: readonly LoopRef[]): Id[] {
  return loop.map((r) => loopRefStart(sketch, r));
}

export function loopPoints(sketch: Sketch, loop: readonly LoopRef[]): Vec3[] {
  return loopVertexIds(sketch, loop).map((id) => {
    const v = sketch.vertices.get(id);
    if (!v) throw new Error(`Sketch vertex ${id} missing`);
    return v.p;
  });
}

/** Derived polygon: 3D points per loop (outer first, then holes). */
export function sketchFaceLoops(sketch: Sketch, face: SketchFace): Vec3[][] {
  return face.loops.map((l) => loopPoints(sketch, l));
}

/** Derived polygon in the face basis (u, v). Outer CCW, holes CW when the face is well-formed. */
export function sketchFacePolygonUv(sketch: Sketch, face: SketchFace): PolygonsWithHoles {
  return face.loops.map((l) =>
    loopPoints(sketch, l).map((p) => {
      const q = basisToLocal(face.basis, p);
      return [q[0], q[1]];
    }),
  );
}

/** True when p lies in the face plane (within tol) and inside its polygon (holes excluded). */
export function sketchFaceContainsPoint(sketch: Sketch, face: SketchFace, p: Vec3, tol = COPLANAR_TOL): boolean {
  if (Math.abs(planeDistance(face.plane, p)) > tol) return false;
  const q = basisToLocal(face.basis, p);
  return pointInPolygon([q[0], q[1]], sketchFacePolygonUv(sketch, face));
}

/** All edge ids referenced by a face. */
export function sketchFaceEdgeIds(face: SketchFace): Set<Id> {
  const s = new Set<Id>();
  for (const loop of face.loops) for (const r of loop) s.add(r.edgeId);
  return s;
}

/**
 * The vertex that moves when a sketch edge's length is set, with the one that stays: the edge's second end,
 * else its first when the second is on a face. Null when the edge bounds a face, belongs to a curve, or both its ends
 * are on faces, since moving either would change a face.
 */
export function sketchEdgeLengthEnds(sketch: Sketch, edgeId: Id): { moving: Id; fixed: Id } | null {
  const edge = sketch.edges.get(edgeId);
  if (!edge || edge.curveId !== null) return null;
  const onFace = new Set<Id>();
  for (const face of sketch.faces.values()) for (const loop of face.loops) for (const ref of loop) {
    if (ref.edgeId === edgeId) return null;
    const e = sketch.edges.get(ref.edgeId);
    if (e) { onFace.add(e.a); onFace.add(e.b); }
  }
  if (!onFace.has(edge.b)) return { moving: edge.b, fixed: edge.a };
  if (!onFace.has(edge.a)) return { moving: edge.a, fixed: edge.b };
  return null;
}

/** Order-independent key of a loop's edge set (used to match arrangement cells to faces). */
export function loopKey(loop: readonly LoopRef[]): string {
  return loop
    .map((r) => r.edgeId as number)
    .sort((a, b) => a - b)
    .join(',');
}

/** Reverse a loop's traversal direction. */
export function reverseLoop(loop: readonly LoopRef[]): LoopRef[] {
  return loop
    .slice()
    .reverse()
    .map((r) => ({ edgeId: r.edgeId, forward: !r.forward }));
}
