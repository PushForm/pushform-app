// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { ANGLE_TOL, v3dot } from '@pushform/core';
import type { FaceLocalId, Id } from '@pushform/core';
import { containerAt, sketchFaceEdgeIds } from '@pushform/model';
import type { Body, DocumentState, EdgeKey, EdgeRecord, EntityContainer, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import { draftContainerAt, samePath } from './context';
import { EntityRefSchema } from './sketch';

/**
 * Soften Edges: soft/smooth flags from the dihedral angle between the two faces
 * of each body edge; sketch edges are flagged directly.
 */

const DEG = 180 / Math.PI;

/** Dihedral angle (degrees) between the two faces of a body edge, or null when a face is missing. */
export function edgeAngleDeg(body: Body, e: EdgeRecord): number | null {
  const a = body.faces.get(e.faceA), b = body.faces.get(e.faceB);
  if (!a || !b) return null;
  const d = Math.min(1, Math.max(-1, v3dot(a.plane.n, b.plane.n)));
  return Math.acos(d) * DEG;
}
const COPLANAR_DEG = ANGLE_TOL * DEG;

/** Edge targets of a selection, grouped per body (`null` = sketch), from the runtime refs. */
interface Targets {
  readonly bodies: Map<Id, Set<EdgeKey> | 'all'>;
  readonly sketchEdges: Set<Id>;
}

function collectTargets(root: Pick<EntityContainer, 'bodies' | 'sketch'>, path: readonly number[], refs: readonly EntityRef[]): Targets {
  const bodies = new Map<Id, Set<EdgeKey> | 'all'>();
  const sketchEdges = new Set<Id>();
  const addKeys = (id: Id, keys: Iterable<EdgeKey>): void => {
    const cur = bodies.get(id);
    if (cur === 'all') return;
    const set = cur ?? new Set<EdgeKey>();
    for (const k of keys) set.add(k);
    bodies.set(id, set);
  };
  for (const r of refs) {
    if (!samePath(r.path, path)) continue; // only entities of the context whose container this is
    switch (r.kind) {
      case 'body':
        if (root.bodies.has(r.id)) bodies.set(r.id, 'all');
        break;
      case 'edge':
        if (root.bodies.get(r.id)?.edges.has(r.edgeKey)) addKeys(r.id, [r.edgeKey]);
        break;
      case 'face': {
        const b = root.bodies.get(r.id);
        if (!b) break;
        const keys: EdgeKey[] = [];
        for (const e of b.edges.values()) if (e.faceA === r.faceId || e.faceB === r.faceId) keys.push(e.key);
        addKeys(r.id, keys);
        break;
      }
      case 'sketchEdge':
        if (root.sketch.edges.has(r.id)) sketchEdges.add(r.id);
        break;
      case 'sketchFace': {
        const f = root.sketch.faces.get(r.id);
        if (f) for (const id of sketchFaceEdgeIds(f)) sketchEdges.add(id);
        break;
      }
      default:
        break;
    }
  }
  return { bodies, sketchEdges };
}

function* targetEdges(body: Body, sel: Set<EdgeKey> | 'all'): Iterable<EdgeRecord> {
  if (sel === 'all') yield* body.edges.values();
  else for (const k of sel) {
    const e = body.edges.get(k);
    if (e) yield e;
  }
}

export interface SoftenInfo {
  /** Body + sketch edges the selection covers. */
  readonly edges: number;
  readonly soft: number;
  /** Largest dihedral angle among the soft body edges (slider value), null when none is soft. */
  readonly angleDeg: number | null;
  /** True when every soft edge is also smooth; null when none is soft. */
  readonly smooth: boolean | null;
  /** True when a coplanar edge is soft; null when the selection has no coplanar edge. */
  readonly softenCoplanar: boolean | null;
}

/**
 * Current soften state of the selection (what the panel shows when the selection changes).
 * `path` is the edit context the refs live in (root by default).
 */
export function softenInfo(state: DocumentState, refs: readonly EntityRef[], path: readonly number[] = []): SoftenInfo {
  let root: EntityContainer;
  try {
    root = containerAt(state, path as readonly Id[]);
  } catch {
    return { edges: 0, soft: 0, angleDeg: null, smooth: null, softenCoplanar: null };
  }
  const t = collectTargets(root, path, refs);
  let edges = 0, soft = 0, angle = -1, allSmooth = true, coplanar = 0, coplanarSoft = 0;
  const visit = (e: { soft: boolean; smooth: boolean }, deg: number | null): void => {
    edges++;
    if (deg !== null && deg <= COPLANAR_DEG) {
      coplanar++;
      if (e.soft) coplanarSoft++;
    }
    if (!e.soft) return;
    soft++;
    if (!e.smooth) allSmooth = false;
    if (deg !== null && deg > COPLANAR_DEG) angle = Math.max(angle, deg);
  };
  for (const [id, sel] of t.bodies) {
    const b = root.bodies.get(id);
    if (!b) continue;
    for (const e of targetEdges(b, sel)) visit(e, edgeAngleDeg(b, e));
  }
  for (const id of t.sketchEdges) {
    const e = root.sketch.edges.get(id);
    if (e) visit(e, null);
  }
  return {
    edges,
    soft,
    angleDeg: soft ? Math.max(0, angle) : null,
    smooth: soft ? allSmooth : null,
    softenCoplanar: coplanar ? coplanarSoft > 0 : null,
  };
}

export interface SoftenResult {
  readonly softened: number;
  readonly hardened: number;
}

/** Shape of a validated `EntityRefSchema` value (spelled out: inferring it here is too deep for tsc). */
interface EntityRefParam {
  readonly kind: EntityRef['kind'];
  readonly path: readonly number[];
  readonly id: number;
  readonly faceId?: number | undefined;
  readonly region?: number | null | undefined;
  readonly edgeKey?: string | undefined;
  readonly edgeId?: number | undefined;
}

export interface SoftenParams {
  /** Defaults to the current selection. */
  readonly refs?: readonly EntityRefParam[] | undefined;
  readonly angleDeg: number;
  readonly smooth: boolean;
  readonly softenCoplanar: boolean;
}

/** Annotated explicitly: inferring through the 13-kind ref union exceeds the compiler's depth. */
export const SoftenParamsSchema = z.object({
  refs: z.array(EntityRefSchema).optional(),
  angleDeg: z.number().min(0).max(180).default(20),
  smooth: z.boolean().default(true),
  softenCoplanar: z.boolean().default(false),
}) as unknown as z.ZodType<SoftenParams>;

/** Validated ref params → runtime refs (the schema has the same shape; only the brands differ). */
function asRefs(refs: readonly EntityRefParam[]): EntityRef[] {
  return refs.map((r) => {
    const base = { path: r.path as Id[], id: r.id as Id };
    switch (r.kind) {
      case 'face':
        return { kind: 'face', ...base, faceId: r.faceId as FaceLocalId, region: r.region ?? null };
      case 'edge':
        return { kind: 'edge', ...base, edgeKey: r.edgeKey as EdgeKey };
      case 'imprintEdge':
        return { kind: 'imprintEdge', ...base, faceId: r.faceId as FaceLocalId, edgeId: r.edgeId as number };
      default:
        return { kind: r.kind, ...base } as EntityRef;
    }
  });
}

/**
 * `edges.soften`: for body edges, soft when the angle between the adjacent face normals is at
 * most `angleDeg` (coplanar pairs only with `softenCoplanar`), hard otherwise; `smooth` adds
 * smooth normals to softened edges. Sketch edges are flagged directly. `refs` defaults to the
 * current selection.
 */
export const softenEdges = defineCommand({
  id: 'edges.soften',
  title: 'Soften Edges',
  category: 'edit',
  menu: 'Window',
  params: SoftenParamsSchema,
  undoable: true,
  run(ctx, p): SoftenResult {
    const host = hostOf(ctx);
    const refs = p.refs ? asRefs(p.refs) : host.selection.refs;
    let softened = 0, hardened = 0;
    const path = host.context.path;
    host.edit('Soften Edges', (draft) => {
      const root = draftContainerAt(draft, path);
      const t = collectTargets(root, path, refs);
      const apply = (e: { soft: boolean; smooth: boolean }, soft: boolean): void => {
        const smooth = soft && p.smooth;
        if (e.soft !== soft || e.smooth !== smooth) {
          e.soft = soft;
          e.smooth = smooth;
          if (soft) softened++;
          else hardened++;
        }
      };
      for (const [id, sel] of t.bodies) {
        const b = root.bodies.get(id);
        if (!b) continue;
        for (const e of targetEdges(b, sel)) {
          const deg = edgeAngleDeg(b, e);
          if (deg === null) continue;
          apply(e, deg <= COPLANAR_DEG ? p.softenCoplanar : deg <= p.angleDeg);
        }
      }
      for (const id of t.sketchEdges) {
        const e = root.sketch.edges.get(id);
        if (e) apply(e, p.angleDeg > 0 || p.softenCoplanar);
      }
    });
    return { softened, hardened };
  },
});

export const edgeCommands: readonly AnyCommand[] = [softenEdges];
