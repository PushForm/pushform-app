// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import {
  ANGLE_TOL,
  COPLANAR_TOL,
  LENGTH_TOL,
  MERGE_TOL,
  PushFormError,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3sub,
  type FaceLocalId,
  type MeshData,
  type SurfaceId,
  type Vec3,
} from '@pushform/core';
import type { ComponentsResult, KernelClient } from '@pushform/kernel';
import {
  allocId,
  bodyFromMesh,
  sketchFaceEdgeIds,
  type DocumentState,
  type Draft,
  type EntityContainer,
} from '@pushform/model';
import { defineCommand, type AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import { contextFrame, draftContainerAt, requireContextPath, sketchGraphAt } from './context';
import { FaceTargetSchema, resolveFaceTarget, type FaceTargetInfo } from './offset';

const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const RevolveParamsSchema = z.object({
  profile: FaceTargetSchema,
  /** World-space axis; it must lie in the profile plane. */
  axisOrigin: point,
  axisDir: point,
  angleDeg: z.number().finite().positive().max(360).default(360),
  /** Facets per full turn. */
  segments: z.number().int().min(3).max(720).default(48),
});
export type RevolveParams = z.infer<typeof RevolveParamsSchema>;
export interface RevolveWork {
  readonly params: RevolveParams;
  readonly state: DocumentState;
  readonly info: FaceTargetInfo;
  readonly result: ComponentsResult;
  readonly surfaceGroups: readonly (readonly FaceLocalId[][])[];
}

/** Read-only kernel computation, also used for the tool's preview. */
export async function runRevolveKernel(
  host: ReturnType<typeof hostOf>,
  kernel: KernelClient,
  input: RevolveParams,
): Promise<RevolveWork> {
  const params = RevolveParamsSchema.parse(input);
  requireContextPath(host, params.profile.path, 'Profile face');
  const state = host.doc.state;
  const info = resolveFaceTarget(state, params.profile);
  const frame = contextFrame(state, host.context.path);
  const origin = frame.toLocal(params.axisOrigin);
  const dir = frame.toLocalDir(params.axisDir);
  if (v3len(dir) <= LENGTH_TOL)
    throw new PushFormError('revolve.axis', 'Pick two different points for the axis');
  const axis = v3normalize(dir);
  if (
    Math.abs(v3dot(axis, info.plane.n)) > ANGLE_TOL ||
    Math.abs(v3dot(origin, info.plane.n) + info.plane.d) > COPLANAR_TOL
  ) {
    throw new PushFormError('revolve.axis', 'The axis must lie in the profile plane');
  }
  const radial = v3cross(info.plane.n, axis);
  let min = Infinity,
    max = -Infinity;
  for (const loop of info.loops)
    for (const p of loop) {
      const distance = v3dot(v3sub(p, origin), radial);
      min = Math.min(min, distance);
      max = Math.max(max, distance);
    }
  if (min < -LENGTH_TOL && max > LENGTH_TOL) {
    throw new PushFormError(
      'revolve.crossing',
      'The profile must stay on one side of the axis; it may touch the axis. For a sphere, use a semicircle with its diameter as the axis.',
    );
  }
  const result = await kernel.revolve({
    profile: info.polygon,
    profileBasis: info.basis,
    axisOrigin: origin,
    axisDir: axis,
    angleDeg: params.angleDeg,
    segments: params.segments,
    nextFaceId: 0,
  });
  if (!result.components.length)
    throw new PushFormError('revolve.empty', 'Revolve produced no solid');
  const surfaceGroups = result.components.map((c) => revolveSurfaceGroups(c.mesh, info, origin, axis));
  return { params, state, info, result, surfaceGroups };
}

/**
 * Recover the generating boundary segment in radius/height space. Rotation seams of one
 * segment are smooth; segments of the same source arc join one surface. Other profile
 * corners and partial-turn caps stay hard, independent of the tessellation angle.
 */
function revolveSurfaceGroups(
  mesh: MeshData,
  info: FaceTargetInfo,
  origin: Vec3,
  axis: Vec3,
): FaceLocalId[][] {
  const rz = (p: Vec3): [number, number] => {
    const d = v3sub(p, origin);
    const h = v3dot(d, axis);
    return [v3len(v3sub(d, [axis[0] * h, axis[1] * h, axis[2] * h])), h];
  };
  const segments = info.loops.flatMap((loop, ri) => loop.map((p, i) => ({
    a: rz(p),
    b: rz(loop[(i + 1) % loop.length]!),
    key: info.arcs[ri]?.[i] ? `arc:${info.arcs[ri]![i]!.key}` : `edge:${ri}:${i}`,
  })));
  const vertices = Array.from({ length: mesh.verts.length / 3 }, (_, i) =>
    rz([mesh.verts[i * 3]!, mesh.verts[i * 3 + 1]!, mesh.verts[i * 3 + 2]!]));
  const faces = new Map<FaceLocalId, Set<number>>();
  for (let t = 0; t < mesh.faceId.length; t++) {
    const fid = mesh.faceId[t]! as FaceLocalId;
    let indices = faces.get(fid);
    if (!indices) faces.set(fid, indices = new Set());
    for (let k = 0; k < 3; k++) indices.add(mesh.tris[t * 3 + k]!);
  }
  const groups = new Map<string, FaceLocalId[]>();
  for (const [fid, indices] of faces) {
    const segment = segments.find(({ a, b }) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 <= LENGTH_TOL * LENGTH_TOL) return false;
      for (const i of indices) {
        const p = vertices[i]!;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
        if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) > MERGE_TOL) return false;
      }
      return true;
    });
    if (!segment) continue;
    let group = groups.get(segment.key);
    if (!group) groups.set(segment.key, group = []);
    group.push(fid);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Commit only while the source document and edit context still match the preview. */
export function commitRevolve(
  host: ReturnType<typeof hostOf>,
  work: RevolveWork,
): { bodyIds: number[] } {
  requireContextPath(host, work.params.profile.path, 'Profile face');
  if (host.doc.state !== work.state)
    throw new PushFormError('revolve.stale', 'The model changed; pick the profile and axis again');
  return host.transact('Revolve', () =>
    host.edit('Revolve', (draft) => {
      const root = draftContainerAt(draft, work.params.profile.path);
      const face =
        work.info.sketchFaceId === null ? undefined : root.sketch.faces.get(work.info.sketchFaceId);
      const bodyIds = work.result.components.map((c, i) => {
        const body = bodyFromMesh(draft, c.mesh, {
          container: root as unknown as Draft<EntityContainer>,
          ...(face ? { tagId: face.tagId } : {}),
        });
        for (const faceIds of work.surfaceGroups[i] ?? []) {
          const sid = allocId<SurfaceId>(draft);
          body.surfaces.set(sid, { id: sid, faceIds: [...faceIds], curveId: null });
          for (const fid of faceIds) body.faces.get(fid)!.surfaceId = sid;
        }
        for (const edge of body.edges.values()) {
          const sid = body.faces.get(edge.faceA)?.surfaceId;
          if (sid != null && sid === body.faces.get(edge.faceB)?.surfaceId) {
            edge.soft = true;
            edge.smooth = true;
          }
        }
        if (face)
          for (const record of body.faces.values()) record.frontMaterialId = face.frontMaterialId;
        return body.id as number;
      });
      if (face) {
        const graph = sketchGraphAt(draft, work.params.profile.path);
        const edges = sketchFaceEdgeIds(face);
        graph.removeFace(face.id);
        for (const id of edges) if (!graph.facesUsingEdge(id).length) graph.removeEdge(id);
      }
      return { bodyIds };
    }),
  );
}

export const revolveApply = defineCommand({
  id: 'revolve.apply',
  title: 'Revolve',
  category: 'edit',
  undoable: false,
  params: RevolveParamsSchema.extend({
    precomputed: z
      .custom<RevolveWork>((v) => !!v && typeof v === 'object' && 'result' in v)
      .optional(),
  }),
  async run(ctx, p): Promise<{ bodyIds: number[] }> {
    const host = hostOf(ctx);
    const work = p.precomputed;
    if (work && JSON.stringify(work.params) !== JSON.stringify(RevolveParamsSchema.parse(p)))
      throw new PushFormError('revolve.stale', 'The preview settings changed');
    return commitRevolve(host, work ?? (await runRevolveKernel(host, kernelOf(ctx), p)));
  },
});
export const revolveCommands: readonly AnyCommand[] = [revolveApply];
