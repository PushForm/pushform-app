// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ComponentsResult, DecomposeRequest } from '../../protocol';
import type { KernelContext } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

/** One component per connected solid, largest volume first; face ids are kept. */
export function decompose(ctx: KernelContext, req: DecomposeRequest): ComponentsResult {
  const entry = getBody(ctx, req.body);
  const fin = finalizeManifold(ctx, entry.manifold, { nextFaceId: req.nextFaceId, chooseId: keepIdsFromRuns(new Set([entry.runId])) });
  return { components: fin.components, nextFaceId: fin.nextFaceId };
}
