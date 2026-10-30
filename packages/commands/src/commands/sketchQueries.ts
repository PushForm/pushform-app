// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id } from '@pushform/core';
import { containerAt, sketchFaceEdgeIds, surfaceFaceIds } from '@pushform/model';
import type { DocumentState, EntityRef, Sketch } from '@pushform/model';

/** Read-only helpers over a sketch used by Select / Eraser / selection commands (root context only). */

export const sketchEdgeRef = (id: Id): EntityRef => ({ kind: 'sketchEdge', path: [], id });
export const sketchFaceRef = (id: Id): EntityRef => ({ kind: 'sketchFace', path: [], id });
export const bodyRef = (id: Id): EntityRef => ({ kind: 'body', path: [], id });

/** Faces of the sketch that use `edgeId` in any loop. */
export function facesUsingEdge(sketch: Sketch, edgeId: Id): Id[] {
  const out: Id[] = [];
  for (const f of sketch.faces.values()) if (sketchFaceEdgeIds(f).has(edgeId)) out.push(f.id);
  return out;
}

/** The edge set of a face as refs (bounding edges, holes included). */
export function faceBoundingEdgeRefs(sketch: Sketch, faceId: Id): EntityRef[] {
  const f = sketch.faces.get(faceId);
  if (!f) return [];
  return [...sketchFaceEdgeIds(f)].map(sketchEdgeRef);
}

/**
 * All sketch edges and faces connected (through shared vertices) to the seed entity, as refs.
 * Used by the triple-click "all connected" selection.
 */
export function connectedSketchRefs(sketch: Sketch, seed: EntityRef): EntityRef[] {
  const seedEdges: Id[] = [];
  const seedVertices: Id[] = [];
  switch (seed.kind) {
    case 'sketchEdge':
      seedEdges.push(seed.id);
      break;
    case 'sketchFace': {
      const f = sketch.faces.get(seed.id);
      if (f) seedEdges.push(...sketchFaceEdgeIds(f));
      break;
    }
    case 'sketchVertex':
      seedVertices.push(seed.id);
      break;
    default:
      return [];
  }
  const byVertex = new Map<Id, Id[]>();
  for (const e of sketch.edges.values()) {
    for (const v of [e.a, e.b]) {
      const l = byVertex.get(v);
      if (l) l.push(e.id);
      else byVertex.set(v, [e.id]);
    }
  }
  const edges = new Set<Id>();
  const vertices = new Set<Id>();
  const stackV: Id[] = [...seedVertices];
  const visitEdge = (id: Id): void => {
    if (edges.has(id)) return;
    const e = sketch.edges.get(id);
    if (!e) return;
    edges.add(id);
    stackV.push(e.a, e.b);
  };
  for (const id of seedEdges) visitEdge(id);
  while (stackV.length) {
    const v = stackV.pop()!;
    if (vertices.has(v)) continue;
    vertices.add(v);
    for (const eid of byVertex.get(v) ?? []) visitEdge(eid);
  }
  const refs: EntityRef[] = [...edges].map(sketchEdgeRef);
  for (const f of sketch.faces.values()) {
    const ids = sketchFaceEdgeIds(f);
    let inside = ids.size > 0;
    for (const id of ids) {
      if (!edges.has(id)) {
        inside = false;
        break;
      }
    }
    if (inside) refs.push(sketchFaceRef(f.id));
  }
  return refs;
}

/** Sketch faces joined through soft edges, per sketch (immer replaces the sketch when it changes). */
const sketchSurfaces = new WeakMap<Sketch, Map<Id, Id[]>>();

/**
 * Sketch faces that act as one with `faceId`: every face reached from it across soft edges, as
 * Faces join into a surface. A face with no soft edge is alone. Sorted by id.
 */
export function sketchSurfaceFaceIds(sketch: Sketch, faceId: Id): Id[] {
  let groups = sketchSurfaces.get(sketch);
  if (!groups) {
    groups = new Map();
    const byEdge = new Map<Id, Id[]>();
    for (const f of sketch.faces.values()) {
      for (const e of sketchFaceEdgeIds(f)) {
        if (!sketch.edges.get(e)?.soft) continue;
        const l = byEdge.get(e);
        if (l) l.push(f.id);
        else byEdge.set(e, [f.id]);
      }
    }
    for (const f of sketch.faces.values()) {
      if (groups.has(f.id)) continue;
      const group: Id[] = [];
      const stack = [f.id];
      const seen = new Set(stack);
      while (stack.length) {
        const id = stack.pop()!;
        group.push(id);
        const face = sketch.faces.get(id);
        if (!face) continue;
        for (const e of sketchFaceEdgeIds(face)) {
          for (const n of byEdge.get(e) ?? []) {
            if (seen.has(n)) continue;
            seen.add(n);
            stack.push(n);
          }
        }
      }
      group.sort((a, b) => a - b);
      for (const id of group) groups.set(id, group);
    }
    sketchSurfaces.set(sketch, groups);
  }
  const ids = groups.get(faceId);
  return ids && ids.length > 1 ? ids : [faceId];
}

/**
 * A body or sketch face stands for its whole smooth surface: the refs of every face of
 * it, `ref` among them. Anything else, and a face on no surface, stands for itself.
 */
export function surfaceRefs(state: DocumentState, ref: EntityRef): EntityRef[] {
  if (ref.kind !== 'face' && ref.kind !== 'sketchFace') return [ref];
  let container;
  try {
    container = containerAt(state, ref.path);
  } catch {
    return [ref];
  }
  if (ref.kind === 'sketchFace') {
    const ids = sketchSurfaceFaceIds(container.sketch, ref.id);
    return ids.length > 1 ? ids.map((id): EntityRef => ({ kind: 'sketchFace', path: ref.path, id })) : [ref];
  }
  const body = container.bodies.get(ref.id);
  const ids = body ? surfaceFaceIds(body, ref.faceId) : [];
  return ids.length > 1 ? ids.map((faceId): EntityRef => ({ kind: 'face', path: ref.path, id: ref.id, faceId, region: null })) : [ref];
}
