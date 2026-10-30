// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Fillet / Chamfer: subtract the union of the `cut` prisms from a cached body and add the
 * union of the `add` prisms, in one op. The prisms are explicit closed meshes built by the caller
 * (one per picked edge, mitred where picked edges meet); they are quantized to float32 about one
 * shared centre so the vertices two prisms share on a mitre land on identical coordinates.
 */
import type { Manifold } from 'manifold-3d';
import { box3Center, box3FromPositions, type Vec3 } from '@pushform/core';
import type { EdgeBlendRequest, EdgeBlendResult, ToolSoup } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext, Scope } from '../context';
import { withScope } from '../context';
import { getBody } from './bodies';
import { finalizeManifold } from './finalize';
import { keepIdsFromRuns } from './normalize';

function prismManifold(ctx: KernelContext, scope: Scope, soup: ToolSoup, runId: number, center: Vec3, index: number): Manifold {
  const n = soup.verts.length;
  const props = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    props[i] = soup.verts[i]! - center[0];
    props[i + 1] = soup.verts[i + 1]! - center[1];
    props[i + 2] = soup.verts[i + 2]! - center[2];
  }
  if (soup.tris.length === 0 || soup.tris.length % 3 !== 0 || soup.faceId.length !== soup.tris.length / 3) {
    throw new KernelError('InvalidInput', `edgeBlend prism ${index} has a malformed mesh`);
  }
  const mesh = new ctx.wasm.Mesh({
    numProp: 3,
    vertProperties: props,
    triVerts: new Uint32Array(soup.tris),
    faceID: new Uint32Array(soup.faceId),
    runIndex: new Uint32Array([0, soup.tris.length]),
    runOriginalID: new Uint32Array([runId]),
  });
  let local: Manifold;
  try {
    local = scope.track(new ctx.wasm.Manifold(mesh));
  } catch (e) {
    const status = (e as { code?: unknown } | null)?.code;
    throw new KernelError('InvalidInput', `edgeBlend prism ${index} is not a valid solid (${String(status ?? 'Unknown')})`, { status, prism: index });
  }
  const status = local.status();
  if (status !== 'NoError') throw new KernelError('InvalidInput', `edgeBlend prism ${index} is not a valid solid (${status})`, { status, prism: index });
  return scope.track(local.translate(center[0], center[1], center[2]));
}

export function edgeBlend(ctx: KernelContext, req: EdgeBlendRequest): EdgeBlendResult {
  const body = getBody(ctx, req.body);
  if (req.cut.length === 0 && req.add.length === 0) throw new KernelError('InvalidInput', 'edgeBlend needs at least one tool prism');
  const all = [...req.cut, ...req.add];
  const positions: number[] = [];
  for (const s of all) for (const v of s.verts) positions.push(v);
  const center = box3Center(box3FromPositions(Float64Array.from(positions)));
  const toolRunId = ctx.wasm.Manifold.reserveIDs(1);
  return withScope((scope) => {
    let index = 0;
    const unionOf = (soups: readonly ToolSoup[]): Manifold | undefined => {
      if (soups.length === 0) return undefined;
      const parts = soups.map((s) => prismManifold(ctx, scope, s, toolRunId, center, index++));
      return parts.length === 1 ? parts[0]! : scope.track(ctx.wasm.Manifold.union(parts));
    };
    let m = body.manifold;
    const cut = unionOf(req.cut);
    if (cut) m = scope.track(m.subtract(cut));
    const add = unionOf(req.add);
    if (add) m = scope.track(m.add(add));
    const fin = finalizeManifold(ctx, m, { nextFaceId: req.nextFaceId, chooseId: keepIdsFromRuns(new Set([body.runId])) });
    return { components: fin.components, nextFaceId: fin.nextFaceId, bodyRunId: body.runId, toolRunId };
  });
}
