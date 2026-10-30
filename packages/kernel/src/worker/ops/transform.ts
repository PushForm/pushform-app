// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mat4 } from 'manifold-3d';
import type { ComponentsResult, TransformRequest } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

/** Apply a column-major 4x4 affine transform. Manifold flips winding itself for negative determinants. */
export function transform(ctx: KernelContext, req: TransformRequest): ComponentsResult {
  if (req.matrix.length !== 16 || req.matrix.some((x) => !Number.isFinite(x))) {
    throw new KernelError('InvalidInput', 'transform.matrix must hold 16 finite numbers');
  }
  const entry = getBody(ctx, req.body);
  return withScope((scope) => {
    const moved = scope.track(entry.manifold.transform(req.matrix as Mat4));
    const fin = finalizeManifold(ctx, moved, { nextFaceId: req.nextFaceId, chooseId: keepIdsFromRuns(new Set([entry.runId])) });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  });
}
