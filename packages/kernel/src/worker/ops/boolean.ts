// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Manifold } from 'manifold-3d';
import type { BooleanRequest, BooleanResult, KernelComponent } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope, type Scope } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

/**
 * Booleans between two cached bodies. Faces that come from `a` keep their ids; faces from `b` get
 * fresh ids (their origin is still reported so materials can be copied). `split` returns the inside
 * in `components` and the outside in `secondary`; `trim` is `a - b` with `b` left untouched.
 */
export function boolean(ctx: KernelContext, req: BooleanRequest): BooleanResult {
  const a = getBody(ctx, req.a);
  const b = getBody(ctx, req.b);
  const chooseId = keepIdsFromRuns(new Set([a.runId]));
  return withScope((scope) => {
    const [primary, secondaryManifold] = combine(scope, req.op, a.manifold, b.manifold);
    const fin = finalizeManifold(ctx, primary, { nextFaceId: req.nextFaceId, chooseId });
    let secondary: KernelComponent[] = [];
    let nextFaceId = fin.nextFaceId;
    if (secondaryManifold !== undefined) {
      const fin2 = finalizeManifold(ctx, secondaryManifold, { nextFaceId, chooseId });
      secondary = fin2.components;
      nextFaceId = fin2.nextFaceId;
    }
    return { components: fin.components, secondary, nextFaceId, aRunId: a.runId, bRunId: b.runId };
  });
}

function combine(scope: Scope, op: BooleanRequest['op'], a: Manifold, b: Manifold): [Manifold, Manifold | undefined] {
  switch (op) {
    case 'add':
      return [scope.track(a.add(b)), undefined];
    case 'subtract':
    case 'trim':
      return [scope.track(a.subtract(b)), undefined];
    case 'intersect':
      return [scope.track(a.intersect(b)), undefined];
    case 'split': {
      const [inside, outside] = a.split(b);
      return [scope.track(inside), scope.track(outside)];
    }
  }
}
