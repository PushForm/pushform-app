// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type {
  CurveId,
  FaceLocalId,
  Id,
  MaterialId,
  MeshData,
  Plane,
  PlaneBasis,
  SurfaceId,
  TagId,
  Vec2,
  Vec3,
} from '@pushform/core';
import type { CommonAttrs } from './common';
import type { UvMapping } from './attrs';
import type { NativeCatalogUnknownFields } from './document';

/**
 * A closed manifold solid. The triangle topology (`mesh`) is owned by the kernel and treated as an
 * opaque value; the face layer (`faces`, `edges`, `imprints`, `curves`, `surfaces`) decorates it.
 */
export interface Body extends CommonAttrs {
  nativeUnknownFields?: NativeCatalogUnknownFields;
  id: Id;
  /** Bumped on every mesh replacement; keys kernel caches and region caches. */
  version: number;
  mesh: MeshData;
  faces: Map<FaceLocalId, FaceRecord>;
  nextFaceId: number;
  edges: Map<EdgeKey, EdgeRecord>;
  imprints: Map<FaceLocalId, ImprintGraph>;
  curves: Map<CurveId, Curve>;
  surfaces: Map<SurfaceId, SurfaceRecord>;
  /** Body-level material (inherited by faces whose own material is null). */
  materialId: MaterialId | null;
  props: BodyProps;
  /** False when the mesh failed validation (autofold preference "allow invalid"). */
  valid: boolean;
}

export interface BodyProps {
  volume: number;
  area: number;
}

/** A coplanar n-gon of a body: one entry per distinct faceId in the mesh. */
export interface FaceRecord {
  id: FaceLocalId;
  plane: Plane;
  basis: PlaneBasis;
  /** Outer loop first (CCW about the plane normal), then holes (CW). Positions, not vertex ids. */
  loops: Vec3[][];
  frontMaterialId: MaterialId | null;
  backMaterialId: MaterialId | null;
  uv: UvMapping;
  /** Back-side mapping where it differs from `uv` (imported faces); absent = `uv`. */
  uvBack?: UvMapping | undefined;
  tagId: TagId;
  hidden: boolean;
  surfaceId: SurfaceId | null;
}

/** `${faceA}:${faceB}:${k}` with faceA < faceB and k the run index between that face pair. */
export type EdgeKey = `${number}:${number}:${number}`;

export function makeEdgeKey(faceA: number, faceB: number, k: number): EdgeKey {
  return faceA < faceB ? `${faceA}:${faceB}:${k}` : `${faceB}:${faceA}:${k}`;
}
export function parseEdgeKey(key: EdgeKey): { faceA: FaceLocalId; faceB: FaceLocalId; k: number } {
  const [a, b, k] = key.split(':');
  return { faceA: Number(a) as FaceLocalId, faceB: Number(b) as FaceLocalId, k: Number(k) };
}

/**
 * A maximal collinear run of triangle edges between two different faces. Derived from the mesh;
 * flags are carried across mesh replacements by `carryEdgeProps`.
 */
export interface EdgeRecord {
  key: EdgeKey;
  faceA: FaceLocalId;
  faceB: FaceLocalId;
  polyline: Vec3[];
  soft: boolean;
  smooth: boolean;
  hidden: boolean;
  tagId: TagId;
  curveId: CurveId | null;
}

/** Non-geometric edges drawn on a face, in the face's (u, v) basis. */
export interface ImprintGraph {
  nativeUnknownFields?: Uint8Array[];
  vertices: Map<number, Vec2>;
  edges: Map<number, ImprintEdge>;
  nextId: number;
  /** Bumped on every change; keys the region cache. */
  version: number;
}
export interface ImprintEdge {
  id: number;
  a: number;
  b: number;
  soft: boolean;
  smooth: boolean;
  hidden: boolean;
  curveId: CurveId | null;
}

export type CurveKind = 'arc' | 'circle' | 'polygon' | 'freehand';

/** Curve metadata grouping consecutive edges (sketch edge ids or body edge keys). */
export interface Curve {
  id: CurveId;
  kind: CurveKind;
  center: Vec3;
  normal: Vec3;
  radius: number;
  startAngle: number;
  endAngle: number;
  segments: number;
  edgeRefs: (EdgeKey | Id)[];
}

/** A smooth face group (e.g. the sides of an extruded circle). */
export interface SurfaceRecord {
  id: SurfaceId;
  faceIds: FaceLocalId[];
  curveId: CurveId | null;
}

/** Faces joined through soft edges, per edge map (immer keeps it identical until an edge changes). */
const softGroups = new WeakMap<ReadonlyMap<EdgeKey, EdgeRecord>, Map<FaceLocalId, FaceLocalId[]>>();

/**
 * Faces that act as one with `faceId`: the smooth surface it belongs to, i.e. every face reached
 * from it across soft edges. A face with no soft
 * edge is alone. Sorted by face id.
 */
export function surfaceFaceIds(body: Body, faceId: FaceLocalId): FaceLocalId[] {
  let groups = softGroups.get(body.edges);
  if (!groups) {
    const parent = new Map<FaceLocalId, FaceLocalId>();
    const find = (f: FaceLocalId): FaceLocalId => {
      let r = f;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(f, r);
      return r;
    };
    for (const e of body.edges.values()) {
      if (!e.soft || e.faceA === e.faceB) continue;
      const a = find(e.faceA), b = find(e.faceB);
      if (a !== b) parent.set(a, b);
    }
    groups = new Map();
    const byRoot = new Map<FaceLocalId, FaceLocalId[]>();
    for (const f of parent.keys()) {
      const r = find(f);
      const list = byRoot.get(r) ?? [];
      list.push(f);
      byRoot.set(r, list);
    }
    for (const list of byRoot.values()) {
      list.sort((x, y) => x - y);
      for (const f of list) groups.set(f, list);
    }
    softGroups.set(body.edges, groups);
  }
  const ids = groups.get(faceId)?.filter((id) => body.faces.has(id));
  return ids && ids.length > 1 ? ids : [faceId];
}

export function createImprintGraph(): ImprintGraph {
  return { vertices: new Map(), edges: new Map(), nextId: 1, version: 0 };
}
