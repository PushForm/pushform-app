// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COPLANAR_TOL } from '@pushform/core';
import type { ComponentsResult, SimplifyRequest } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

/** Manifold `simplify(tolerance)`: collapses edges shorter than the tolerance; face ids are kept. */
export function simplify(ctx: KernelContext, req: SimplifyRequest): ComponentsResult {
  const entry = getBody(ctx, req.body);
  const tolerance = req.tolerance ?? COPLANAR_TOL;
  return withScope((scope) => {
    const simplified = scope.track(entry.manifold.simplify(tolerance));
    const fin = finalizeManifold(ctx, simplified, {
      nextFaceId: req.nextFaceId,
      chooseId: keepIdsFromRuns(new Set([entry.runId])),
      simplifyTolerance: tolerance,
    });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  });
}
