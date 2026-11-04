// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Manifold } from 'manifold-3d';
import { box3Center, box3FromPositions, box3Union, MERGE_TOL, type Box3 } from '@pushform/core';
import type { BooleanRequest, BooleanResult, KernelComponent } from '../../protocol';
import type { CacheEntry } from '../ManifoldCache';
import type { KernelContext } from '../context';
import { withScope, type Scope } from '../context';
import { manifoldFromSoup } from '../meshio';
import { bodyTriangles, getBody } from './bodies';
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
    const [ma, mb] = req.op === 'add' ? sharedFrame(ctx, scope, a, b) : [a.manifold, b.manifold];
    const [primary, secondaryManifold] = combine(scope, req.op, ma, mb);
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

/**
 * Two bodies that touch, uploaded again around one shared centre. Each cached body was uploaded in
 * float32 around its own bounds centre, so a plane the two share (a rail butted against a stile)
 * can land a few nanometres apart in the two Manifolds and they would not join. Around a shared
 * centre the plane rounds the same way in both. Bodies that are apart keep their cached Manifolds;
 * the run ids stay the same, so face provenance is unchanged.
 */
function sharedFrame(ctx: KernelContext, scope: Scope, a: CacheEntry, b: CacheEntry): [Manifold, Manifold] {
  const ta = bodyTriangles(a), tb = bodyTriangles(b);
  const ba = box3FromPositions(ta.verts), bb = box3FromPositions(tb.verts);
  if (!touches(ba, bb)) return [a.manifold, b.manifold];
  const center = box3Center(box3Union(ba, bb));
  return [
    scope.track(manifoldFromSoup(ctx.wasm, ta, a.runId, center)),
    scope.track(manifoldFromSoup(ctx.wasm, tb, b.runId, center)),
  ];
}

function touches(a: Box3, b: Box3): boolean {
  return [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! + MERGE_TOL && b.min[i]! <= a.max[i]! + MERGE_TOL);
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
