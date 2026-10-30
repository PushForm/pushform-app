// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Id, MeshData, Vec3, FaceLocalId } from '@pushform/core';
import { MERGE_TOL, PushFormError, v3dist, v3dot } from '@pushform/core';
import type { ComponentsResult, KernelComponent, BooleanResult } from '@pushform/kernel';
import { applyKernelResult, bodyFromMesh, sketchFaceEdgeIds } from '@pushform/model';
import type { DocumentDraft, EntityContainer, Draft, KernelFaceOrigin } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import { contextFrame, draftContainerAt, requireContextPath, sketchGraphAt } from './context';
import { FaceTargetSchema, orderSketchEdgeChain, resolveFaceTarget, rootContainerOf, type FaceTargetInfo } from './offset';

/**
 * Follow Me: sweep a profile face along a path of sketch edges (or explicit points, e.g. a face
 * perimeter with Alt). The kernel builds the solid; the sketch profile is consumed like Push/Pull.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const FollowMeParamsSchema = z
  .object({
    profile: FaceTargetSchema,
    /** Sketch edge ids forming one continuous chain (any order). */
    pathEdgeIds: z.array(z.number().int().nonnegative()).optional(),
    /** Explicit path points (world; converted to the context), e.g. the perimeter of a face (Alt + click). */
    pathPoints: z.array(vec3).min(2).optional(),
    /** Close the path (lathe / loop). Inferred from the edge chain when omitted. */
    closed: z.boolean().optional(),
  })
  .refine((p) => (p.pathEdgeIds !== undefined && p.pathEdgeIds.length > 0) !== (p.pathPoints !== undefined), {
    message: 'Provide either pathEdgeIds or pathPoints',
  });
export type FollowMeParams = z.infer<typeof FollowMeParamsSchema>;

export interface FollowMeApplyResult {
  bodyIds: number[];
}

export interface FollowMePlan {
  readonly info: FaceTargetInfo;
  readonly path: Vec3[];
  readonly closed: boolean;
}

/** Resolve the profile and order the path (pure; throws on a discontinuous path). Everything is context-local. */
export function planFollowMe(host: ReturnType<typeof hostOf>, p: FollowMeParams): FollowMePlan {
  const state = host.doc.state;
  requireContextPath(host, p.profile.path, 'Profile face');
  const info = resolveFaceTarget(state, p.profile);
  let path: Vec3[];
  let closed: boolean;
  if (p.pathPoints) {
    const frame = contextFrame(state, host.context.path);
    path = p.pathPoints.map((q): Vec3 => frame.toLocal([q[0], q[1], q[2]]));
    closed = p.closed ?? false;
  } else {
    const root = rootContainerOf(state, p.profile.path);
    const chain = orderSketchEdgeChain(root.sketch, (p.pathEdgeIds ?? []) as Id[]);
    path = chain.points;
    closed = p.closed ?? chain.closed;
  }
  // drop repeated end point of a closed path
  if (closed && path.length > 2 && v3dist(path[0]!, path[path.length - 1]!) <= MERGE_TOL) path = path.slice(0, -1);
  if (path.length < 2) throw new PushFormError('followme.path', 'Follow Me needs a path of at least one segment');
  // start the sweep at the path vertex nearest the profile plane (the kernel also does this, but
  // for an open path the nearer end must come first)
  if (!closed) {
    const d0 = Math.abs(v3dot(info.plane.n, path[0]!) + info.plane.d);
    const d1 = Math.abs(v3dot(info.plane.n, path[path.length - 1]!) + info.plane.d);
    if (d1 < d0) path = path.slice().reverse();
  }
  return { info, path, closed };
}

const toMesh = (c: KernelComponent): MeshData => ({ verts: c.mesh.verts, tris: c.mesh.tris, faceId: c.mesh.faceId });
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

export function applyFollowMeResult(draft: DocumentDraft, plan: FollowMePlan, result: ComponentsResult): FollowMeApplyResult {
  const root = draftContainerAt(draft, plan.info.target.path);
  const bodyIds: number[] = [];
  const sketchFace = plan.info.sketchFaceId !== null ? root.sketch.faces.get(plan.info.sketchFaceId) : undefined;
  if (plan.info.sketchFaceId !== null && !sketchFace) throw new PushFormError('followme.stale', 'The profile changed before Follow Me could be applied');
  for (const c of result.components) {
    const body = bodyFromMesh(draft, toMesh(c), sketchFace ? { container: asDraft(root), tagId: sketchFace.tagId } : { container: asDraft(root) });
    if (sketchFace) {
      for (const rec of body.faces.values()) {
        rec.frontMaterialId = sketchFace.frontMaterialId;
        rec.uv = sketchFace.uv;
      }
    }
    bodyIds.push(body.id);
  }
  if (sketchFace) {
    const g = sketchGraphAt(draft, plan.info.target.path);
    const edgeIds = sketchFaceEdgeIds(sketchFace);
    g.removeFace(sketchFace.id);
    for (const eid of edgeIds) if (g.facesUsingEdge(eid).length === 0) g.removeEdge(eid);
  }
  return { bodyIds };
}

/**
 * Sweep the profile along the path. Async: the kernel runs first, then the document edit is one
 * undo entry ("Follow Me"). A kernel `NotImplemented` error propagates unchanged.
 */
export const followMeApply = defineCommand({
  id: 'followme.apply',
  title: 'Follow Me',
  category: 'edit',
  params: FollowMeParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<FollowMeApplyResult> {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    const plan = planFollowMe(host, p);
    const result = await kernel.followMe({
      profile: plan.info.polygon,
      profileBasis: plan.info.basis,
      path: plan.path.map((q) => [q[0], q[1], q[2]] as Vec3),
      closed: plan.closed,
      nextFaceId: 0,
    });
    if (!result.components.length) throw new PushFormError('followme.empty', 'Follow Me produced no solid');
    // A profile drawn on a solid's face sweeps out of (or into) that solid: merge the sweep into it,
    // instead of leaving a separate body.
    const hostBodyId = plan.info.bodyId;
    if (hostBodyId !== null && result.components.length === 1) {
      const hostBody = rootContainerOf(host.doc.state, p.profile.path).bodies.get(hostBodyId);
      const swept = result.components[0]!;
      if (hostBody) {
        const temp = { bodyId: TEMP_SWEEP_BASE + (sweepCounter++ % 0xffff), version: 0 };
        let merged: BooleanResult;
        try {
          await kernel.ensureBody(hostBody.id, hostBody.version, hostBody.mesh);
          await kernel.ensureBody(temp.bodyId, temp.version, swept.mesh);
          merged = await kernel.boolean({ op: 'add', a: { bodyId: hostBody.id, version: hostBody.version }, b: temp, nextFaceId: hostBody.nextFaceId });
        } finally {
          void kernel.release(temp.bodyId, temp.version).catch(() => undefined);
        }
        return host.transact('Follow Me', () =>
          host.edit('Follow Me', (draft) => {
            const root = draftContainerAt(draft, p.profile.path);
            const cur = root.bodies.get(hostBodyId);
            if (!cur || cur.version !== hostBody.version) throw new PushFormError('followme.stale', 'The solid changed before Follow Me could be applied');
            const [first, ...extras] = merged.components;
            const bodyIds: number[] = [];
            if (first) {
              const updated = applyKernelResult(draft, cur.id, {
                mesh: toMesh(first),
                faceOrigin: first.faceOrigin as unknown as Map<FaceLocalId, KernelFaceOrigin[]>,
                selfRunId: merged.aRunId,
                props: first.props,
              });
              updated.nextFaceId = Math.max(updated.nextFaceId, merged.nextFaceId);
              bodyIds.push(updated.id);
            } else {
              root.bodies.delete(cur.id);
              root.order = root.order.filter((x) => x !== cur.id);
            }
            for (const c of extras) bodyIds.push(bodyFromMesh(draft, toMesh(c), { container: asDraft(root), tagId: cur.tagId }).id);
            return { bodyIds };
          }),
        );
      }
    }
    return host.transact('Follow Me', () => host.edit('Follow Me', (draft) => applyFollowMeResult(draft, plan, result)));
  },
});

const TEMP_SWEEP_BASE = 0x7e000000;
let sweepCounter = 0;

export const followMeCommands: readonly AnyCommand[] = [followMeApply];
