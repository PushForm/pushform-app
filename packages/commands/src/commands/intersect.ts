// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { FaceLocalId, Id, MVec3, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, PushFormError, basisToLocal, v3dist, v3lerp } from '@pushform/core';
import { pointInPolygon, segSegIntersect2D } from '@pushform/geom';
import type { PolygonsWithHoles } from '@pushform/geom';
import { addImprintEdge } from '@pushform/model';
import type { Body, DocumentState, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import { asDraftBody, draftContainerAt, requireContextPath, sketchGraphAt } from './context';
import { EntityRefSchema } from './sketch';
import { resolveFaceTarget, rootContainerOf, type FaceTargetInfo } from './offset';

/**
 * Intersect Faces (context menu). For every sketch face (or body face) in `refs`, every body in
 * scope is section-cut with the face plane; the cut polylines clipped to the face polygon become
 * sketch edges (which split the face) or imprint edges (on a body face).
 *
 * Body vs body is not an edge operation on solids: use Solid Tools. Passing a body ref throws
 * `PushFormError('intersect.unsupported')` (M2).
 */

export const IntersectParamsSchema = z.object({
  /** Faces to intersect; the current selection when omitted. */
  refs: z.array(EntityRefSchema).optional(),
  /** `model`: against every body of the current context's container; `selection`: only against bodies in `refs`. */
  with: z.enum(['model', 'selection']).default('model'),
});
export type IntersectParams = z.infer<typeof IntersectParamsSchema>;

export interface IntersectApplyResult {
  /** New sketch edge ids or imprint edge ids, per source face. */
  edgeIds: number[];
  /** Faces that received edges. */
  faceCount: number;
}

interface CutPlan {
  info: FaceTargetInfo;
  /** Clipped segments in world space. */
  segments: [Vec3, Vec3][];
}

/** Split a (u, v) segment at every crossing with the polygon rings and keep the parts inside. */
function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: PolygonsWithHoles, tol: number): [number, number][] {
  const ts = new Set<number>([0, 1]);
  for (const ring of poly) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i]!, q = ring[(i + 1) % n]!;
      const r = segSegIntersect2D(a, b, [p[0]!, p[1]!], [q[0]!, q[1]!], tol);
      if (r.kind === 'point') ts.add(r.t);
      else if (r.kind === 'collinear' && r.overlap) {
        ts.add(r.overlap[0]);
        ts.add(r.overlap[1]);
      }
    }
  }
  const sorted = [...ts].sort((x, y) => x - y);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const t0 = sorted[i]!, t1 = sorted[i + 1]!;
    if ((t1 - t0) * len <= tol) continue;
    const tm = (t0 + t1) / 2;
    const mid: Vec2 = [a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm];
    if (pointInPolygon(mid, poly)) out.push([t0, t1]);
  }
  return out;
}

function clipLoopToFace(info: FaceTargetInfo, loop: Float64Array, into: [Vec3, Vec3][]): void {
  const n = loop.length / 3;
  const pts: MVec3[] = [];
  for (let i = 0; i < n; i++) pts.push([loop[i * 3]!, loop[i * 3 + 1]!, loop[i * 3 + 2]!]);
  for (let i = 0; i < n; i++) {
    const A = pts[i]!, B = pts[(i + 1) % n]!;
    if (v3dist(A, B) <= MERGE_TOL) continue;
    const la = basisToLocal(info.basis, A), lb = basisToLocal(info.basis, B);
    for (const [t0, t1] of clipSegmentToPolygon([la[0], la[1]], [lb[0], lb[1]], info.polygon, MERGE_TOL)) {
      into.push([v3lerp(A, B, t0), v3lerp(A, B, t1)]);
    }
  }
}

export const intersectFaces = defineCommand({
  id: 'intersect.faces',
  title: 'Intersect Faces',
  category: 'edit',
  params: IntersectParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<IntersectApplyResult> {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const state: DocumentState = host.doc.state;
    const refs: EntityRef[] = p.refs ? (p.refs as unknown as EntityRef[]) : host.selection.refs;
    const path = host.context.path;
    const root = rootContainerOf(state, path);

    const faces: FaceTargetInfo[] = [];
    const selectedBodies = new Set<Id>();
    for (const r of refs) {
      requireContextPath(host, r.path, 'Face');
      if (r.kind === 'sketchFace') faces.push(resolveFaceTarget(state, { kind: 'sketchFace', path: [...path], id: r.id }));
      else if (r.kind === 'face') faces.push(resolveFaceTarget(state, { kind: 'face', path: [...path], id: r.id, faceId: r.faceId, region: r.region }));
      else if (r.kind === 'body') selectedBodies.add(r.id);
    }
    if (!faces.length) {
      if (selectedBodies.size) {
        throw new PushFormError('intersect.unsupported', 'Intersect Faces between solids is not supported: use Solid Tools (Union/Subtract/Intersect/Split)');
      }
      throw new PushFormError('intersect.target', 'Select a face to intersect');
    }
    const bodies: Body[] = [...root.bodies.values()].filter((b) => (p.with === 'model' ? true : selectedBodies.has(b.id)) && !b.hidden);

    const plans: CutPlan[] = [];
    for (const info of faces) {
      const segments: [Vec3, Vec3][] = [];
      for (const body of bodies) {
        if (body.id === info.bodyId) continue;
        await kernel.ensureBody(body.id, body.version, body.mesh);
        const cut = await kernel.sectionCut({ body: { bodyId: body.id, version: body.version }, plane: info.plane });
        for (const loop of cut.loops) clipLoopToFace(info, loop, segments);
      }
      plans.push({ info, segments });
    }

    return host.transact('Intersect Faces', () =>
      host.edit('Intersect Faces', (draft) => {
        const edgeIds: number[] = [];
        let faceCount = 0;
        const g = sketchGraphAt(draft, path);
        const droot = draftContainerAt(draft, path);
        for (const { info, segments } of plans) {
          if (!segments.length) continue;
          faceCount++;
          if (info.bodyId !== null && info.faceId !== null) {
            const body = droot.bodies.get(info.bodyId);
            if (!body) continue;
            for (const [a, b] of segments) {
              edgeIds.push(...addImprintEdge(asDraftBody(body), info.faceId as FaceLocalId, a, b));
            }
          } else {
            for (const [a, b] of segments) for (const id of g.addEdge(a, b)) edgeIds.push(id as number);
          }
        }
        return { edgeIds, faceCount };
      }),
    );
  },
});

export const intersectCommands: readonly AnyCommand[] = [intersectFaces];
