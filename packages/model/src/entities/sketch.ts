// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, Id, MaterialId, Plane, PlaneBasis, Vec3 } from '@pushform/core';
import type { CommonAttrs } from './common';
import type { Curve } from './body';
import type { UvMapping } from './attrs';
import type { NativeCatalogUnknownFields } from './document';
import type { PackedPointIndexData } from '@pushform/geom';

/**
 * Loose geometry owned by the UI thread: vertices, edges and zero-thickness planar faces.
 * Proximity data stays inside the state so it is undone with the geometry. Native-open
 * sketches borrow packed columns; mutable sketches use the MERGE_TOL grid-cell vertexHash.
 */
export interface Sketch {
  nativeUnknownFields?: NativeCatalogUnknownFields;
  vertices: Map<Id, SketchVertex>;
  edges: Map<Id, SketchEdge>;
  faces: Map<Id, SketchFace>;
  curves: Map<CurveId, Curve>;
  vertexHash: Map<string, Id[]>;
  /** Native-open proximity data; the mutable hash is materialized only on vertex edits. */
  packedVertexIndex?: PackedPointIndexData & { ids: Uint32Array };
}

export interface SketchVertex {
  id: Id;
  p: Vec3;
}

export interface SketchEdge extends CommonAttrs {
  id: Id;
  a: Id;
  b: Id;
  soft: boolean;
  smooth: boolean;
  curveId: CurveId | null;
}

/** One edge of a face loop; `forward` = the loop traverses the edge a→b. */
export interface LoopRef {
  edgeId: Id;
  forward: boolean;
}

/** Planar n-gon with holes, two-sided. */
export interface SketchFace extends CommonAttrs {
  id: Id;
  plane: Plane;
  basis: PlaneBasis;
  /** Outer loop first (CCW about the plane normal), then holes (CW). */
  loops: LoopRef[][];
  frontMaterialId: MaterialId | null;
  backMaterialId: MaterialId | null;
  uv: UvMapping;
  /** Back-side mapping where it differs from `uv` (imported faces); absent = `uv`. */
  uvBack?: UvMapping | undefined;
}

export function createSketch(): Sketch {
  return { vertices: new Map(), edges: new Map(), faces: new Map(), curves: new Map(), vertexHash: new Map() };
}
