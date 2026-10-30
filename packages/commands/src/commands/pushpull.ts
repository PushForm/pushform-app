// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CurveId, FaceLocalId, Id, MeshData, SurfaceId, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, planeProject, PushFormError, v3dist, v3dot, v3eq, v3scale } from '@pushform/core';
import { pointInPolygon } from '@pushform/geom';
import type {
  ExtrudeSketchRequest,
  KernelClient,
  KernelComponent,
  MeshWire,
  PushPullMode,
  PushPullRequest,
  PushPullResult,
} from '@pushform/kernel';
import { TOOL_FAR_CAP, TOOL_NEAR_CAP } from '@pushform/kernel';
import type {
  Body,
  Curve,
  DocumentDraft,
  DocumentState,
  Draft,
  EdgeRecord,
  EntityContainer,
  FaceRecord,
  ImprintGraph,
  KernelFaceOrigin,
  KernelResult,
  Region,
  RegionBoundaryRef,
  Sketch,
  SketchFace,
} from '@pushform/model';
import {
  allocId,
  applyKernelResult,
  bodyFromMesh,
  computeRegions,
  containerAt,
  createImprintGraph,
  facePolygonUv,
  sketchFaceEdgeIds,
  sketchFacePolygonUv,
  textureTiles,
  uvRebase,
} from '@pushform/model';
import { defineCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import { contextFrame, draftContainerAt, requireContextPath, sketchGraphAt } from './context';

// ---------------------------------------------------------------------------------------------
// Params

const pathSchema = z.array(z.number().int().nonnegative()).default([]);

/** A push/pull target: a body face (optionally one region of it) or a sketch face, in the container at `path`. */
export const PushPullTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('face'),
    path: pathSchema,
    id: z.number().int(),
    faceId: z.number().int(),
    region: z.number().int().nullable().default(null),
  }),
  z.object({ kind: z.literal('sketchFace'), path: pathSchema, id: z.number().int() }),
]);
export type PushPullTarget = z.infer<typeof PushPullTargetSchema>;

const modeSchema = z.enum(['merge', 'newBody']).default('merge');

const isPushPullResult = (v: unknown): v is PushPullResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components);

export const PushPullApplyParamsSchema = z.object({
  target: PushPullTargetSchema,
  /** Signed distance along the face normal (meters): > 0 pulls out, < 0 pushes in. */
  distance: z.number().finite(),
  mode: modeSchema,
  /** A kernel result already computed for exactly these params (the tool's last matching preview). */
  precomputed: z.custom<PushPullResult>(isPushPullResult).optional(),
});
export type PushPullApplyParams = z.infer<typeof PushPullApplyParamsSchema>;

export interface PushPullApplyResult {
  /** Bodies that exist after the operation and were created or modified by it. */
  bodyIds: number[];
}

// ---------------------------------------------------------------------------------------------
// Planning: resolve a target against the document into a kernel request

type Params<R extends { type: string }> = Omit<R, 'type'>;

export type PushPullPlan =
  | {
      kind: 'body';
      path: readonly Id[];
      container: EntityContainer;
      body: Body;
      face: FaceRecord;
      regions: Region[];
      region: Region;
      request: Params<PushPullRequest>;
    }
  | {
      kind: 'sketch';
      path: readonly Id[];
      container: EntityContainer;
      face: SketchFace;
      request: Params<ExtrudeSketchRequest>;
    };

function containerOf(state: DocumentState, path: readonly number[]): EntityContainer {
  try {
    return containerAt(state, path as unknown as readonly Id[]);
  } catch (e) {
    throw new PushFormError('pushpull.context', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Convert a signed distance measured along the face's world normal into the distance along its
 * context-local normal: the world displacement is transformed into the container's frame with
 * the inverse context matrix and projected onto the local normal (exact for rigid contexts;
 * for scaled contexts it is the normal component of the mapped displacement).
 */
export function localPushPullDistance(state: DocumentState, path: readonly number[], localNormal: Vec3, worldDistance: number): number {
  const frame = contextFrame(state, path as unknown as readonly Id[]);
  if (frame.identity) return worldDistance;
  const worldNormal = frame.toWorldNormal(localNormal);
  const localDisplacement = frame.toLocalDir(v3scale(worldNormal, worldDistance));
  return v3dot(localDisplacement, localNormal);
}

/**
 * Resolve a target in `state` and build the kernel request for it. Pure: reads the state only.
 * `distance` is measured along the face's world normal (what a tool sees) unless `space` is
 * `'local'`; the request always carries the context-local distance. Throws
 * `PushFormError('pushpull.target')` when the target no longer exists.
 */
export function planPushPull(state: DocumentState, target: PushPullTarget, distance: number, mode: PushPullMode, space: 'world' | 'local' = 'world'): PushPullPlan {
  const path = target.path as unknown as readonly Id[];
  const container = containerOf(state, path);
  if (target.kind === 'sketchFace') {
    const face = container.sketch.faces.get(target.id as Id);
    if (!face) throw new PushFormError('pushpull.target', `Sketch face ${target.id} not found`);
    const d = space === 'local' ? distance : localPushPullDistance(state, path, face.plane.n, distance);
    return {
      kind: 'sketch',
      path,
      container,
      face,
      request: { basis: face.basis, polygon: sketchFacePolygonUv(container.sketch, face), distance: d, nextFaceId: 0 },
    };
  }
  const body = container.bodies.get(target.id as Id);
  if (!body) throw new PushFormError('pushpull.target', `Body ${target.id} not found`);
  const faceId = target.faceId as FaceLocalId;
  const face = body.faces.get(faceId);
  if (!face) throw new PushFormError('pushpull.target', `Face ${target.faceId} not found on body ${target.id}`);
  const regions = computeRegions(body, faceId);
  const index = target.region ?? 0;
  const region = regions[index];
  if (!region) throw new PushFormError('pushpull.target', `Region ${index} not found on face ${target.faceId}`);
  const imprint = body.imprints.get(faceId);
  const regionIsWholeFace = !imprint || imprint.edges.size === 0 || regions.length === 1;
  const d = space === 'local' ? distance : localPushPullDistance(state, path, face.plane.n, distance);
  return {
    kind: 'body',
    path,
    container,
    body,
    face,
    regions,
    region,
    request: {
      body: { bodyId: body.id, version: body.version },
      region: {
        faceId,
        basis: face.basis,
        polygon: regionIsWholeFace ? facePolygonUv(face) : region.polygon,
        regionIsWholeFace,
      },
      distance: d,
      mode,
      nextFaceId: body.nextFaceId,
    },
  };
}

/** Run the plan on the kernel (uploading the body first when needed). `preview` marks drag previews. */
export async function runPushPullKernel(kernel: KernelClient, plan: PushPullPlan, preview = false): Promise<PushPullResult> {
  if (plan.kind === 'sketch') return kernel.extrudeSketch(plan.request);
  await kernel.ensureBody(plan.body.id, plan.body.version, plan.body.mesh);
  return kernel.pushPull(preview ? { ...plan.request, preview: true } : plan.request);
}

// ---------------------------------------------------------------------------------------------
// Reconcile helpers

const toMesh = (m: MeshWire): MeshData => ({ verts: m.verts, tris: m.tris, faceId: m.faceId });

function toKernelResult(c: KernelComponent, selfRunId: number): KernelResult {
  // cast: the wire carries plain numbers where the model uses branded FaceLocalIds
  const faceOrigin = c.faceOrigin as unknown as Map<FaceLocalId, KernelFaceOrigin[]>;
  return { mesh: toMesh(c.mesh), faceOrigin, selfRunId, props: c.props };
}

function hasOrigin(c: KernelComponent, faceId: number, runId: number, originFaceId: number): boolean {
  return (c.faceOrigin.get(faceId) ?? []).some((o) => o.runId === runId && o.faceId === originFaceId);
}

/** New body from a component, copying material/uv/tag of faces that came from `source`'s faces. */
function bodyFromComponent(draft: DocumentDraft, container: EntityContainer, c: KernelComponent, source: Body, sourceRunId: number): Body {
  const body = bodyFromMesh(draft, toMesh(c.mesh), { container: asDraft(container), tagId: source.tagId, materialId: source.materialId });
  for (const [fid, rec] of body.faces) {
    const origin = (c.faceOrigin.get(fid) ?? []).find((o) => o.runId === sourceRunId && source.faces.has(o.faceId as FaceLocalId));
    const src = origin ? source.faces.get(origin.faceId as FaceLocalId) : undefined;
    if (!src) continue;
    rec.frontMaterialId = src.frontMaterialId;
    rec.backMaterialId = src.backMaterialId;
    rec.uv = src.uv;
    if (src.uvBack) rec.uvBack = src.uvBack;
    rec.tagId = src.tagId;
  }
  return body;
}

/**
 * After a sub-region push/pull on face F: imprint edges on the region boundary became real edges
 * (drop them); imprint edges strictly inside the region move onto the cap face when it has the
 * same (u,v) frame (it always does unless the cap merged into a differently oriented face).
 */
function relocateImprints(body: Body, faceId: FaceLocalId, region: Region, component: KernelComponent, toolRunId: number): void {
  const graph = body.imprints.get(faceId);
  const face = body.faces.get(faceId);
  if (!graph || !face) return;
  const boundary = new Set<number>();
  for (const ref of [region.outer, ...region.holes].flat()) if (ref.kind === 'imprint') boundary.add(ref.edgeId);

  let cap: FaceRecord | undefined;
  for (const fid of component.faceOrigin.keys()) {
    if (fid !== faceId && hasOrigin(component, fid, toolRunId, TOOL_FAR_CAP)) {
      cap = body.faces.get(fid as FaceLocalId);
      break;
    }
  }
  const capUsable = cap !== undefined && v3eq(cap.basis.u, face.basis.u) && v3eq(cap.basis.v, face.basis.v);
  let capGraph: ImprintGraph | undefined;
  const capVertexFor = new Map<number, number>();
  const inside = (p: Vec2): boolean => pointInPolygon(p, region.polygon);

  for (const e of [...graph.edges.values()]) {
    if (boundary.has(e.id)) {
      graph.edges.delete(e.id);
      continue;
    }
    const a = graph.vertices.get(e.a), b = graph.vertices.get(e.b);
    if (!a || !b) continue;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inside(a) || !inside(b) || !inside(mid)) continue;
    graph.edges.delete(e.id);
    if (!capUsable || !cap) continue;
    capGraph ??= body.imprints.get(cap.id) ?? createImprintGraph();
    const g = capGraph;
    const vertex = (id: number, p: Vec2): number => {
      const existing = capVertexFor.get(id);
      if (existing !== undefined) return existing;
      const nid = g.nextId++;
      g.vertices.set(nid, [p[0], p[1]]);
      capVertexFor.set(id, nid);
      return nid;
    };
    const nid = g.nextId++;
    g.edges.set(nid, { ...e, id: nid, a: vertex(e.a, a), b: vertex(e.b, b) });
  }
  const used = new Set<number>();
  for (const e of graph.edges.values()) {
    used.add(e.a);
    used.add(e.b);
  }
  for (const id of [...graph.vertices.keys()]) if (!used.has(id)) graph.vertices.delete(id);
  graph.version += 1;
  if (graph.edges.size === 0) body.imprints.delete(faceId);
  if (capGraph && cap) {
    capGraph.version += 1;
    body.imprints.set(cap.id, capGraph);
  }
}

/** cast: inside a transaction the container is a draft; Body and Draft<Body> differ only in tuple mutability. */
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

function removeBody(container: EntityContainer, id: Id): void {
  container.bodies.delete(id);
  container.order = container.order.filter((x) => x !== id);
}

// ---------------------------------------------------------------------------------------------
// Curves → surfaces (extruded circles/arcs become smooth face groups, the caps keep the curve)

/** Curve records of a region boundary, keyed by the flattened boundary edge index, plus the successor index map. */
interface BoundaryCurves {
  readonly byIndex: Map<number, Curve>;
  /** Flattened index → next index around the same contour (wraps). */
  readonly next: Map<number, number>;
}

function contourSuccessors(lengths: readonly number[]): Map<number, number> {
  const next = new Map<number, number>();
  let start = 0;
  for (const len of lengths) {
    for (let i = 0; i < len; i++) next.set(start + i, start + ((i + 1) % len));
    start += len;
  }
  return next;
}

/** Boundary curves of a sketch face (its loop edges' `curveId`s). */
function sketchBoundaryCurves(sketch: Sketch, face: SketchFace): BoundaryCurves {
  const byIndex = new Map<number, Curve>();
  let i = 0;
  for (const loop of face.loops) {
    for (const ref of loop) {
      const e = sketch.edges.get(ref.edgeId);
      const c = e?.curveId !== null && e?.curveId !== undefined ? sketch.curves.get(e.curveId) : undefined;
      if (c) byIndex.set(i, c);
      i++;
    }
  }
  return { byIndex, next: contourSuccessors(face.loops.map((l) => l.length)) };
}

/** Body edge record between face `fid` and another face whose polyline contains both `a` and `b`. */
function edgeRecordForSegment(body: Body, fid: FaceLocalId, a: Vec3, b: Vec3): EdgeRecord | undefined {
  const has = (poly: readonly Vec3[], p: Vec3): boolean => poly.some((q) => v3dist(q, p) <= MERGE_TOL);
  for (const e of body.edges.values()) {
    if (e.faceA !== fid && e.faceB !== fid) continue;
    if (has(e.polyline, a) && has(e.polyline, b)) return e;
  }
  return undefined;
}

/** Boundary curves of a body face region: loop edges via their EdgeRecord, imprint edges via the imprint graph. */
function bodyBoundaryCurves(body: Body, face: FaceRecord, region: Region, wholeFace: boolean): BoundaryCurves {
  const contours: RegionBoundaryRef[][] = wholeFace
    ? face.loops.map((l, li) => l.map((_, i): RegionBoundaryRef => ({ kind: 'loop', loop: li, edge: i, forward: true })))
    : [region.outer, ...region.holes];
  const byIndex = new Map<number, Curve>();
  const imprint = body.imprints.get(face.id);
  let i = 0;
  for (const contour of contours) {
    for (const ref of contour) {
      let curveId: CurveId | null = null;
      if (ref.kind === 'loop') {
        const loop = face.loops[ref.loop];
        const a = loop?.[ref.edge], b = loop?.[(ref.edge + 1) % (loop?.length ?? 1)];
        if (a && b) curveId = edgeRecordForSegment(body, face.id, a, b)?.curveId ?? null;
      } else {
        curveId = imprint?.edges.get(ref.edgeId)?.curveId ?? null;
      }
      const c = curveId !== null ? body.curves.get(curveId) : undefined;
      if (c) byIndex.set(i, c);
      i++;
    }
  }
  return { byIndex, next: contourSuccessors(contours.map((c) => c.length)) };
}

/**
 * After the mesh is reconciled: side faces extruded from the edges of one Curve become a
 * SurfaceRecord (not for polygons, whose sides stay hard) with soft+smooth edges between
 * consecutive sides (wrapping for closed curves). Every "rim" face (a face adjacent to all of
 * the curve's sides: the near cap, the far cap, or the opposite face of a through-hole) gets a
 * copy of the Curve on its boundary edge records, centred on that face's plane.
 */
function markCurveSurfaces(draft: DocumentDraft, body: Body, result: PushPullResult, boundary: BoundaryCurves): void {
  if (boundary.byIndex.size === 0) return;
  const sides = new Map<CurveId, { index: number; faceId: FaceLocalId }[]>();
  for (const [fidStr, index] of Object.entries(result.sideFaceForBoundaryEdge)) {
    const faceId = Number(fidStr) as FaceLocalId;
    if (!body.faces.has(faceId)) continue;
    const c = boundary.byIndex.get(index);
    if (!c) continue;
    const l = sides.get(c.id);
    if (l) l.push({ index, faceId });
    else sides.set(c.id, [{ index, faceId }]);
  }
  if (sides.size === 0) return;
  const edgesBetween = new Map<string, EdgeRecord[]>();
  const adjacent = new Map<FaceLocalId, Set<FaceLocalId>>();
  for (const e of body.edges.values()) {
    const k = `${Math.min(e.faceA, e.faceB)}:${Math.max(e.faceA, e.faceB)}`;
    const l = edgesBetween.get(k);
    if (l) l.push(e);
    else edgesBetween.set(k, [e]);
    (adjacent.get(e.faceA) ?? adjacent.set(e.faceA, new Set()).get(e.faceA)!).add(e.faceB);
    (adjacent.get(e.faceB) ?? adjacent.set(e.faceB, new Set()).get(e.faceB)!).add(e.faceA);
  }
  const between = (a: FaceLocalId, b: FaceLocalId): EdgeRecord[] => edgesBetween.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? [];

  for (const list of sides.values()) {
    const curve = boundary.byIndex.get(list[0]!.index)!;
    list.sort((x, y) => x.index - y.index);
    const faceOfIndex = new Map(list.map((s) => [s.index, s.faceId]));
    const sideSet = new Set(list.map((s) => s.faceId));
    let capCurveId: CurveId | null = null;
    if (list.length >= 2) {
      for (const [fid, face] of body.faces) {
        if (sideSet.has(fid)) continue;
        const adj = adjacent.get(fid);
        if (!adj || !list.every((s) => adj.has(s.faceId))) continue;
        const refs: EdgeRecord[] = [];
        for (const s of list) refs.push(...between(fid, s.faceId));
        if (!refs.length) continue;
        const id = allocId<CurveId>(draft);
        const center = planeProject(face.plane, curve.center);
        body.curves.set(id, {
          id,
          kind: curve.kind,
          center,
          normal: [curve.normal[0], curve.normal[1], curve.normal[2]],
          radius: curve.radius,
          startAngle: curve.startAngle,
          endAngle: curve.endAngle,
          segments: curve.segments,
          edgeRefs: refs.map((r) => r.key),
        });
        for (const r of refs) r.curveId = id;
        capCurveId ??= id;
      }
    }
    if (curve.kind === 'polygon') continue; // Extruded polygons keep hard edges
    const shared = body.faces.get(list[0]!.faceId)?.surfaceId ?? null;
    const reuse = shared !== null && list.every((s) => body.faces.get(s.faceId)?.surfaceId === shared) ? body.surfaces.get(shared) : undefined;
    const sid = reuse ? reuse.id : allocId<SurfaceId>(draft);
    if (reuse) {
      reuse.faceIds = list.map((s) => s.faceId);
      reuse.curveId = capCurveId ?? reuse.curveId;
    } else body.surfaces.set(sid, { id: sid, faceIds: list.map((s) => s.faceId), curveId: capCurveId });
    for (const s of list) {
      const f = body.faces.get(s.faceId);
      if (f) f.surfaceId = sid;
      const nextIndex = boundary.next.get(s.index);
      const nextFace = nextIndex === undefined ? undefined : faceOfIndex.get(nextIndex);
      if (nextFace === undefined || nextFace === s.faceId) continue;
      for (const e of between(s.faceId, nextFace)) {
        e.soft = true;
        e.smooth = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Apply

/**
 * Apply a kernel result for `plan` to the document in one transaction. Exported for tests and
 * for callers that already hold a result; `pushpull.apply` is the command wrapper.
 */
export function applyPushPullResult(draft: DocumentDraft, plan: PushPullPlan, result: PushPullResult): PushPullApplyResult {
  const container = draftContainerAt(draft, plan.path);
  const bodyIds: number[] = [];

  if (plan.kind === 'sketch') {
    const face = container.sketch.faces.get(plan.face.id);
    if (!face) throw new PushFormError('pushpull.stale', 'The sketch face changed before Push/Pull could be applied');
    const plusN = plan.request.distance > 0 ? TOOL_FAR_CAP : TOOL_NEAR_CAP;
    const minusN = plan.request.distance > 0 ? TOOL_NEAR_CAP : TOOL_FAR_CAP;
    const boundary = sketchBoundaryCurves(container.sketch, face);
    const tiles = textureTiles(draft);
    for (const c of result.components) {
      const body = bodyFromMesh(draft, toMesh(c.mesh), { container: asDraft(container), tagId: face.tagId });
      for (const [fid, rec] of body.faces) {
        if (hasOrigin(c, fid, result.toolRunId, plusN)) {
          rec.frontMaterialId = face.frontMaterialId;
          rec.uv = uvRebase(face.uv, face.basis, rec.basis, tiles(face.frontMaterialId));
        } else if (hasOrigin(c, fid, result.toolRunId, minusN)) {
          // the cap facing -n shows the sheet's back side, placed as it was in the sheet's basis
          rec.frontMaterialId = face.backMaterialId;
          rec.uv = uvRebase(face.uvBack ?? face.uv, face.basis, rec.basis, tiles(face.backMaterialId));
        }
      }
      markCurveSurfaces(draft, body, result, boundary);
      bodyIds.push(body.id);
    }
    const g = sketchGraphAt(draft, plan.path);
    const edgeIds = sketchFaceEdgeIds(face);
    g.removeFace(face.id);
    for (const eid of edgeIds) if (g.facesUsingEdge(eid).length === 0) g.removeEdge(eid);
    return { bodyIds };
  }

  const current = container.bodies.get(plan.body.id);
  if (!current || current.version !== plan.body.version) {
    throw new PushFormError('pushpull.stale', 'The body changed before Push/Pull could be applied');
  }
  const [first, ...extras] = result.components;
  if (plan.request.mode === 'newBody') {
    for (const c of result.components) bodyIds.push(bodyFromComponent(draft, container, c, plan.body, result.bodyRunId).id);
    return { bodyIds };
  }
  if (!first) {
    removeBody(container, plan.body.id);
    return { bodyIds };
  }
  const boundary = bodyBoundaryCurves(plan.body, plan.face, plan.region, plan.request.region.regionIsWholeFace);
  const updated = applyKernelResult(draft, plan.body.id, toKernelResult(first, result.bodyRunId));
  updated.nextFaceId = Math.max(updated.nextFaceId, result.nextFaceId);
  if (!plan.request.region.regionIsWholeFace) {
    relocateImprints(updated, plan.face.id, plan.region, first, result.toolRunId);
  }
  markCurveSurfaces(draft, updated, result, boundary);
  bodyIds.push(updated.id);
  for (const c of extras) bodyIds.push(bodyFromComponent(draft, container, c, plan.body, result.bodyRunId).id);
  return { bodyIds };
}

/**
 * Push/Pull a body face region or a sketch face of the current edit context. `distance` is along
 * the face's world normal. Async: the kernel runs first, then the document edit is recorded as one
 * undo entry ("Push/Pull"). Returns `{ bodyIds }`.
 */
export const pushPullApply = defineCommand({
  id: 'pushpull.apply',
  title: 'Push/Pull',
  category: 'edit',
  params: PushPullApplyParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<PushPullApplyResult> {
    const host = hostOf(ctx);
    const kernel = kernelOf(ctx);
    requireContextPath(host, p.target.path, 'Face');
    const plan = planPushPull(host.doc.state, p.target, p.distance, p.mode);
    const result = p.precomputed ?? (await runPushPullKernel(kernel, plan));
    return host.transact('Push/Pull', () => host.edit('Push/Pull', (draft) => applyPushPullResult(draft, plan, result)));
  },
});

/** Kernel-only preview of a push/pull (no document change); returns the components for the ghost. */
export const pushPullPreview = defineCommand({
  id: 'pushpull.preview',
  title: 'Push/Pull Preview',
  category: 'internal',
  params: z.object({ target: PushPullTargetSchema, distance: z.number().finite(), mode: modeSchema }),
  undoable: false,
  run(ctx, p): Promise<PushPullResult> {
    const host = hostOf(ctx);
    requireContextPath(host, p.target.path, 'Face');
    const plan = planPushPull(host.doc.state, p.target, p.distance, p.mode);
    return runPushPullKernel(kernelOf(ctx), plan, true);
  },
});

export const pushPullCommands = [pushPullApply, pushPullPreview];
