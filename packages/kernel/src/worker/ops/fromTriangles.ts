// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FromTrianglesRequest, FromTrianglesResult } from '../../protocol';
import type { KernelContext } from '../context';
import { tryManifoldFromSoup } from '../meshio';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

/** Validate a triangle soup with Manifold and normalize it; a bad mesh yields its status and no components. */
export function fromTriangles(ctx: KernelContext, req: FromTrianglesRequest): FromTrianglesResult {
  const runId = ctx.wasm.Manifold.reserveIDs(1);
  const r = tryManifoldFromSoup(ctx.wasm, req.mesh, runId);
  if (r.manifold === undefined) return { status: r.status, components: [], nextFaceId: req.nextFaceId };
  try {
    const fin = finalizeManifold(ctx, r.manifold, { nextFaceId: req.nextFaceId, chooseId: keepIdsFromRuns(new Set([runId])) });
    return { status: 'NoError', components: fin.components, nextFaceId: fin.nextFaceId };
  } finally {
    r.manifold.delete();
  }
}
