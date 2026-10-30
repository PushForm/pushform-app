// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ComponentsResult, HullRequest } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { allNewIds } from './normalize';

/** Convex hull of one or more cached bodies; every face of a hull is new. */
export function hull(ctx: KernelContext, req: HullRequest): ComponentsResult {
  if (req.bodies.length === 0) throw new KernelError('InvalidInput', 'hull needs at least one body');
  const manifolds = req.bodies.map((ref) => getBody(ctx, ref).manifold);
  return withScope((scope) => {
    const h = scope.track(ctx.wasm.Manifold.hull(manifolds));
    const fin = finalizeManifold(ctx, h, { nextFaceId: req.nextFaceId, chooseId: allNewIds });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  });
}
