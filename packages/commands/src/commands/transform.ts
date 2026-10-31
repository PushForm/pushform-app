// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Box3, FaceLocalId, Id, Mat4, MMat4, MeshData, PlaneBasis, Vec3 } from '@pushform/core';
import {
  ANGLE_TOL,
  AREA_TOL,
  basisToLocal,
  basisToWorld,
  box3Center,
  box3Empty,
  box3Expand,
  box3IsEmpty,
  COPLANAR_TOL,
  LENGTH_TOL,
  m4mul,
  m4rotationAxis,
  m4scaling,
  m4transformDir,
  m4transformPoint,
  m4translation,
  meshBounds,
  meshClone,
  planeBasis,
  planeDistance,
  planeFromPointNormal,
  PushFormError,
  v3add,
  v3anyPerpendicular,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3parallel,
  v3scale,
  v3sub,
} from '@pushform/core';
import { cellKey } from '@pushform/geom';
import type { AutofoldRequest, ComponentsResult, KernelClient, KernelComponent, MeshWire, PushPullResult } from '@pushform/kernel';
import { KernelError, toMeshWire } from '@pushform/kernel';
import * as model from '@pushform/model';
import type {
  Body,
  ComponentInstance,
  DocumentDraft,
  DocumentState,
  Draft,
  EntityContainer,
  EntityRef,
  FaceRecord,
  KernelFaceOrigin,
  KernelResult,
  LoopRef,
  MeshPart,
  MeshPartGeometry,
  Sketch,
  SketchGraph as SketchGraphType,
  TextureTileOf,
} from '@pushform/model';
import { allocId, applyKernelResult, bodyFromMesh, containerAt, entityRefKey, imageEntityCorners, loopPoints, loopVertexIds, meshPartBounds, planeOrigin, reconcileBody } from '@pushform/model';
import { mapNormal, mapSectionPlane } from './sectionPlanes';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, kernelOf } from '../host/services';
import type { DocumentHost } from '../host/DocumentHost';
import { contextFrame, draftContainerAt, requireContextPath, samePath, sketchGraphAt } from './context';
import { EntityRefSchema } from './sketch';
import { applyPushPullResult, planPushPull, runPushPullKernel, type PushPullPlan, type PushPullTarget } from './pushpull';

// ---------------------------------------------------------------------------------------------
// Params

/** Column-major 4x4 affine matrix (16 finite numbers). */
export const Mat4Schema = z.array(z.number().finite()).length(16);

const refsSchema = z.array(EntityRefSchema).optional();

export const TransformApplyParamsSchema = z.object({
  /** Entities to transform; defaults to the current selection. */
  refs: refsSchema,
  matrix: Mat4Schema,
  /** Duplicate the entities first and transform the copies (they become the selection). */
  copy: z.boolean().default(false),
  /** Undo label: "Move", "Rotate", "Scale", … */
  label: z.string().default('Move'),
});
export type TransformApplyParams = z.infer<typeof TransformApplyParamsSchema>;

export const TransformArrayParamsSchema = z.object({
  refs: refsSchema,
  /** The transform of the first copy (external) or of the whole run (internal). */
  matrix: Mat4Schema,
  count: z.number().int().min(1),
  /** `external`: copies at matrix^k, k = 1..count. `internal`: count copies dividing the matrix. */
  mode: z.enum(['external', 'internal']),
  label: z.string().default('Move'),
});
export type TransformArrayParams = z.infer<typeof TransformArrayParamsSchema>;

export const FlipAlongParamsSchema = z.object({
  refs: refsSchema,
  axis: z.enum(['x', 'y', 'z']),
});
export type FlipAlongParams = z.infer<typeof FlipAlongParamsSchema>;

export interface TransformApplyResult {
  /** The entities that were transformed (the copies when `copy` was set). */
  refs: EntityRef[];
  /** Bodies created or modified by the operation. */
  bodyIds: number[];
  /** Mesh parts created or modified by the operation. */
  meshPartIds: number[];
}

type RefParam = z.infer<typeof EntityRefSchema>;

/** Validated ref params → runtime refs (id brands and per-kind field narrowing). */
export function toEntityRefs(refs: readonly RefParam[]): EntityRef[] {
  return refs.map((r): EntityRef => {
    const path = r.path as Id[], id = r.id as Id;
    switch (r.kind) {
      case 'face':
        return { kind: 'face', path, id, faceId: r.faceId as FaceLocalId, region: r.region ?? null };
      case 'edge':
        return { kind: 'edge', path, id, edgeKey: r.edgeKey as model.EdgeKey };
      case 'imprintEdge':
        return { kind: 'imprintEdge', path, id, faceId: r.faceId as FaceLocalId, edgeId: r.edgeId ?? 0 };
      default:
        return { kind: r.kind, path, id };
    }
  });
}

function refsOrSelection(host: DocumentHost, refs: readonly RefParam[] | undefined): EntityRef[] {
  return refs ? toEntityRefs(refs) : host.selection.refs;
}

// ---------------------------------------------------------------------------------------------
// PolyMesh module (autofold). Provided by `@pushform/model` (`PolyMesh.ts`); resolved at runtime so
// this package type-checks before it lands. Tests may inject a stub with `setPolyMeshModule`.

export interface PolyMesh {
  verts: Vec3[];
  faces: { faceId: FaceLocalId; loops: number[][] }[];
}

export interface PolyMeshModule {
  polyMeshFromBody(body: Body): PolyMesh;
  polyVerticesForRef(body: Body, poly: PolyMesh, ref: EntityRef): number[];
  transformVertices(poly: PolyMesh, indices: number[], m: Mat4): PolyMesh | void;
  foldAndTriangulate(poly: PolyMesh): { mesh: MeshData; faceOrigin: Map<FaceLocalId, FaceLocalId>; nextFaceId: number };
}

function detectPolyMeshModule(): PolyMeshModule | null {
  const m = model as unknown as Record<string, unknown>;
  const ok = ['polyMeshFromBody', 'polyVerticesForRef', 'transformVertices', 'foldAndTriangulate'].every((k) => typeof m[k] === 'function');
  return ok ? (m as unknown as PolyMeshModule) : null;
}

let polyMeshModule: PolyMeshModule | null = detectPolyMeshModule();

/** Override (or restore with `null`) the PolyMesh implementation used for autofold. */
export function setPolyMeshModule(mod: PolyMeshModule | null): void {
  polyMeshModule = mod ?? detectPolyMeshModule();
}

export function getPolyMeshModule(): PolyMeshModule | null {
  return polyMeshModule;
}

// ---------------------------------------------------------------------------------------------
// Matrix helpers

const col = (m: ArrayLike<number>, c: number): Vec3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];

export function m4linearDeterminant(m: ArrayLike<number>): number {
  return v3dot(col(m, 0), v3cross(col(m, 1), col(m, 2)));
}

/** True for rotations + translations (orthonormal linear part, positive determinant). */
export function isRigidTransform(m: ArrayLike<number>, tol = 1e-9): boolean {
  const c = [col(m, 0), col(m, 1), col(m, 2)];
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      const d = v3dot(c[i]!, c[j]!);
      if (Math.abs(d - (i === j ? 1 : 0)) > tol) return false;
    }
  }
  return m4linearDeterminant(m) > 0;
}

/** True when the linear part is the identity (a pure translation). */
export function isTranslation(m: ArrayLike<number>, tol = 1e-9): boolean {
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      if (Math.abs(m[c * 4 + r]! - (c === r ? 1 : 0)) > tol) return false;
    }
  }
  return true;
}

export function m4power(m: Mat4 | MMat4, k: number): MMat4 {
  let out: MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < k; i++) out = m4mul(m, out);
  return out;
}

/** Rotation by `angle` (radians) about the line through `center` along `axis`. */
export function m4rotationAbout(center: Vec3, axis: Vec3, angle: number): MMat4 {
  return m4mul(m4translation(center), m4mul(m4rotationAxis(axis, angle), m4translation(v3scale(center, -1))));
}

/** Scale by per-axis factors about `anchor`. */
export function m4scaleAbout(anchor: Vec3, factors: Vec3): MMat4 {
  return m4mul(m4translation(anchor), m4mul(m4scaling(factors), m4translation(v3scale(anchor, -1))));
}

/** Axis and angle (radians, in [0, π]) of a rotation matrix's linear part. */
export function rotationAxisAngle(m: ArrayLike<number>): { axis: Vec3; angle: number } {
  const R = (r: number, c: number): number => m[c * 4 + r]!;
  const trace = R(0, 0) + R(1, 1) + R(2, 2);
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  const s = Math.sin(angle);
  if (s > 1e-6) {
    return { axis: v3normalize([R(2, 1) - R(1, 2), R(0, 2) - R(2, 0), R(1, 0) - R(0, 1)]), angle };
  }
  if (angle < 1e-6) return { axis: [0, 0, 1], angle: 0 };
  // angle ≈ π: axis from the symmetric part
  const ax = Math.sqrt(Math.max(0, (R(0, 0) + 1) / 2));
  const ay = Math.sqrt(Math.max(0, (R(1, 1) + 1) / 2));
  const az = Math.sqrt(Math.max(0, (R(2, 2) + 1) / 2));
  const axis: Vec3 =
    ax >= ay && ax >= az
      ? [ax, R(0, 1) / (2 * ax), R(0, 2) / (2 * ax)]
      : ay >= az
        ? [R(0, 1) / (2 * ay), ay, R(1, 2) / (2 * ay)]
        : [R(0, 2) / (2 * az), R(1, 2) / (2 * az), az];
  return { axis: v3normalize(axis), angle };
}

/**
 * The n-th root of a rigid motion (translation, rotation about a line, or screw) so that
 * `root^n = m`. Scale matrices are not supported (`transform.arrayUnsupported`).
 */
export function rigidMatrixRoot(m: Mat4 | MMat4, n: number): MMat4 {
  if (n <= 1) return [...m];
  const t: Vec3 = [m[12]!, m[13]!, m[14]!];
  if (isTranslation(m)) return m4translation(v3scale(t, 1 / n));
  if (!isRigidTransform(m)) throw new PushFormError('transform.arrayUnsupported', 'Internal arrays support moves and rotations only');
  const { axis, angle } = rotationAxisAngle(m);
  const tPar = v3scale(axis, v3dot(t, axis));
  const tPerp = v3sub(t, tPar);
  // Fixed point c of the in-plane motion: (I - R2) c2 = t2 in the plane perpendicular to the axis.
  const p = v3anyPerpendicular(axis), q = v3cross(axis, p);
  const tx = v3dot(tPerp, p), ty = v3dot(tPerp, q);
  const c = Math.cos(angle), s = Math.sin(angle);
  const det = 2 * (1 - c);
  const cx = ((1 - c) * tx - s * ty) / det, cy = (s * tx + (1 - c) * ty) / det;
  const center = v3add(v3scale(p, cx), v3scale(q, cy));
  return m4mul(m4translation(v3scale(tPar, 1 / n)), m4rotationAbout(center, axis, angle / n));
}

/** Transforms of the copies of an array: external `m^k`, internal `root(m, count)^k`, k = 1..count. */
export function arrayMatrices(m: Mat4 | MMat4, count: number, mode: 'external' | 'internal'): MMat4[] {
  const step = mode === 'internal' ? rigidMatrixRoot(m, count) : [...m];
  const out: MMat4[] = [];
  for (let k = 1; k <= count; k++) out.push(m4power(step, k));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bounds

function containerFor(state: DocumentState, path: readonly Id[]): EntityContainer {
  try {
    return containerAt(state, path);
  } catch (e) {
    throw new PushFormError('transform.context', e instanceof Error ? e.message : String(e));
  }
}

/** Points (in the coordinates of its container) spanned by an entity: mesh corners, loops, polylines, vertices. */
function* refPoints(state: DocumentState, container: EntityContainer, ref: EntityRef): Generator<Vec3> {
  const sketch = container.sketch;
  switch (ref.kind) {
    case 'body': {
      const body = container.bodies.get(ref.id);
      if (!body) break;
      const mb = meshBounds(body.mesh);
      if (!box3IsEmpty(mb)) yield* boxCorners(mb);
      break;
    }
    case 'meshPart': {
      const part = container.meshParts.get(ref.id);
      const pb = part && meshPartBounds(part.geometry);
      if (pb) yield* boxCorners(pb);
      break;
    }
    case 'face': {
      const f = container.bodies.get(ref.id)?.faces.get(ref.faceId);
      for (const loop of f?.loops ?? []) yield* loop;
      break;
    }
    case 'edge': {
      const e = container.bodies.get(ref.id)?.edges.get(ref.edgeKey);
      if (e) yield* e.polyline;
      break;
    }
    case 'sketchVertex': {
      const v = sketch.vertices.get(ref.id);
      if (v) yield v.p;
      break;
    }
    case 'sketchEdge': {
      const e = sketch.edges.get(ref.id);
      const a = e && sketch.vertices.get(e.a), c = e && sketch.vertices.get(e.b);
      if (a) yield a.p;
      if (c) yield c.p;
      break;
    }
    case 'sketchFace': {
      const f = sketch.faces.get(ref.id);
      if (f) for (const loop of f.loops) yield* loopPoints(sketch, loop);
      break;
    }
    case 'instance': {
      const inst = container.instances.get(ref.id);
      if (!inst) break;
      const lb = definitionBounds(state, inst.definitionId);
      if (lb) for (const c of boxCorners(lb)) yield m4transformPoint(inst.transform, c);
      break;
    }
    case 'guide': {
      const g = container.guides.get(ref.id);
      if (!g) break;
      yield g.origin;
      if (g.kind === 'segment') yield g.end;
      break;
    }
    case 'image': {
      const image = container.images.get(ref.id);
      if (image) yield* imageEntityCorners(image);
      break;
    }
    default:
      break;
  }
}

function* boxCorners(b: Box3): Generator<Vec3> {
  for (let i = 0; i < 8; i++) yield [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
}

/** Local bounds of a definition: bodies, sketch vertices, pictures, guides and nested instances (recursive, cycle-safe). */
export function definitionBounds(state: DocumentState, definitionId: number, seen: Set<number> = new Set()): Box3 | null {
  if (seen.has(definitionId)) return null;
  const def = state.definitions.get(definitionId as never);
  if (!def) return null;
  seen.add(definitionId);
  const b = box3Empty();
  for (const body of def.entities.bodies.values()) {
    const mb = meshBounds(body.mesh);
    if (!box3IsEmpty(mb)) for (const c of boxCorners(mb)) box3Expand(b, c);
  }
  for (const part of def.entities.meshParts.values()) {
    const pb = meshPartBounds(part.geometry);
    if (pb) for (const c of boxCorners(pb)) box3Expand(b, c);
  }
  for (const v of def.entities.sketch.vertices.values()) box3Expand(b, v.p);
  for (const image of def.entities.images.values()) for (const p of imageEntityCorners(image)) box3Expand(b, p);
  for (const g of def.entities.guides.values()) {
    box3Expand(b, g.origin);
    if (g.kind === 'segment') box3Expand(b, g.end);
  }
  for (const inst of def.entities.instances.values()) {
    const lb = definitionBounds(state, inst.definitionId, seen);
    if (lb) for (const c of boxCorners(lb)) box3Expand(b, m4transformPoint(inst.transform, c));
  }
  seen.delete(definitionId);
  return box3IsEmpty(b) ? null : b;
}

/** World axis-aligned bounds of a set of entities (any contexts), or null when nothing has geometry. */
export function refsBounds(state: DocumentState, refs: readonly EntityRef[]): Box3 | null {
  const b = box3Empty();
  for (const ref of refs) {
    let container: EntityContainer;
    try {
      container = containerAt(state, ref.path);
    } catch {
      continue;
    }
    const frame = contextFrame(state, ref.path);
    for (const p of refPoints(state, container, ref)) box3Expand(b, frame.toWorld(p));
  }
  return box3IsEmpty(b) ? null : b;
}

/** Common instance path of a set of refs (`context.mismatch` when they span several contexts). */
export function commonPath(refs: readonly EntityRef[], fallback: readonly Id[] = []): readonly Id[] {
  const first = refs[0];
  if (!first) return fallback;
  for (const r of refs) {
    if (!samePath(r.path, first.path)) throw new PushFormError('context.mismatch', 'Entities of different groups/components cannot be transformed together');
  }
  return first.path;
}

// ---------------------------------------------------------------------------------------------
// Planning

export interface TransformPlan {
  label: string;
  /** Edit context (instance path) the entities live in. */
  path: readonly Id[];
  /** The transform in context-local coordinates (`inv · world · ctx`). */
  matrix: MMat4;
  /** The transform as given (world coordinates). */
  worldMatrix: MMat4;
  rigid: boolean;
  copy: boolean;
  /** Whole bodies with the version they had when planned (stale check). */
  bodies: Map<Id, number>;
  /** Whole mesh parts (transformed in the model, kernel-free, mirrored or scaled alike). */
  meshPartIds: Id[];
  instances: Id[];
  /** Sketch vertices to move (non-copy) … */
  sketchVertexIds: Id[];
  /** … or sketch edges to duplicate (copy). */
  sketchEdgeIds: Id[];
  /** Body faces/edges to autofold, per body. */
  subEntities: Map<Id, EntityRef[]>;
  /** Section planes, moved like guides. */
  sectionPlaneIds: Id[];
  /** Placed pictures, moved, turned and scaled whole. */
  imageIds: Id[];
  /** Dimensions. */
  dimensionIds: Id[];
  /** A single body face moved along its normal with perpendicular neighbours: push/pull instead. */
  pushPull: { target: PushPullTarget; distance: number } | null;
}

/**
 * How far a dimension's line moves when the dimension is dragged by `t` on its own: the part of `t` in its
 * plane, across its measured segment for a linear dimension (along it, the line stays between its extension lines).
 */
export function dimensionDrag(state: DocumentState, container: EntityContainer, dim: model.Dimension, t: Vec3): Vec3 {
  const n = v3normalize(dim.normal);
  let d = v3sub(t, v3scale(n, v3dot(t, n)));
  if (dim.kind === 'linear') {
    const at = model.resolveDimension(state, container, dim);
    const along = v3sub(at.end, at.start);
    if (v3len(along) > LENGTH_TOL) {
      const u = v3normalize(along);
      d = v3sub(d, v3scale(u, v3dot(d, u)));
    }
  }
  return d;
}

/** Push/pull routing rule: one face, pure translation along its normal (context-local), all neighbours perpendicular. */
function pushPullRoute(container: EntityContainer, path: readonly Id[], refs: readonly EntityRef[], m: ArrayLike<number>): TransformPlan['pushPull'] {
  const ref = refs[0];
  if (refs.length !== 1 || !ref || ref.kind !== 'face' || !isTranslation(m)) return null;
  const body = container.bodies.get(ref.id);
  const face = body?.faces.get(ref.faceId);
  if (!body || !face) return null;
  const t: Vec3 = [m[12]!, m[13]!, m[14]!];
  const n = face.plane.n;
  if (v3len(t) <= COPLANAR_TOL || !v3parallel(t, n, ANGLE_TOL)) return null;
  for (const e of body.edges.values()) {
    if (e.faceA !== ref.faceId && e.faceB !== ref.faceId) continue;
    const other = body.faces.get(e.faceA === ref.faceId ? e.faceB : e.faceA);
    if (!other || Math.abs(v3dot(other.plane.n, n)) > ANGLE_TOL) return null;
  }
  return { target: { kind: 'face', path: [...path], id: ref.id, faceId: ref.faceId, region: ref.region }, distance: v3dot(t, n) };
}

/**
 * Resolve refs against the state into a plan. Pure. `matrix` is a world transform; the refs must
 * share one context (their `path`), in whose coordinates the plan's `matrix` is expressed.
 */
export function planTransform(state: DocumentState, refs: readonly EntityRef[], matrix: ArrayLike<number>, copy: boolean, label: string): TransformPlan {
  const world: MMat4 = Array.from(matrix);
  if (world.length !== 16) throw new PushFormError('transform.matrix', 'matrix must have 16 numbers');
  const path = commonPath(refs);
  const frame = contextFrame(state, path);
  const m: MMat4 = frame.identity ? world : m4mul(frame.inverse, m4mul(world, frame.matrix));
  const plan: TransformPlan = {
    label,
    path,
    matrix: m,
    worldMatrix: world,
    rigid: isRigidTransform(m),
    copy,
    bodies: new Map(),
    meshPartIds: [],
    instances: [],
    sketchVertexIds: [],
    sketchEdgeIds: [],
    subEntities: new Map(),
    sectionPlaneIds: [],
    imageIds: [],
    dimensionIds: [],
    pushPull: null,
  };
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const k = entityRefKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const vertexIds = new Set<Id>(), edgeIds = new Set<Id>();
  const container = containerFor(state, path);
  for (const ref of unique) {
    const sketch = container.sketch;
    switch (ref.kind) {
      case 'body': {
        const body = container.bodies.get(ref.id);
        if (body) plan.bodies.set(ref.id, body.version);
        break;
      }
      case 'meshPart':
        if (container.meshParts.has(ref.id)) plan.meshPartIds.push(ref.id);
        break;
      case 'instance':
        if (container.instances.has(ref.id)) plan.instances.push(ref.id);
        break;
      case 'sketchVertex':
        if (sketch.vertices.has(ref.id)) vertexIds.add(ref.id);
        break;
      case 'sectionPlane':
        if (container.sectionPlanes.has(ref.id)) plan.sectionPlaneIds.push(ref.id);
        break;
      case 'image':
        if (container.images.has(ref.id)) plan.imageIds.push(ref.id);
        break;
      case 'dimension':
        if (container.dimensions.has(ref.id)) plan.dimensionIds.push(ref.id);
        break;
      case 'sketchEdge': {
        const e = sketch.edges.get(ref.id);
        if (!e) break;
        vertexIds.add(e.a);
        vertexIds.add(e.b);
        edgeIds.add(e.id);
        break;
      }
      case 'sketchFace': {
        const f = sketch.faces.get(ref.id);
        if (!f) break;
        for (const loop of f.loops) {
          for (const r of loop) edgeIds.add(r.edgeId);
          for (const v of loopVertexIds(sketch, loop)) vertexIds.add(v);
        }
        break;
      }
      case 'face':
      case 'edge': {
        const body = container.bodies.get(ref.id);
        if (!body) break;
        const exists = ref.kind === 'face' ? body.faces.has(ref.faceId) : body.edges.has(ref.edgeKey);
        if (!exists) throw new PushFormError('transform.target', `${ref.kind} not found on body ${ref.id}`);
        const list = plan.subEntities.get(ref.id) ?? [];
        list.push(ref);
        plan.subEntities.set(ref.id, list);
        break;
      }
      default:
        throw new PushFormError('transform.unsupported', `Cannot transform entities of kind "${ref.kind}" yet`);
    }
  }
  plan.sketchVertexIds = [...vertexIds];
  plan.sketchEdgeIds = [...edgeIds];
  // Sub-entities of a body that is itself moved go with the body.
  for (const id of plan.bodies.keys()) plan.subEntities.delete(id);
  if (copy && plan.subEntities.size) {
    throw new PushFormError('transform.copySubEntity', 'Copying faces or edges of a solid is not supported');
  }
  if (!copy && plan.subEntities.size === 1 && plan.bodies.size === 0 && plan.meshPartIds.length === 0 && plan.instances.length === 0 && vertexIds.size === 0) {
    plan.pushPull = pushPullRoute(container, path, unique, m);
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Kernel phase

interface BodyKernelWork {
  result: ComponentsResult;
  /** runId the body was uploaded as (its faceOrigin entries refer to it). */
  selfRunId: number | undefined;
  /** Autofold only: split face id → original face id. */
  foldOrigin: Map<FaceLocalId, FaceLocalId> | null;
}

export interface TransformKernelWork {
  pushPull: { plan: PushPullPlan; result: PushPullResult } | null;
  bodies: Map<Id, BodyKernelWork>;
}

const invalidSolid = (details?: unknown): PushFormError =>
  new PushFormError('transform.invalidSolid', 'Would create an invalid solid', details);

/** `kernel.autofold` when the client has it, else validate + normalize through `fromTriangles`. */
async function runAutofoldKernel(kernel: KernelClient, body: Body, mesh: MeshData, nextFaceId: number): Promise<ComponentsResult> {
  const k = kernel as KernelClient & { autofold?: (p: Omit<AutofoldRequest, 'type'>) => Promise<ComponentsResult> };
  const wire: MeshWire = toMeshWire(mesh);
  if (typeof k.autofold === 'function') {
    try {
      await kernel.ensureBody(body.id, body.version, body.mesh);
      return await k.autofold({ body: { bodyId: body.id, version: body.version }, mesh: wire, nextFaceId });
    } catch (e) {
      if (!(e instanceof KernelError) || e.code !== 'NotImplemented') throw e instanceof KernelError ? invalidSolid(e.toInfo()) : e;
    }
  }
  const r = await kernel.fromTriangles({ mesh: wire, nextFaceId });
  if (r.status !== 'NoError') throw invalidSolid({ status: r.status });
  return { components: r.components, nextFaceId: r.nextFaceId };
}

/** Run every kernel op the plan needs (before the transaction). */
export async function runTransformKernel(kernel: KernelClient, state: DocumentState, plan: TransformPlan): Promise<TransformKernelWork> {
  const work: TransformKernelWork = { pushPull: null, bodies: new Map() };
  const container = containerFor(state, plan.path);
  if (plan.pushPull) {
    const pp = planPushPull(state, plan.pushPull.target, plan.pushPull.distance, 'merge', 'local');
    work.pushPull = { plan: pp, result: await runPushPullKernel(kernel, pp) };
    return work;
  }
  if (!plan.rigid) {
    for (const id of plan.bodies.keys()) {
      const body = container.bodies.get(id);
      if (!body) continue;
      const selfRunId = await kernel.ensureBody(body.id, body.version, body.mesh);
      let result: ComponentsResult;
      try {
        result = await kernel.transform({ body: { bodyId: body.id, version: body.version }, matrix: plan.matrix, nextFaceId: body.nextFaceId });
      } catch (e) {
        throw e instanceof KernelError ? invalidSolid(e.toInfo()) : e;
      }
      work.bodies.set(id, { result, selfRunId, foldOrigin: null });
    }
  }
  for (const [id, refs] of plan.subEntities) {
    const body = container.bodies.get(id);
    if (!body) continue;
    const mod = polyMeshModule;
    if (!mod) throw new PushFormError('transform.autofoldUnavailable', 'Moving faces and edges of a solid is not available yet');
    const poly = mod.polyMeshFromBody(body);
    const indices = new Set<number>();
    for (const ref of refs) for (const i of mod.polyVerticesForRef(body, poly, ref)) indices.add(i);
    const moved = mod.transformVertices(poly, [...indices], plan.matrix as unknown as Mat4) ?? poly;
    const fold = mod.foldAndTriangulate(moved);
    const result = await runAutofoldKernel(kernel, body, fold.mesh, Math.max(fold.nextFaceId, body.nextFaceId));
    work.bodies.set(id, { result, selfRunId: undefined, foldOrigin: fold.faceOrigin });
  }
  return work;
}

// ---------------------------------------------------------------------------------------------
// Apply phase (inside the transaction)

const toMesh = (m: MeshWire): MeshData => ({ verts: m.verts, tris: m.tris, faceId: m.faceId });

function toKernelResult(c: KernelComponent, w: BodyKernelWork): KernelResult {
  const faceOrigin = new Map<FaceLocalId, KernelFaceOrigin[]>();
  for (const [fid, origins] of c.faceOrigin) {
    faceOrigin.set(
      fid as FaceLocalId,
      origins.map((o) => ({ runId: o.runId, faceId: (w.foldOrigin?.get(o.faceId as FaceLocalId) ?? o.faceId) as FaceLocalId })),
    );
  }
  const r: KernelResult = { mesh: toMesh(c.mesh), faceOrigin, props: c.props };
  if (w.selfRunId !== undefined) r.selfRunId = w.selfRunId;
  return r;
}

/** cast: inside a transaction the container is a draft; Body and Draft<Body> differ only in tuple mutability. */
const asDraft = (c: EntityContainer): Draft<EntityContainer> => c as unknown as Draft<EntityContainer>;

function removeBody(container: EntityContainer, id: Id): void {
  container.bodies.delete(id);
  container.order = container.order.filter((x) => x !== id);
}

/** New body from a kernel component, copying face attributes from `source` by origin face id. */
function bodyFromComponent(draft: DocumentDraft, container: EntityContainer, c: KernelComponent, source: Body, w: BodyKernelWork): Body {
  const body = bodyFromMesh(draft, toMesh(c.mesh), { container: asDraft(container), tagId: source.tagId, materialId: source.materialId });
  const r = toKernelResult(c, w);
  for (const [fid, rec] of body.faces) {
    const origin = (r.faceOrigin.get(fid) ?? []).find((o) => (r.selfRunId === undefined || o.runId === r.selfRunId) && source.faces.has(o.faceId));
    const src = origin ? source.faces.get(origin.faceId) : source.faces.get(fid);
    if (!src) continue;
    rec.frontMaterialId = src.frontMaterialId;
    rec.backMaterialId = src.backMaterialId;
    rec.uv = src.uv;
    if (src.uvBack) rec.uvBack = src.uvBack;
    rec.tagId = src.tagId;
  }
  body.props = c.props;
  return body;
}

const cloneVec = (p: Vec3): Vec3 => [p[0], p[1], p[2]];
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Deep copy of a body under a new id (version 0), inserted into the container. */
export function cloneBody(draft: DocumentDraft, container: EntityContainer, src: Body): Body {
  const body = copyBodyRecord(src, allocId<Id>(draft));
  body.version = 0;
  container.bodies.set(body.id, body);
  container.order.push(body.id);
  return body;
}

/** Copy of a mesh part under `id` sharing its (immutable) geometry; not inserted anywhere. */
export function copyMeshPartRecord(src: MeshPart, id: Id): MeshPart {
  return { ...src, id, source: { ...src.source }, attributes: cloneJson(src.attributes) };
}

/** Copy of a mesh part under a new id, inserted into the container. */
export function cloneMeshPart(draft: DocumentDraft, container: EntityContainer, src: MeshPart): MeshPart {
  const part = copyMeshPartRecord(src, allocId<Id>(draft));
  part.locked = false;
  container.meshParts.set(part.id, part);
  container.order.push(part.id);
  return part;
}

/**
 * Geometry of a mesh part after `m` (any affine matrix): new position and edge arrays, the rest
 * shared. A mirroring matrix reverses the triangle winding so the faces keep facing outward.
 */
export function transformMeshPartGeometry(g: MeshPartGeometry, m: Mat4 | MMat4): MeshPartGeometry {
  const mapAll = (src: Float64Array): Float64Array => {
    const out = new Float64Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const p = m4transformPoint(m, [src[i]!, src[i + 1]!, src[i + 2]!]);
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
    }
    return out;
  };
  let triangles = g.triangles;
  if (m4linearDeterminant(m) < 0) {
    triangles = new Uint32Array(g.triangles.length);
    for (let i = 0; i < triangles.length; i += 3) {
      triangles[i] = g.triangles[i]!;
      triangles[i + 1] = g.triangles[i + 2]!;
      triangles[i + 2] = g.triangles[i + 1]!;
    }
  }
  return { ...g, positions: mapAll(g.positions), edgePositions: mapAll(g.edgePositions), triangles };
}

/** Deep plain copy of a body record under `id` (same version; not inserted anywhere). */
export function copyBodyRecord(src: Body, id: Id): Body {
  const body: Body = {
    id,
    version: src.version,
    mesh: meshClone(src.mesh),
    faces: new Map(
      [...src.faces].map(([fid, f]) => [
        fid,
        {
          id: f.id,
          plane: { n: cloneVec(f.plane.n), d: f.plane.d },
          basis: { origin: cloneVec(f.basis.origin), u: cloneVec(f.basis.u), v: cloneVec(f.basis.v), n: cloneVec(f.basis.n) },
          loops: f.loops.map((l) => l.map(cloneVec)),
          frontMaterialId: f.frontMaterialId,
          backMaterialId: f.backMaterialId,
          uv: cloneJson(f.uv),
          ...(f.uvBack ? { uvBack: cloneJson(f.uvBack) } : {}),
          tagId: f.tagId,
          hidden: f.hidden,
          surfaceId: f.surfaceId,
        },
      ]),
    ),
    nextFaceId: src.nextFaceId,
    edges: new Map([...src.edges].map(([k, e]) => [k, { ...e, polyline: e.polyline.map(cloneVec) }])),
    imprints: new Map(
      [...src.imprints].map(([fid, g]) => [
        fid,
        {
          vertices: new Map([...g.vertices].map(([vid, p]) => [vid, [p[0], p[1]] as [number, number]])),
          edges: new Map([...g.edges].map(([eid, e]) => [eid, { ...e }])),
          nextId: g.nextId,
          version: g.version,
        },
      ]),
    ),
    curves: new Map([...src.curves].map(([cid, c]) => [cid, { ...c, center: cloneVec(c.center), normal: cloneVec(c.normal), edgeRefs: [...c.edgeRefs] }])),
    surfaces: new Map([...src.surfaces].map(([sid, s]) => [sid, { ...s, faceIds: [...s.faceIds] }])),
    materialId: src.materialId,
    props: { volume: src.props.volume, area: src.props.area },
    valid: src.valid,
    tagId: src.tagId,
    hidden: src.hidden,
    locked: src.locked,
    castShadows: src.castShadows,
    receiveShadows: src.receiveShadows,
    attributes: cloneJson(src.attributes),
  };
  return body;
}

/** Re-express a moved body face's texture placements (from basis `from`, points moved by `m`) in its new basis. */
function rebaseFaceUv(body: Body, face: FaceRecord, from: PlaneBasis, m: Mat4 | MMat4, tiles: TextureTileOf): void {
  const r = model.uvRebaseSides(face, from, face.basis, tiles(face.frontMaterialId ?? body.materialId), tiles(face.backMaterialId ?? body.materialId), (p) =>
    m4transformPoint(m, p),
  );
  face.uv = r.uv;
  if (r.uvBack) face.uvBack = r.uvBack;
  else delete face.uvBack;
}

/**
 * Rigid transform of a body in the model (coordinates of its container): mesh vertices, face
 * planes/bases/loops (imprints are re-expressed in the recomputed basis so they stay where they
 * were drawn), edge polylines and curves. Props are unchanged; the version is bumped. With
 * `tiles`, texture placements are re-expressed so textures move with the faces. For scaled or
 * mirrored matrices use `transformBodyAffineInPlace`.
 */
export function transformBodyInPlace(body: Body, m: Mat4 | MMat4, tiles?: TextureTileOf): void {
  const src = body.mesh.verts;
  const verts = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = m4transformPoint(m, [src[i]!, src[i + 1]!, src[i + 2]!]);
    verts[i] = p[0];
    verts[i + 1] = p[1];
    verts[i + 2] = p[2];
  }
  body.mesh = { verts, tris: body.mesh.tris, faceId: body.mesh.faceId };
  for (const face of body.faces.values()) {
    const n = v3normalize(m4transformDir(m, face.plane.n));
    const plane = planeFromPointNormal(m4transformPoint(m, planeOrigin(face.plane)), n);
    const basis = planeBasis(planeOrigin(plane), plane.n);
    const imprint = body.imprints.get(face.id);
    if (imprint) {
      for (const [vid, uv] of [...imprint.vertices]) {
        const w = m4transformPoint(m, basisToWorld(face.basis, uv[0], uv[1]));
        const l = basisToLocal(basis, w);
        imprint.vertices.set(vid, [l[0], l[1]]);
      }
      imprint.version += 1;
    }
    face.loops = face.loops.map((loop) => loop.map((p) => m4transformPoint(m, p)));
    const from = face.basis;
    face.plane = plane;
    face.basis = basis;
    if (tiles) rebaseFaceUv(body, face, from, m, tiles);
  }
  for (const e of body.edges.values()) e.polyline = e.polyline.map((p) => m4transformPoint(m, p));
  for (const c of body.curves.values()) {
    c.center = m4transformPoint(m, c.center);
    c.normal = v3normalize(m4transformDir(m, c.normal));
  }
  body.version += 1;
}

/**
 * General affine transform of a body without the kernel: vertices are mapped, the winding is
 * flipped for mirroring matrices, the face layer is rebuilt from the mesh (face ids and their
 * materials survive, edges are re-derived with their flags), imprints are re-expressed in the new
 * bases and curves follow (radius scaled by the mean axis scale). Exact for rigid motions and
 * mirrors; uniform scale keeps every solid valid; non-uniform scale is what the kernel's transform
 * would produce for planar faces. With `tiles`, texture placements are re-expressed as in
 * `transformBodyInPlace`.
 */
export function transformBodyAffineInPlace(body: Body, m: Mat4 | MMat4, tiles?: TextureTileOf): void {
  if (isRigidTransform(m)) {
    transformBodyInPlace(body, m, tiles);
    return;
  }
  const bases = new Map<FaceLocalId, PlaneBasis>([...body.faces].map(([fid, f]) => [fid, f.basis]));
  const imprintWorld = new Map<FaceLocalId, Map<number, Vec3>>();
  for (const [fid, g] of body.imprints) {
    const face = body.faces.get(fid);
    if (!face) continue;
    const pts = new Map<number, Vec3>();
    for (const [vid, uv] of g.vertices) pts.set(vid, m4transformPoint(m, basisToWorld(face.basis, uv[0], uv[1])));
    imprintWorld.set(fid, pts);
  }
  const src = body.mesh.verts;
  const verts = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = m4transformPoint(m, [src[i]!, src[i + 1]!, src[i + 2]!]);
    verts[i] = p[0];
    verts[i + 1] = p[1];
    verts[i + 2] = p[2];
  }
  let tris = body.mesh.tris;
  if (m4linearDeterminant(m) < 0) {
    tris = new Uint32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      tris[i] = body.mesh.tris[i]!;
      tris[i + 1] = body.mesh.tris[i + 2]!;
      tris[i + 2] = body.mesh.tris[i + 1]!;
    }
  }
  const curves = new Map(body.curves);
  reconcileBody(body, { mesh: { verts, tris, faceId: body.mesh.faceId }, faceOrigin: new Map() });
  if (tiles) {
    for (const [fid, face] of body.faces) {
      const from = bases.get(fid);
      if (from) rebaseFaceUv(body, face, from, m, tiles);
    }
  }
  for (const [fid, pts] of imprintWorld) {
    const face = body.faces.get(fid);
    const g = body.imprints.get(fid);
    if (!face || !g) continue;
    for (const [vid, w] of pts) {
      const l = basisToLocal(face.basis, w);
      g.vertices.set(vid, [l[0], l[1]]);
    }
    g.version += 1;
  }
  const scale = Math.cbrt(Math.abs(m4linearDeterminant(m)));
  for (const c of curves.values()) {
    const kept = body.curves.get(c.id);
    if (!kept) continue;
    kept.center = m4transformPoint(m, c.center);
    kept.normal = v3normalize(m4transformDir(m, c.normal));
    kept.radius = c.radius * scale;
  }
}

function cloneInstance(draft: DocumentDraft, container: EntityContainer, src: ComponentInstance): ComponentInstance {
  const id = allocId<Id>(draft);
  const inst: ComponentInstance = { ...src, id, transform: [...src.transform] as unknown as Mat4, attributes: cloneJson(src.attributes), locked: false };
  container.instances.set(id, inst);
  container.order.push(id);
  return inst;
}

// --- sketch -----------------------------------------------------------------------------------

function unhashVertex(sketch: Sketch, id: Id, p: Vec3, tol: number): void {
  model.materializeSketchVertexHash(sketch, tol);
  const k = cellKey(p, tol);
  const list = sketch.vertexHash.get(k);
  if (!list) return;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) sketch.vertexHash.delete(k);
}

function hashVertex(sketch: Sketch, id: Id, p: Vec3, tol: number): void {
  model.materializeSketchVertexHash(sketch, tol);
  const k = cellKey(p, tol);
  const list = sketch.vertexHash.get(k);
  if (list) list.push(id);
  else sketch.vertexHash.set(k, [id]);
}

/** Nearest vertex other than `self` within `tol` of p. */
function nearbyVertex(sketch: Sketch, self: Id, p: Vec3, tol: number): Id | undefined {
  let best: Id | undefined, bestD = tol * tol;
  for (const id of model.sketchVertexCandidates(sketch, p, tol, tol)) {
      if (id === self) continue;
      const v = sketch.vertices.get(id);
      if (!v) continue;
      const d = (v.p[0] - p[0]) ** 2 + (v.p[1] - p[1]) ** 2 + (v.p[2] - p[2]) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = id;
      }
  }
  return best;
}

/** Merge vertex `from` into `into`: redirect edges, drop collapsed/duplicate edges, fix loops. */
function mergeSketchVertex(sketch: Sketch, from: Id, into: Id, tol: number): void {
  const degenerate = new Set<Id>();
  for (const e of sketch.edges.values()) {
    if (e.a === from) e.a = into;
    if (e.b === from) e.b = into;
    if (e.a === e.b) degenerate.add(e.id);
  }
  const seen = new Map<string, Id>();
  const dup = new Map<Id, Id>();
  for (const e of sketch.edges.values()) {
    if (degenerate.has(e.id)) continue;
    const k = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`;
    const kept = seen.get(k);
    if (kept === undefined) seen.set(k, e.id);
    else dup.set(e.id, kept);
  }
  for (const f of [...sketch.faces.values()]) {
    const loops: LoopRef[][] = [];
    let dead = false;
    f.loops.forEach((loop, li) => {
      const mapped: LoopRef[] = [];
      for (const r of loop) {
        if (degenerate.has(r.edgeId)) continue;
        const kept = dup.get(r.edgeId);
        if (kept === undefined) {
          mapped.push(r);
          continue;
        }
        const keptE = sketch.edges.get(kept), dupE = sketch.edges.get(r.edgeId);
        const same = keptE && dupE ? keptE.a === dupE.a : true;
        mapped.push({ edgeId: kept, forward: same ? r.forward : !r.forward });
      }
      // an edge traversed twice in one loop (there and back) is a collapsed spur
      const count = new Map<Id, number>();
      for (const r of mapped) count.set(r.edgeId, (count.get(r.edgeId) ?? 0) + 1);
      const out = mapped.filter((r) => count.get(r.edgeId) === 1);
      if (out.length >= 3) loops.push(out);
      else if (li === 0) dead = true;
    });
    if (dead) sketch.faces.delete(f.id);
    else f.loops = loops;
  }
  for (const c of [...sketch.curves.values()]) {
    c.edgeRefs = c.edgeRefs.filter((r) => typeof r !== 'number' || !degenerate.has(r)).map((r) => (typeof r === 'number' ? (dup.get(r) ?? r) : r));
    if (c.edgeRefs.length === 0) sketch.curves.delete(c.id);
  }
  for (const id of degenerate) sketch.edges.delete(id);
  for (const id of dup.keys()) sketch.edges.delete(id);
  const v = sketch.vertices.get(from);
  if (v) unhashVertex(sketch, from, v.p, tol);
  sketch.vertices.delete(from);
}

function newellNormal(pts: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/**
 * Re-plane the faces touching moved vertices. A face that is still planar gets a new plane/basis;
 * a non-planar one is removed and, when it has no holes, fan-split from a moved vertex into
 * planar pieces (fold edges, as autofold does for sheet geometry).
 */
function replaneSketchFaces(g: SketchGraphType, moved: ReadonlySet<Id>): void {
  const sketch = g.sketch;
  for (const f of [...sketch.faces.values()]) {
    const touches = f.loops.some((loop) =>
      loop.some((r) => {
        const e = sketch.edges.get(r.edgeId);
        return e !== undefined && (moved.has(e.a) || moved.has(e.b));
      }),
    );
    if (!touches) continue;
    const outer = f.loops[0];
    if (!outer || outer.length < 3) {
      sketch.faces.delete(f.id);
      continue;
    }
    const loops = f.loops.map((l) => loopPoints(sketch, l));
    const n = newellNormal(loops[0]!);
    if (v3len(n) / 2 < AREA_TOL) {
      sketch.faces.delete(f.id);
      continue;
    }
    const un = v3normalize(n);
    const centroid = loops[0]!.reduce((acc, p) => v3add(acc, p), [0, 0, 0] as Vec3);
    const plane = planeFromPointNormal(v3scale(centroid, 1 / loops[0]!.length), un);
    const planar = loops.every((l) => l.every((p) => Math.abs(planeDistance(plane, p)) <= COPLANAR_TOL));
    if (planar) {
      f.plane = plane;
      f.basis = planeBasis(planeOrigin(plane), plane.n);
      continue;
    }
    sketch.faces.delete(f.id);
    if (f.loops.length > 1) continue;
    const vids = loopVertexIds(sketch, outer);
    const mi = vids.findIndex((id) => moved.has(id));
    if (mi < 0) continue;
    const apex = vids[mi]!;
    const count = vids.length;
    for (let k = 2; k <= count - 2; k++) g.addEdge(apex, vids[(mi + k) % count]!);
  }
}

/** Move sketch vertices by `m`, merging within MERGE_TOL and re-planing the faces they bound. */
export function moveSketchVertices(g: SketchGraphType, ids: readonly Id[], m: Mat4 | MMat4): void {
  const sketch = g.sketch;
  const tol = g.tol;
  const moved = new Set<Id>();
  for (const id of ids) {
    const v = sketch.vertices.get(id);
    if (!v) continue;
    unhashVertex(sketch, id, v.p, tol);
    v.p = m4transformPoint(m, v.p);
    hashVertex(sketch, id, v.p, tol);
    moved.add(id);
  }
  for (const id of [...moved]) {
    const v = sketch.vertices.get(id);
    if (!v) continue;
    const other = nearbyVertex(sketch, id, v.p, tol);
    if (other === undefined) continue;
    // keep the stationary vertex; between two moved ones keep the older id
    const keep = moved.has(other) && id < other ? id : other;
    const drop = keep === id ? other : id;
    mergeSketchVertex(sketch, drop, keep, tol);
    moved.delete(drop);
    moved.add(keep);
  }
  replaneSketchFaces(g, moved);
}

// --- apply ------------------------------------------------------------------------------------

/** Apply a plan (and its kernel results) to the draft. Returns the transformed entities. */
export function applyTransformPlan(draft: DocumentDraft, plan: TransformPlan, work: TransformKernelWork): TransformApplyResult {
  const container = draftContainerAt(draft, plan.path);
  const path = plan.path;
  const refs: EntityRef[] = [];
  const bodyIds: number[] = [], meshPartIds: number[] = [];
  const m = plan.matrix;

  if (plan.pushPull && work.pushPull) {
    const r = applyPushPullResult(draft, work.pushPull.plan, work.pushPull.result);
    bodyIds.push(...r.bodyIds);
    const t = plan.pushPull.target;
    if (t.kind === 'face') refs.push({ kind: 'face', path, id: t.id as Id, faceId: t.faceId as FaceLocalId, region: t.region });
    return { refs, bodyIds, meshPartIds };
  }

  // whole bodies
  for (const [id, version] of plan.bodies) {
    const source = container.bodies.get(id);
    if (!source) continue;
    if (source.version !== version) throw new PushFormError('transform.stale', 'The body changed before the transform could be applied');
    const target = plan.copy ? cloneBody(draft, container, source) : source;
    if (plan.rigid) {
      transformBodyInPlace(target, m);
      refs.push({ kind: 'body', path, id: target.id });
      bodyIds.push(target.id);
      continue;
    }
    const w = work.bodies.get(id);
    if (!w) throw new PushFormError('transform.internal', `No kernel result for body ${id}`);
    const [first, ...extras] = w.result.components;
    if (!first) {
      removeBody(container, target.id);
      continue;
    }
    const updated = applyKernelResult(draft, target.id, toKernelResult(first, w));
    updated.nextFaceId = Math.max(updated.nextFaceId, w.result.nextFaceId);
    refs.push({ kind: 'body', path, id: updated.id });
    bodyIds.push(updated.id);
    for (const c of extras) {
      const extra = bodyFromComponent(draft, container, c, source, w);
      refs.push({ kind: 'body', path, id: extra.id });
      bodyIds.push(extra.id);
    }
  }

  // mesh parts: whole, in the model; a copy shares the source geometry until it moves
  for (const id of plan.meshPartIds) {
    const source = container.meshParts.get(id);
    if (!source) continue;
    if (source.locked && !plan.copy) throw new PushFormError('meshPart.locked', 'A locked part cannot be moved');
    const target = plan.copy ? cloneMeshPart(draft, container, source) : source;
    target.geometry = transformMeshPartGeometry(source.geometry, m);
    refs.push({ kind: 'meshPart', path, id: target.id });
    meshPartIds.push(target.id);
  }

  // instances
  for (const id of plan.instances) {
    const source = container.instances.get(id);
    if (!source) continue;
    if (source.locked && !plan.copy) throw new PushFormError('instance.locked', 'A locked group/component cannot be moved');
    const target = plan.copy ? cloneInstance(draft, container, source) : source;
    target.transform = m4mul(m, target.transform) as unknown as Mat4;
    // a glued placement's plane moves with it
    if (target.gluedPlane) target.gluedPlane = planeFromPointNormal(m4transformPoint(m, planeOrigin(target.gluedPlane)), mapNormal(m, target.gluedPlane.n));
    refs.push({ kind: 'instance', path, id: target.id });
  }

  // sketch
  if (plan.copy && plan.sketchEdgeIds.length) {
    const g = sketchGraphAt(draft, path);
    const facesBefore = new Set(g.sketch.faces.keys());
    const newEdges = new Set<Id>();
    for (const eid of plan.sketchEdgeIds) {
      const e = g.sketch.edges.get(eid);
      if (!e) continue;
      const a = m4transformPoint(m, g.pos(e.a)), b = m4transformPoint(m, g.pos(e.b));
      for (const nid of g.addEdge(a, b, { soft: e.soft, smooth: e.smooth, hidden: e.hidden, tagId: e.tagId })) newEdges.add(nid);
    }
    for (const id of newEdges) refs.push({ kind: 'sketchEdge', path, id });
    for (const id of g.sketch.faces.keys()) if (!facesBefore.has(id)) refs.push({ kind: 'sketchFace', path, id });
  } else if (!plan.copy && plan.sketchVertexIds.length) {
    const g = sketchGraphAt(draft, path);
    moveSketchVertices(g, plan.sketchVertexIds, m);
    for (const id of plan.sketchVertexIds) if (g.sketch.vertices.has(id)) refs.push({ kind: 'sketchVertex', path, id });
    for (const id of plan.sketchEdgeIds) if (g.sketch.edges.has(id)) refs.push({ kind: 'sketchEdge', path, id });
  }

  // placed pictures: the whole picture follows the transform; a copy is a new picture of the same image
  for (const id of plan.imageIds) {
    const source = container.images.get(id);
    if (!source) continue;
    if (source.locked && !plan.copy) throw new PushFormError('image.locked', 'A locked image cannot be moved');
    const transform = m4mul(m, source.transform) as unknown as Mat4;
    if (plan.copy) {
      const copyId = allocId<Id>(draft);
      container.images.set(copyId, { ...source, id: copyId, locked: false, transform, attributes: cloneJson(source.attributes) });
      container.order.push(copyId);
      refs.push({ kind: 'image', path, id: copyId });
    } else {
      source.transform = transform;
      refs.push({ kind: 'image', path, id });
    }
  }

  // dimensions: moved on their own, a dimension keeps its measured points and attachments and its dimension
  // line (or its leader) follows the move; moved with other entities, or turned or scaled, it moves whole; a copy is a
  // new dimension attached to nothing.
  const onlyDimensions = plan.dimensionIds.length > 0 && plan.bodies.size === 0 && plan.meshPartIds.length === 0 && plan.instances.length === 0 &&
    plan.sketchVertexIds.length === 0 && plan.sketchEdgeIds.length === 0 && plan.subEntities.size === 0 &&
    plan.sectionPlaneIds.length === 0 && plan.imageIds.length === 0;
  for (const id of plan.dimensionIds) {
    const dim = container.dimensions.get(id);
    if (!dim) continue;
    if (dim.locked && !plan.copy) throw new PushFormError('dimension.locked', 'A locked dimension cannot be moved');
    const whole = (): model.Dimension => ({ ...dim, start: m4transformPoint(m, dim.start), end: m4transformPoint(m, dim.end),
      offset: m4transformDir(m, dim.offset), normal: mapNormal(m, dim.normal) });
    if (plan.copy) {
      const { anchors: _anchors, curve: _curve, ...copy } = { ...whole(), id: allocId<Id>(draft), locked: false, attributes: cloneJson(dim.attributes) };
      container.dimensions.set(copy.id, copy);
      container.order.push(copy.id);
      refs.push({ kind: 'dimension', path, id: copy.id });
      continue;
    }
    if (onlyDimensions && isTranslation(m)) dim.offset = v3add(dim.offset, dimensionDrag(draft as unknown as DocumentState, container, dim, [m[12]!, m[13]!, m[14]!]));
    else container.dimensions.set(id, whole());
    refs.push({ kind: 'dimension', path, id });
  }

  // section planes: a copy is a new, inactive plane
  for (const id of plan.sectionPlaneIds) {
    const sp = container.sectionPlanes.get(id);
    if (!sp) continue;
    const moved = mapSectionPlane(sp, plan.copy ? allocId<Id>(draft) : id, m);
    container.sectionPlanes.set(moved.id, moved);
    if (plan.copy) container.order.push(moved.id);
    refs.push({ kind: 'sectionPlane', path, id: moved.id });
  }

  // autofold
  for (const [id, subRefs] of plan.subEntities) {
    const source = container.bodies.get(id);
    const w = work.bodies.get(id);
    if (!source || !w) continue;
    const [first, ...extras] = w.result.components;
    if (!first) {
      removeBody(container, id);
      continue;
    }
    const updated = applyKernelResult(draft, id, toKernelResult(first, w));
    updated.nextFaceId = Math.max(updated.nextFaceId, w.result.nextFaceId);
    bodyIds.push(updated.id);
    for (const r of subRefs) {
      if (r.kind === 'face' && updated.faces.has(r.faceId)) refs.push(r);
      else if (r.kind === 'edge' && updated.edges.has(r.edgeKey)) refs.push(r);
    }
    for (const c of extras) {
      const extra = bodyFromComponent(draft, container, c, source, w);
      refs.push({ kind: 'body', path, id: extra.id });
      bodyIds.push(extra.id);
    }
  }

  return { refs, bodyIds, meshPartIds };
}

// ---------------------------------------------------------------------------------------------
// Commands

async function executeTransform(host: DocumentHost, kernel: KernelClient, plans: TransformPlan[], label: string): Promise<TransformApplyResult> {
  const state = host.doc.state;
  for (const plan of plans) requireContextPath(host, plan.path, 'Selection');
  const works: TransformKernelWork[] = [];
  for (const plan of plans) works.push(await runTransformKernel(kernel, state, plan));
  const out: TransformApplyResult = { refs: [], bodyIds: [], meshPartIds: [] };
  host.transact(label, () =>
    host.edit(label, (draft) => {
      plans.forEach((plan, i) => {
        const r = applyTransformPlan(draft, plan, works[i]!);
        out.refs.push(...r.refs);
        out.bodyIds.push(...r.bodyIds);
        out.meshPartIds.push(...r.meshPartIds);
      });
    }),
  );
  if (plans.some((p) => p.copy)) host.selection.set(out.refs);
  return out;
}

/**
 * Move / rotate / scale / mirror entities of the current edit context by a world matrix. Rigid
 * whole-body transforms stay in the model; scale and mirror go through the kernel; sketch
 * geometry moves its vertices (merging and re-planing); body faces/edges autofold; a single face
 * moved along its normal is a push/pull; instances multiply their transform. Async; one undo
 * entry labelled `label`. `copy` duplicates first and selects the copies.
 */
export const transformApply = defineCommand({
  id: 'transform.apply',
  title: 'Transform',
  category: 'edit',
  params: TransformApplyParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<TransformApplyResult> {
    const host = hostOf(ctx);
    const plan = planTransform(host.doc.state, refsOrSelection(host, p.refs), p.matrix, p.copy, p.label);
    return executeTransform(host, kernelOf(ctx), [plan], p.label);
  },
});

/** Copy the entities `count` times along a transform (`3x` external, `/3` internal). One undo entry. */
export const transformArray = defineCommand({
  id: 'transform.array',
  title: 'Array',
  category: 'edit',
  params: TransformArrayParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<TransformApplyResult> {
    const host = hostOf(ctx);
    const refs = refsOrSelection(host, p.refs);
    const plans = arrayMatrices(p.matrix, p.count, p.mode).map((mk) => planTransform(host.doc.state, refs, mk, true, p.label));
    return executeTransform(host, kernelOf(ctx), plans, p.label);
  },
});

/** Mirror the selection about the plane through its bounding-box centre perpendicular to `axis`. */
export const flipAlong = defineCommand({
  id: 'edit.flipAlong',
  title: 'Flip Along',
  category: 'edit',
  menu: 'Edit/Flip Along',
  params: FlipAlongParamsSchema,
  undoable: false,
  async run(ctx, p): Promise<TransformApplyResult> {
    const host = hostOf(ctx);
    const refs = refsOrSelection(host, p.refs);
    const bounds = refsBounds(host.doc.state, refs);
    if (!bounds) throw new PushFormError('transform.empty', 'Nothing to flip');
    const axis = p.axis === 'x' ? 0 : p.axis === 'y' ? 1 : 2;
    const factors: [number, number, number] = [1, 1, 1];
    factors[axis] = -1;
    const plan = planTransform(host.doc.state, refs, m4scaleAbout(box3Center(bounds), factors), false, 'Flip Along');
    return executeTransform(host, kernelOf(ctx), [plan], 'Flip Along');
  },
});

/**
 * Set a sketch edge's length from Entity Info: its free end moves along the edge, merging with a vertex it
 * lands on, as a Move of that vertex would.
 */
export const sketchSetEdgeLength = defineCommand({
  id: 'sketch.setEdgeLength',
  title: 'Edge Length',
  category: 'edit',
  params: z.object({ id: z.number().int(), length: z.number().positive().finite() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const path = host.context.path;
    host.edit('Edge Length', (draft) => {
      const g = sketchGraphAt(draft, path);
      const ends = model.sketchEdgeLengthEnds(g.sketch, p.id as Id);
      if (!ends) throw new PushFormError('edge.notFree', 'Only an edge that bounds no face and is not part of a curve can change length');
      const fixed = g.sketch.vertices.get(ends.fixed)!.p, moving = g.sketch.vertices.get(ends.moving)!.p;
      const along = v3sub(moving, fixed);
      if (v3len(along) <= LENGTH_TOL) throw new PushFormError('edge.degenerate', 'The edge has no direction');
      const target = v3add(fixed, v3scale(v3normalize(along), p.length));
      moveSketchVertices(g, [ends.moving], m4translation(v3sub(target, moving)));
    });
  },
});

export const transformCommands: readonly AnyCommand[] = [transformApply, transformArray, flipAlong, sketchSetEdgeLength];

// ---------------------------------------------------------------------------------------------
// Helpers shared with the tools

/** World points of the body sub-entities (face loops / edge polylines) that a transform of `refs` moves. */
export function movedPointsOf(state: DocumentState, refs: readonly EntityRef[]): Vec3[] {
  const out: Vec3[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'face' && ref.kind !== 'edge') continue;
    let container: EntityContainer;
    try {
      container = containerAt(state, ref.path);
    } catch {
      continue;
    }
    const frame = contextFrame(state, ref.path);
    if (ref.kind === 'face') {
      const f = container.bodies.get(ref.id)?.faces.get(ref.faceId);
      for (const loop of f?.loops ?? []) for (const p of loop) out.push(frame.toWorld(p));
    } else {
      const e = container.bodies.get(ref.id)?.edges.get(ref.edgeKey);
      if (e) for (const p of e.polyline) out.push(frame.toWorld(p));
    }
  }
  return out;
}

