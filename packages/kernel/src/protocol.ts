// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Kernel worker protocol: discriminated-union requests and their responses.
 *
 * All geometry crosses the boundary as {@link MeshWire}; canonical meshes are sent as copies and
 * results are transferred back. Face ids are local to a body; every op that produces bodies takes
 * the caller's `nextFaceId` and returns the advanced counter.
 */
import type { Plane, PlaneBasis, Vec3 } from '@pushform/core';

/** Triangle mesh on the wire. `runId` is the Manifold originalID the mesh was (or will be) registered as; 0 = unknown. */
export interface MeshWire {
  verts: Float64Array;
  tris: Uint32Array;
  faceId: Uint32Array;
  runId: number;
}

/** Polygon with holes in (u,v): contour 0 is the outer loop (CCW), holes follow. */
export type PolygonsWithHoles = number[][][];

export interface BodyRef {
  bodyId: number;
  version: number;
}

export interface BodyProps {
  volume: number;
  area: number;
}

/** One (input run, input face) pair that contributed triangles to an output face. */
export interface FaceOriginRef {
  runId: number;
  faceId: number;
}
export type FaceOrigin = Map<number, FaceOriginRef[]>;

/** One connected solid produced by an op. */
export interface KernelComponent {
  mesh: MeshWire;
  faceOrigin: FaceOrigin;
  props: BodyProps;
}

export type BooleanOp = 'add' | 'subtract' | 'intersect' | 'split' | 'trim';
export type PushPullMode = 'merge' | 'newBody';

/** Mirror of manifold-3d's ErrorStatus so consumers need not depend on manifold-3d types. */
export type ManifoldStatus =
  | 'NoError'
  | 'NonFiniteVertex'
  | 'NotManifold'
  | 'VertexOutOfBounds'
  | 'PropertiesWrongLength'
  | 'MissingPositionProperties'
  | 'MergeVectorsDifferentLengths'
  | 'MergeIndexOutOfBounds'
  | 'TransformWrongLength'
  | 'RunIndexWrongLength'
  | 'FaceIDWrongLength'
  | 'InvalidConstruction'
  | 'ResultTooLarge'
  | 'InvalidTangents'
  | 'Cancelled'
  | 'Unknown';

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export interface InitRequest {
  type: 'init';
}
export interface EnsureBodyRequest {
  type: 'ensureBody';
  bodyId: number;
  version: number;
  /** Omit to ask whether the body is cached; the worker answers `needMesh` if it is not. */
  mesh?: MeshWire;
}
export interface PushPullRegion {
  /** Face F the region lies on. */
  faceId: number;
  /** F's plane basis; the polygon is expressed in its (u,v). */
  basis: PlaneBasis;
  polygon: PolygonsWithHoles;
  /** True when the region polygon is the whole of F, so the far cap inherits F's id. */
  regionIsWholeFace: boolean;
}
export interface PushPullRequest {
  type: 'pushPull';
  body: BodyRef;
  region: PushPullRegion;
  /** Signed distance along the face normal: > 0 pulls out, < 0 pushes in. */
  distance: number;
  mode: PushPullMode;
  preview?: boolean;
  nextFaceId: number;
}
export interface ExtrudeSketchRequest {
  type: 'extrudeSketch';
  basis: PlaneBasis;
  polygon: PolygonsWithHoles;
  distance: number;
  nextFaceId: number;
}
export interface BooleanRequest {
  type: 'boolean';
  op: BooleanOp;
  a: BodyRef;
  b: BodyRef;
  nextFaceId: number;
}
export interface TransformRequest {
  type: 'transform';
  body: BodyRef;
  /** Column-major 4x4. */
  matrix: number[];
  nextFaceId: number;
}
export interface AutofoldRequest {
  type: 'autofold';
  body: BodyRef;
  /** Re-triangulated polygon layer after the vertex displacement. */
  mesh: MeshWire;
  nextFaceId: number;
}
export interface SectionCutRequest {
  type: 'sectionCut';
  body: BodyRef;
  plane: Plane;
}
export interface PropertiesRequest {
  type: 'properties';
  body: BodyRef;
}
export interface FromTrianglesRequest {
  type: 'fromTriangles';
  mesh: MeshWire;
  nextFaceId: number;
}
export interface DecomposeRequest {
  type: 'decompose';
  body: BodyRef;
  nextFaceId: number;
}
export interface SimplifyRequest {
  type: 'simplify';
  body: BodyRef;
  tolerance?: number;
  nextFaceId: number;
}
export interface HullRequest {
  type: 'hull';
  bodies: BodyRef[];
  nextFaceId: number;
}
/** Sweep a planar profile along a polyline path (Follow Me). Result is one solid per component. */
export interface FollowMeRequest {
  type: 'followMe';
  /** Profile polygon in `profileBasis` (u,v); the profile plane should be roughly perpendicular to the first path segment. */
  profile: PolygonsWithHoles;
  profileBasis: PlaneBasis;
  /** World-space path vertices; the sweep starts at the path vertex nearest the profile. */
  path: Vec3[];
  closed: boolean;
  nextFaceId: number;
}
/** Revolve a planar profile about an axis (lathe). `angleDeg` 360 closes the solid. */
export interface RevolveRequest {
  type: 'revolve';
  profile: PolygonsWithHoles;
  profileBasis: PlaneBasis;
  axisOrigin: Vec3;
  axisDir: Vec3;
  angleDeg: number;
  segments: number;
  nextFaceId: number;
}
/** Closed triangle mesh of one tool prism (Fillet/Chamfer); `faceId` labels are the caller's. */
export interface ToolSoup {
  verts: Float64Array;
  tris: Uint32Array;
  faceId: Uint32Array;
}
/**
 * Fillet / Chamfer: `body − ∪cut ∪ ∪add` in one op. Every tool prism is a closed solid; prisms that
 * meet on a mitre share those vertices exactly. Faces from the body keep their ids; faces from the
 * tools get fresh ids and report `toolRunId` with the prism face label as their origin.
 */
export interface EdgeBlendRequest {
  type: 'edgeBlend';
  body: BodyRef;
  cut: ToolSoup[];
  add: ToolSoup[];
  preview?: boolean;
  nextFaceId: number;
}
export interface ReleaseRequest {
  type: 'release';
  bodyId: number;
  /** Omit to release every cached version of the body. */
  version?: number;
}
export interface StatsRequest {
  type: 'stats';
}

export type KernelRequest =
  | InitRequest
  | EnsureBodyRequest
  | PushPullRequest
  | ExtrudeSketchRequest
  | BooleanRequest
  | TransformRequest
  | AutofoldRequest
  | SectionCutRequest
  | PropertiesRequest
  | FromTrianglesRequest
  | DecomposeRequest
  | SimplifyRequest
  | HullRequest
  | FollowMeRequest
  | RevolveRequest
  | EdgeBlendRequest
  | ReleaseRequest
  | StatsRequest;

export type KernelRequestType = KernelRequest['type'];

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export interface InitResponse {
  ready: true;
}
export interface EnsureBodyResponse {
  status: 'cached' | 'needMesh';
  /** originalID the body's triangles carry inside the worker (0 when `needMesh`). */
  runId: number;
}
export interface ComponentsResult {
  components: KernelComponent[];
  nextFaceId: number;
}
export interface PushPullResult extends ComponentsResult {
  /** New face id -> index of the region boundary edge (flattened over contours) that face was extruded from. */
  sideFaceForBoundaryEdge: Record<number, number>;
  bodyRunId: number;
  toolRunId: number;
}
export interface BooleanResult extends ComponentsResult {
  /** `split` only: the components outside the cutter (`components` holds the inside). */
  secondary: KernelComponent[];
  aRunId: number;
  bRunId: number;
}
export interface EdgeBlendResult extends ComponentsResult {
  bodyRunId: number;
  /** runId reported in `faceOrigin` for faces that came from the tool prisms. */
  toolRunId: number;
}
export interface SectionCutResult {
  /** Closed loops as flat xyz polylines (first point not repeated). */
  loops: Float64Array[];
}
export interface PropertiesResult extends BodyProps {
  genus: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}
export interface FromTrianglesResult extends ComponentsResult {
  status: ManifoldStatus;
}
export interface ReleaseResult {
  released: number;
}
export interface StatsResult {
  cached: number;
  /** wasm heap size in bytes, or 0 when the module does not expose it. */
  heapBytes: number;
}

export interface KernelResultMap {
  init: InitResponse;
  ensureBody: EnsureBodyResponse;
  pushPull: PushPullResult;
  extrudeSketch: PushPullResult;
  boolean: BooleanResult;
  transform: ComponentsResult;
  autofold: ComponentsResult;
  sectionCut: SectionCutResult;
  properties: PropertiesResult;
  fromTriangles: FromTrianglesResult;
  decompose: ComponentsResult;
  simplify: ComponentsResult;
  hull: ComponentsResult;
  followMe: ComponentsResult;
  revolve: ComponentsResult;
  edgeBlend: EdgeBlendResult;
  release: ReleaseResult;
  stats: StatsResult;
}

export type ResFor<R extends KernelRequest> = KernelResultMap[R['type']];

// ---------------------------------------------------------------------------------------------
// Errors and envelopes
// ---------------------------------------------------------------------------------------------

export type KernelErrorCode =
  | 'NotImplemented'
  | 'BodyNotCached'
  | 'InvalidInput'
  | 'ManifoldError'
  | 'Aborted'
  | 'Internal';

export interface KernelErrorInfo {
  code: KernelErrorCode;
  message: string;
  details?: unknown;
}

/** Error raised by ops in the worker and rethrown on the client with the same code. */
export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: unknown;
  constructor(code: KernelErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.details = details;
  }
  toInfo(): KernelErrorInfo {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
  static fromInfo(info: KernelErrorInfo): KernelError {
    return new KernelError(info.code, info.message, info.details);
  }
}

export function toKernelErrorInfo(e: unknown): KernelErrorInfo {
  if (e instanceof KernelError) return e.toInfo();
  if (e instanceof Error) return { code: 'Internal', message: e.message };
  return { code: 'Internal', message: String(e) };
}

export interface KernelRequestEnvelope {
  id: number;
  req: KernelRequest;
}
export type KernelResponseEnvelope =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: KernelErrorInfo };
