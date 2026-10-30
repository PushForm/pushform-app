// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, Id, TagId, Vec3 } from '@pushform/core';
import {
  MERGE_TOL,
  planeBasis,
  basisToLocal,
  v3cross,
  v3dist,
  v3len,
  v3sub,
  type DefId,
} from '@pushform/core';
import {
  cellKey,
  pointSegmentClosest3D,
  segSegClosest3D,
  segSegIntersect2D,
  segmentsCoplanar,
} from '@pushform/geom';
import type { Sketch, SketchEdge, SketchFace, SketchVertex } from '../entities/sketch';
import type { LoopRef } from '../entities/sketch';
import { allocId, type DocumentDraft } from '../Document';
import { FaceFinder, type RemovedFace } from './FaceFinder';
import { sketchFaceEdgeIds } from './sketchFace';
import { uvClone } from '../uv';
import { materializeSketchVertexHash, sketchVertexCandidates } from './vertexIndex';

export interface AddEdgeOptions {
  soft?: boolean;
  smooth?: boolean;
  hidden?: boolean;
  tagId?: TagId;
  curveId?: CurveId | null;
  /** Run the face finder after adding (default true). */
  findFaces?: boolean;
}

/**
 * Mutating operations on a draft Sketch. Must be used inside a Document transaction; `alloc`
 * hands out persistent ids from the document draft.
 */
export class SketchGraph {
  readonly tol: number;
  constructor(
    readonly sketch: Sketch,
    readonly alloc: <T extends number = Id>() => T,
    readonly defaultTagId: TagId,
    tol = MERGE_TOL,
  ) {
    this.tol = tol;
  }

  /** Graph over the sketch of a definition in the draft (root definition by default). */
  static for(draft: DocumentDraft, definitionId: DefId = draft.rootDefinitionId): SketchGraph {
    const def = draft.definitions.get(definitionId);
    if (!def) throw new Error(`Definition ${definitionId} not found`);
    // cast: immer's Draft<Sketch> instantiation is too deep for TS on the nested-Map document state
    const sketch = def.entities.sketch as unknown as Sketch;
    return new SketchGraph(sketch, <T extends number = Id>() => allocId<T>(draft), draft.defaultTagId);
  }

  // ------------------------------------------------------------------ vertices

  vertex(id: Id): SketchVertex {
    const v = this.sketch.vertices.get(id);
    if (!v) throw new Error(`Sketch vertex ${id} not found`);
    return v;
  }
  pos(id: Id): Vec3 {
    return this.vertex(id).p;
  }

  /** Existing vertex within `tol` of p (nearest), or undefined. */
  findVertex(p: Vec3, tol = this.tol): Id | undefined {
    let best: Id | undefined, bestD = tol * tol;
    for (const id of sketchVertexCandidates(this.sketch, p, tol, this.tol)) {
        const v = this.sketch.vertices.get(id);
        if (!v) continue;
        const dx = v.p[0] - p[0], dy = v.p[1] - p[1], dz = v.p[2] - p[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d <= bestD) {
          bestD = d;
          best = id;
        }
    }
    return best;
  }

  /** Get-or-create a vertex, merging within MERGE_TOL. */
  addVertex(p: Vec3): Id {
    const existing = this.findVertex(p);
    if (existing !== undefined) return existing;
    materializeSketchVertexHash(this.sketch, this.tol);
    const id = this.alloc<Id>();
    this.sketch.vertices.set(id, { id, p: [p[0], p[1], p[2]] });
    const k = cellKey(p, this.tol);
    const list = this.sketch.vertexHash.get(k);
    if (list) list.push(id);
    else this.sketch.vertexHash.set(k, [id]);
    return id;
  }

  private removeVertex(id: Id): void {
    materializeSketchVertexHash(this.sketch, this.tol);
    const v = this.sketch.vertices.get(id);
    if (!v) return;
    const k = cellKey(v.p, this.tol);
    const list = this.sketch.vertexHash.get(k);
    if (list) {
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.sketch.vertexHash.delete(k);
    }
    this.sketch.vertices.delete(id);
  }

  /** Delete a vertex that no edge references any more. */
  removeVertexIfOrphan(id: Id): boolean {
    for (const e of this.sketch.edges.values()) if (e.a === id || e.b === id) return false;
    this.removeVertex(id);
    return true;
  }

  /** Vertex id → incident edge ids. */
  adjacency(): Map<Id, Id[]> {
    const adj = new Map<Id, Id[]>();
    const push = (v: Id, e: Id): void => {
      const l = adj.get(v);
      if (l) l.push(e);
      else adj.set(v, [e]);
    };
    for (const e of this.sketch.edges.values()) {
      push(e.a, e.id);
      push(e.b, e.id);
    }
    return adj;
  }

  // ------------------------------------------------------------------ edges

  edge(id: Id): SketchEdge {
    const e = this.sketch.edges.get(id);
    if (!e) throw new Error(`Sketch edge ${id} not found`);
    return e;
  }

  findEdge(a: Id, b: Id): SketchEdge | undefined {
    for (const e of this.sketch.edges.values()) if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e;
    return undefined;
  }

  facesUsingEdge(edgeId: Id): SketchFace[] {
    const out: SketchFace[] = [];
    for (const f of this.sketch.faces.values()) if (sketchFaceEdgeIds(f).has(edgeId)) out.push(f);
    return out;
  }

  private createEdge(a: Id, b: Id, opts: AddEdgeOptions, template?: SketchEdge): SketchEdge {
    const id = this.alloc<Id>();
    const e: SketchEdge = {
      id,
      a,
      b,
      soft: opts.soft ?? template?.soft ?? false,
      smooth: opts.smooth ?? template?.smooth ?? false,
      hidden: opts.hidden ?? template?.hidden ?? false,
      curveId: opts.curveId ?? template?.curveId ?? null,
      tagId: opts.tagId ?? template?.tagId ?? this.defaultTagId,
      locked: template?.locked ?? false,
      castShadows: template?.castShadows ?? true,
      receiveShadows: template?.receiveShadows ?? true,
      attributes: template ? cloneAttrs(template.attributes) : {},
    };
    this.sketch.edges.set(id, e);
    return e;
  }

  /**
   * Split an edge at an existing vertex. Faces and curves referencing the edge are updated in
   * place. Returns the two new edge ids (a→v, v→b). No-op (returns null) if v is an endpoint.
   */
  splitEdge(edgeId: Id, v: Id): [Id, Id] | null {
    const e = this.edge(edgeId);
    if (e.a === v || e.b === v) return null;
    const e1 = this.createEdge(e.a, v, {}, e);
    const e2 = this.createEdge(v, e.b, {}, e);
    this.sketch.edges.delete(edgeId);
    for (const f of this.sketch.faces.values()) {
      for (const loop of f.loops) {
        for (let i = 0; i < loop.length; i++) {
          const r = loop[i]!;
          if (r.edgeId !== edgeId) continue;
          const repl: LoopRef[] = r.forward
            ? [{ edgeId: e1.id, forward: true }, { edgeId: e2.id, forward: true }]
            : [{ edgeId: e2.id, forward: false }, { edgeId: e1.id, forward: false }];
          loop.splice(i, 1, ...repl);
          i++;
        }
      }
    }
    for (const c of this.sketch.curves.values()) {
      const i = c.edgeRefs.indexOf(edgeId);
      if (i >= 0) c.edgeRefs.splice(i, 1, e1.id, e2.id);
    }
    return [e1.id, e2.id];
  }

  /**
   * Add an edge between two points or vertices. Endpoints merge within MERGE_TOL; existing edges
   * crossed or T-joined by the new segment are split, the new segment is split at those points
   * and at vertices lying on it, and existing coincident edges are reused rather than duplicated.
   * Returns the ids of all edges along the path a→b (created or reused), then runs the face finder.
   */
  addEdge(a: Vec3 | Id, b: Vec3 | Id, opts: AddEdgeOptions = {}): Id[] {
    const va = typeof a === 'number' ? a : this.addVertex(a);
    const vb = typeof b === 'number' ? b : this.addVertex(b);
    if (va === vb) return [];
    const A = this.pos(va), B = this.pos(vb);
    const AB = v3sub(B, A);
    const lenAB = v3len(AB);
    const tol = this.tol;
    const t2 = tol * tol;
    const interior = (t: number, len: number): boolean => t * len > tol && (1 - t) * len > tol;

    const existingSplits = new Map<Id, { t: number; v: Id }[]>();
    const newSplits = new Map<Id, number>(); // vertex -> t along A→B
    const pushExisting = (eid: Id, t: number, v: Id): void => {
      const l = existingSplits.get(eid);
      if (l) l.push({ t, v });
      else existingSplits.set(eid, [{ t, v }]);
    };

    for (const e of [...this.sketch.edges.values()]) {
      const P = this.pos(e.a), Q = this.pos(e.b);
      const lenPQ = v3dist(P, Q);
      // endpoints of e lying on the new segment
      for (const q of [e.a, e.b]) {
        if (q === va || q === vb) continue;
        const c = pointSegmentClosest3D(this.pos(q), A, B);
        if (c.distSq <= t2 && interior(c.t, lenAB)) newSplits.set(q, c.t);
      }
      // endpoints of the new segment lying on e
      for (const v of [va, vb]) {
        if (v === e.a || v === e.b) continue;
        const c = pointSegmentClosest3D(this.pos(v), P, Q);
        if (c.distSq <= t2 && interior(c.t, lenPQ)) pushExisting(e.id, c.t, v);
      }
      if (e.a === va || e.a === vb || e.b === va || e.b === vb) continue;
      // proper crossing
      let hit: { t: number; s: number; point: Vec3 } | null = null;
      const n = v3cross(AB, v3sub(Q, P));
      const nl = v3len(n);
      if (nl <= 1e-12 * lenAB * lenPQ) continue; // parallel: handled by endpoint tests
      if (segmentsCoplanar(A, B, P, Q, tol)) {
        const basis = planeBasis(A, n);
        const uv = (p: Vec3): [number, number] => {
          const l = basisToLocal(basis, p);
          return [l[0], l[1]];
        };
        const r = segSegIntersect2D(uv(A), uv(B), uv(P), uv(Q), tol);
        if (r.kind === 'point') hit = { t: r.t, s: r.s, point: [A[0] + AB[0] * r.t, A[1] + AB[1] * r.t, A[2] + AB[2] * r.t] };
      } else {
        const r = segSegClosest3D(A, B, P, Q);
        if (r.distSq <= t2) hit = { t: r.t, s: r.s, point: [(r.p[0] + r.q[0]) / 2, (r.p[1] + r.q[1]) / 2, (r.p[2] + r.q[2]) / 2] };
      }
      if (hit && interior(hit.t, lenAB) && interior(hit.s, lenPQ)) {
        const vX = this.addVertex(hit.point);
        if (vX !== va && vX !== vb) newSplits.set(vX, hit.t);
        if (vX !== e.a && vX !== e.b) pushExisting(e.id, hit.s, vX);
      }
    }

    // split existing edges
    for (const [eid, list] of existingSplits) {
      list.sort((x, y) => x.t - y.t);
      let cur = eid;
      const seen = new Set<Id>();
      for (const { v } of list) {
        if (seen.has(v)) continue;
        seen.add(v);
        const r = this.splitEdge(cur, v);
        if (r) cur = r[1];
      }
    }

    // build the path along the new segment
    const chain: Id[] = [va, ...[...newSplits.entries()].sort((x, y) => x[1] - y[1]).map((x) => x[0]), vb];
    const ids: Id[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const u = chain[i]!, v = chain[i + 1]!;
      if (u === v) continue;
      const existing = this.findEdge(u, v);
      ids.push(existing ? existing.id : this.createEdge(u, v, opts).id);
    }
    if (opts.findFaces !== false && ids.length) FaceFinder.onEdgesAdded(this, ids);
    return ids;
  }

  /**
   * Delete an edge. Faces using it are deleted; coplanar faces that merge across the removed
   * edge heal into one face. Orphaned vertices and empty curves are removed.
   */
  removeEdge(id: Id): void {
    const e = this.sketch.edges.get(id);
    if (!e) return;
    const removed: RemovedFace[] = [];
    for (const f of this.facesUsingEdge(id)) {
      removed.push({ face: snapshotFace(f), edgeIds: sketchFaceEdgeIds(f) });
      this.sketch.faces.delete(f.id);
    }
    this.sketch.edges.delete(id);
    for (const c of [...this.sketch.curves.values()]) {
      const i = c.edgeRefs.indexOf(id);
      if (i >= 0) c.edgeRefs.splice(i, 1);
      if (c.edgeRefs.length === 0) this.sketch.curves.delete(c.id);
    }
    this.removeVertexIfOrphan(e.a);
    this.removeVertexIfOrphan(e.b);
    for (const r of removed) r.edgeIds.delete(id);
    if (removed.length) FaceFinder.heal(this, removed);
  }

  /** Delete a face, keeping its edges. */
  removeFace(id: Id): void {
    this.sketch.faces.delete(id);
  }
}

/** Plain (non-draft) copy of a face so it stays readable after deletion from the draft. */
function snapshotFace(f: SketchFace): SketchFace {
  return {
    ...f,
    plane: { n: [f.plane.n[0], f.plane.n[1], f.plane.n[2]], d: f.plane.d },
    basis: {
      origin: [...f.basis.origin] as [number, number, number],
      u: [...f.basis.u] as [number, number, number],
      v: [...f.basis.v] as [number, number, number],
      n: [...f.basis.n] as [number, number, number],
    },
    loops: f.loops.map((l) => l.map((r) => ({ ...r }))),
    uv: uvClone(f.uv),
    ...(f.uvBack ? { uvBack: uvClone(f.uvBack) } : {}),
    attributes: cloneAttrs(f.attributes),
  };
}

function cloneAttrs<T>(a: T): T {
  return JSON.parse(JSON.stringify(a)) as T;
}
