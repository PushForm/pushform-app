// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MMat4, Vec2, Vec3 } from '@pushform/core';
import type { DocumentState, EntityRef } from '@pushform/model';
import type { InferenceInput, InferenceOptions, InferenceResult, PickBoxMode, PickHit, ReferenceEdge } from './types';

/**
 * Contract for the inference engine (implemented in this package). Tools receive `InferenceResult`
 * on every pointer event; the shell calls `resolve` with the active tool's `inferenceOptions()`.
 */
export interface InferenceEngine {
  /** Point the engine at a document state (call after every document change; cheap when unchanged). */
  setState(state: DocumentState): void;
  /** The edit context used when `InferenceOptions.context` is not passed (root by default). */
  readonly context: readonly Id[];
  /** Set the open edit context (Edit Group / Close Group); clears the inference memory. */
  setContext(path: readonly Id[]): void;
  /** World point → local coordinates of the container at `path` (default: the current context). */
  toLocal(point: Vec3, path?: readonly Id[]): Vec3;
  /** Local point of the container at `path` (default: the current context) → world. */
  toWorld(point: Vec3, path?: readonly Id[]): Vec3;
  /** local→world / world→local matrices of the context at `path` (default: the current context). */
  contextMatrix(path?: readonly Id[]): MMat4;
  contextInverse(path?: readonly Id[]): MMat4;
  resolve(input: InferenceInput, opts?: InferenceOptions): InferenceResult;
  /** Pure pick without snapping (hover highlight, Select, Eraser). */
  pick(input: InferenceInput, opts?: InferenceOptions): PickHit | null;
  /** Remember a hovered entity/point for from-point inferences (called by resolve; exposed for tests). */
  rememberPoint(point: Vec3): void;
  clearMemory(): void;
  /** Box selection; available once an input with `project` has been seen (or `setProjector`). */
  pickBox?(rect: { min: Vec2; max: Vec2; mode: PickBoxMode }, opts?: InferenceOptions): EntityRef[];
  /** Lasso selection inside a closed screen outline; available under the same condition as `pickBox`. */
  pickLasso?(outline: readonly Vec2[], mode: PickBoxMode, opts?: InferenceOptions): EntityRef[];
  setProjector?(project: ((p: Vec3) => Vec2) | null): void;
  /**
   * Edge used for Parallel / Perpendicular to Edge and the "On Line" extension. Set automatically
   * after resting on an edge; tools may set it explicitly (e.g. after clicking on an edge).
   */
  referenceEdge?: ReferenceEdge | null;
}
