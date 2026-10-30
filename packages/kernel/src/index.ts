// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/kernel: Manifold kernel wrapper: protocol, worker ops, backends
export const PACKAGE = '@pushform/kernel';

export * from './protocol';
export * from './meshChecks';
export { validateSolidMesh } from './validateSolid';
export type { KernelBackend, MeshProvider } from './backends/KernelBackend';
export { InlineBackend, type InlineBackendOptions } from './backends/InlineBackend';
export { WorkerBackend, type WorkerBackendOptions } from './backends/WorkerBackend';
export { KernelClient, toMeshWire, type CoalescedResult } from './client/KernelClient';
export { loadManifold } from './worker/ManifoldModule';
export { ManifoldCache, type CacheEntry } from './worker/ManifoldCache';
export { createKernelContext, type KernelContext } from './worker/context';
export { dispatch } from './worker/dispatch';
export { groupCoplanar, normalizeTriangles, keepIdsFromRuns, allNewIds } from './worker/ops/normalize';
export type { ChooseFaceId, CoplanarGroups, Normalized, NormalizedFace, WeightedOrigin } from './worker/ops/normalize';
export { TOOL_NEAR_CAP, TOOL_FAR_CAP, TOOL_SIDE_BASE } from './worker/ops/pushPull';
export { meshSelfIntersection, trianglesIntersect, type AutofoldRejection } from './worker/ops/autofold';
