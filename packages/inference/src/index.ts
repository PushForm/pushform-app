// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/inference: Picking and inference engine
export * from './types';
export type { InferenceEngine } from './InferenceEngine';
export {
  SpatialIndex,
  definitionAtPath,
  samePoint,
  tagVisible,
  type BodyIndex,
  type ContainerEntry,
  type IndexedCenter,
  type IndexedGuide,
  type IndexedSegment,
  type IndexedVertex,
  type PointIndex,
  type SketchFaceIndex,
  type SketchIndex,
  type WorldEdge,
  type WorldFace,
} from './SpatialIndex';
export {
  PickService,
  RefFilter,
  choosePick,
  samePath,
  segIntersectsRect,
  OCCLUSION_PX,
  type CenterCandidate,
  type ContextResolution,
  type EdgeCandidate,
  type GuideCandidate,
  type PickCandidates,
  type PickOptions,
  type SurfaceCandidate,
  type VertexCandidate,
} from './PickService';
export {
  InferenceEngineImpl,
  createInferenceEngine,
  screenDistance,
  perpendicularTo,
  arcTangent,
  AXIS_COLOR,
  AXIS_DIR,
  AXIS_LABEL,
  type InferenceEngineOptions,
} from './InferenceEngineImpl';
