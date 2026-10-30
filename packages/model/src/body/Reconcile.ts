// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, Id, MeshData, SurfaceId } from '@pushform/core';
import type { Body, BodyProps, EdgeKey, FaceRecord, EdgeRecord } from '../entities/body';
import type { ComponentDefinition, EntityContainer } from '../entities/definition';
import type { DocumentState } from '../entities/document';
import type { DocumentDraft } from '../Document';
import { buildFaceRecords, carryEdgeProps, computeBodyProps, deriveEdges } from './BodyBuilder';

/** Where a new face came from: a face of the body identified by `runId` (kernel `runOriginalID`). */
export interface KernelFaceOrigin {
  runId: number;
  faceId: FaceLocalId;
}

/**
 * Generic kernel output for one body. The kernel package produces this; the model never imports
 * the kernel. `faceOrigin` maps every faceId of the new mesh to the faces it was built from.
 */
export interface KernelResult {
  mesh: MeshData;
  faceOrigin: Map<FaceLocalId, KernelFaceOrigin[]>;
  /** The runId of this body's own upload; when omitted every origin is treated as this body's. */
  selfRunId?: number;
  /** Precomputed properties from the kernel; computed from the mesh when omitted. */
  props?: BodyProps;
  /**
   * Other bodies that contributed faces (booleans): their face attributes, surfaces, curves and
   * edge flags are carried onto the faces/edges that originated from them.
   */
  foreign?: ReadonlyArray<{ runId: number; body: Body }>;
}

export interface BodyLocation {
  definition: ComponentDefinition;
  container: EntityContainer;
  body: Body;
}

/** Locate a body by id across all definitions (bodies ids are unique document-wide). */
export function findBody(state: DocumentState, bodyId: Id): BodyLocation | undefined {
  for (const definition of state.definitions.values()) {
    const body = definition.entities.bodies.get(bodyId);
    if (body) return { definition, container: definition.entities, body };
  }
  return undefined;
}

/**
 * Replace a body's mesh with a kernel result inside a transaction:
 * - FaceRecords whose faceId survives keep their materials/uv/tag/flags (geometry recomputed);
 * - new faces copy material/uv/tag from the dominant origin face of this body when there is one;
 * - imprints survive only on surviving faces; edges are re-derived and flags carried by overlap;
 * - surfaces/curves drop references that no longer exist; version and props are updated.
 */
export function applyKernelResult(draft: DocumentDraft, bodyId: Id, result: KernelResult): Body {
  const loc = findBody(draft as unknown as DocumentState, bodyId);
  if (!loc) throw new Error(`Body ${bodyId} not found`);
  reconcileBody(loc.body, result);
  return loc.body;
}

export function reconcileBody(body: Body, result: KernelResult): void {
  const { faces: built, nextFaceId } = buildFaceRecords(result.mesh, body.tagId);
  const faces = new Map<FaceLocalId, FaceRecord>();
  // new face id → faces of each foreign body it originated from (by runId)
  const foreignOf = new Map<FaceLocalId, { body: Body; face: FaceRecord }>();
  // foreign (runId, faceId) → new face ids (for surfaces, curves and edge keys)
  const foreignToNew = new Map<string, FaceLocalId[]>();
  if (result.foreign?.length) {
    const byRun = new Map(result.foreign.map((f) => [f.runId, f.body]));
    for (const [fid, origins] of result.faceOrigin) {
      const counts = new Map<string, number>();
      let best: { body: Body; face: FaceRecord } | undefined, bestN = 0;
      for (const o of origins) {
        const fb = byRun.get(o.runId);
        const face = fb?.faces.get(o.faceId);
        if (!fb || !face) continue;
        const key = `${o.runId}:${o.faceId}`;
        const list = foreignToNew.get(key) ?? foreignToNew.set(key, []).get(key)!;
        if (!list.includes(fid)) list.push(fid);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > bestN) {
          bestN = n;
          best = { body: fb, face };
        }
      }
      if (best) foreignOf.set(fid, best);
    }
  }
  for (const [fid, rec] of built) {
    const prev = body.faces.get(fid);
    const own = prev ?? dominantOrigin(body, result, fid);
    const src = own ?? foreignOf.get(fid)?.face;
    faces.set(fid, {
      ...rec,
      frontMaterialId: src?.frontMaterialId ?? null,
      backMaterialId: src?.backMaterialId ?? null,
      uv: src?.uv ?? rec.uv,
      ...(src?.uvBack ? { uvBack: src.uvBack } : {}),
      tagId: src?.tagId ?? rec.tagId,
      hidden: prev?.hidden ?? false,
      surfaceId: src?.surfaceId ?? null,
    });
  }
  const edges = deriveEdges(result.mesh, body.tagId);
  // previous edges: this body's own, plus foreign edges re-keyed onto the new face ids they map to
  const previous = new Map<EdgeKey, EdgeRecord>(body.edges);
  if (result.foreign?.length) {
    for (const f of result.foreign) {
      for (const e of f.body.edges.values()) {
        const as = foreignToNew.get(`${f.runId}:${e.faceA}`) ?? [];
        const bs = foreignToNew.get(`${f.runId}:${e.faceB}`) ?? [];
        for (const na of as) {
          for (const nb of bs) {
            if (na === nb) continue;
            const [faceA, faceB] = na < nb ? [na, nb] : [nb, na];
            const key = `foreign:${f.runId}:${e.key}:${faceA}:${faceB}` as EdgeKey;
            previous.set(key, { ...e, key, faceA, faceB });
          }
        }
      }
    }
  }
  carryEdgeProps(previous, edges);

  for (const fid of [...body.imprints.keys()]) {
    if (!faces.has(fid) || !body.faces.has(fid)) body.imprints.delete(fid);
  }
  // surfaces: own records keep the faces that survived; faces split by the kernel inherit the
  // surface of their dominant origin (set above), so rebuild membership from the faces
  const membership = new Map<SurfaceId, FaceLocalId[]>();
  for (const [fid, f] of faces) {
    if (f.surfaceId === null) continue;
    (membership.get(f.surfaceId) ?? membership.set(f.surfaceId, []).get(f.surfaceId)!).push(fid);
  }
  for (const [sid, s] of [...body.surfaces]) {
    const members = membership.get(sid);
    if (!members) body.surfaces.delete(sid);
    else s.faceIds = members;
  }
  if (result.foreign?.length) {
    for (const f of result.foreign) {
      for (const s of f.body.surfaces.values()) {
        const members = membership.get(s.id);
        if (members && !body.surfaces.has(s.id)) body.surfaces.set(s.id, { id: s.id, faceIds: members, curveId: s.curveId });
      }
      for (const c of f.body.curves.values()) {
        if (body.curves.has(c.id)) continue;
        const refs = [...edges.values()].filter((e) => e.curveId === c.id).map((e) => e.key);
        if (refs.length) body.curves.set(c.id, { ...c, edgeRefs: refs });
      }
    }
  }
  for (const [cid, c] of [...body.curves]) {
    c.edgeRefs = c.edgeRefs.filter((r) => typeof r === 'string' && edges.has(r as EdgeKey));
    if (c.edgeRefs.length === 0) body.curves.delete(cid);
  }

  body.faces = faces;
  body.nextFaceId = Math.max(body.nextFaceId, nextFaceId);
  body.edges = edges;
  body.mesh = result.mesh;
  body.version += 1;
  body.props = result.props ?? computeBodyProps(result.mesh);
  body.valid = true;
}

/** The most frequent origin face of this body for a new faceId, or undefined. */
function dominantOrigin(body: Body, result: KernelResult, fid: FaceLocalId): FaceRecord | undefined {
  const origins = result.faceOrigin.get(fid);
  if (!origins?.length) return undefined;
  const counts = new Map<FaceLocalId, number>();
  let best: FaceLocalId | undefined, bestN = 0;
  for (const o of origins) {
    if (result.selfRunId !== undefined && o.runId !== result.selfRunId) continue;
    if (!body.faces.has(o.faceId)) continue;
    const n = (counts.get(o.faceId) ?? 0) + 1;
    counts.set(o.faceId, n);
    if (n > bestN) {
      bestN = n;
      best = o.faceId;
    }
  }
  return best === undefined ? undefined : body.faces.get(best);
}
