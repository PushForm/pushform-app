// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { KernelRequest, KernelResultMap, ResFor } from '../protocol';
import type { KernelContext } from './context';
import { autofold } from './ops/autofold';
import { ensureBody, release, stats } from './ops/bodies';
import { boolean } from './ops/boolean';
import { decompose } from './ops/decompose';
import { edgeBlend } from './ops/edgeBlend';
import { followMe } from './ops/followMe';
import { fromTriangles } from './ops/fromTriangles';
import { hull } from './ops/hull';
import { properties } from './ops/properties';
import { revolve } from './ops/revolve';
import { extrudeSketch, pushPull } from './ops/pushPull';
import { sectionCut } from './ops/sectionCut';
import { simplify } from './ops/simplify';
import { transform } from './ops/transform';

function dispatchAny(ctx: KernelContext, req: KernelRequest): KernelResultMap[KernelRequest['type']] {
  switch (req.type) {
    case 'init':
      return { ready: true };
    case 'ensureBody':
      return ensureBody(ctx, req);
    case 'pushPull':
      return pushPull(ctx, req);
    case 'extrudeSketch':
      return extrudeSketch(ctx, req);
    case 'boolean':
      return boolean(ctx, req);
    case 'transform':
      return transform(ctx, req);
    case 'autofold':
      return autofold(ctx, req);
    case 'sectionCut':
      return sectionCut(ctx, req);
    case 'properties':
      return properties(ctx, req);
    case 'fromTriangles':
      return fromTriangles(ctx, req);
    case 'decompose':
      return decompose(ctx, req);
    case 'simplify':
      return simplify(ctx, req);
    case 'hull':
      return hull(ctx, req);
    case 'followMe':
      return followMe(ctx, req);
    case 'revolve':
      return revolve(ctx, req);
    case 'edgeBlend':
      return edgeBlend(ctx, req);
    case 'release':
      return release(ctx, req);
    case 'stats':
      return stats(ctx, req);
  }
}

/** Route a request to its op. Ops are synchronous; errors are thrown as `KernelError`. */
export function dispatch<R extends KernelRequest>(ctx: KernelContext, req: R): ResFor<R> {
  return dispatchAny(ctx, req) as ResFor<R>;
}

/** Collect the ArrayBuffers backing every typed array inside `value` (for `postMessage` transfer). */
export function collectTransferables(value: unknown, out: ArrayBuffer[] = [], seen = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (value === null || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
      seen.add(buffer);
      out.push(buffer);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTransferables(v, out, seen);
  } else if (value instanceof Map) {
    for (const v of value.values()) collectTransferables(v, out, seen);
  } else {
    for (const v of Object.values(value)) collectTransferables(v, out, seen);
  }
  return out;
}
