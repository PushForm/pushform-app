// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Cache-facing ops: ensureBody, release, stats, plus the body lookup every other op uses. */
import type {
  BodyRef,
  EnsureBodyRequest,
  EnsureBodyResponse,
  ReleaseRequest,
  ReleaseResult,
  StatsRequest,
  StatsResult,
} from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import type { CacheEntry } from '../ManifoldCache';
import { manifoldFromSoup, readManifold, type ReadMesh } from '../meshio';

/** Look up a cached body or throw `BodyNotCached` (the backend re-uploads and retries on this code). */
export function getBody(ctx: KernelContext, ref: BodyRef): CacheEntry {
  const entry = ctx.cache.get(ref.bodyId, ref.version);
  if (entry === undefined) {
    throw new KernelError('BodyNotCached', `Body ${ref.bodyId} v${ref.version} is not cached`, {
      bodyId: ref.bodyId,
      version: ref.version,
    });
  }
  return entry;
}

/** The body's triangles in world coordinates, read once and memoized on the cache entry. */
export function bodyTriangles(entry: CacheEntry): ReadMesh {
  entry.mesh ??= readManifold(entry.manifold);
  return entry.mesh;
}

export function ensureBody(ctx: KernelContext, req: EnsureBodyRequest): EnsureBodyResponse {
  const existing = ctx.cache.get(req.bodyId, req.version);
  if (existing !== undefined) return { status: 'cached', runId: existing.runId };
  if (req.mesh === undefined) return { status: 'needMesh', runId: 0 };
  const runId = ctx.wasm.Manifold.reserveIDs(1);
  const manifold = manifoldFromSoup(ctx.wasm, req.mesh, runId);
  ctx.cache.set(req.bodyId, req.version, {
    manifold,
    runId,
    mesh: { verts: req.mesh.verts, tris: req.mesh.tris, faceId: req.mesh.faceId, runId: new Uint32Array(req.mesh.faceId.length).fill(runId) },
  });
  return { status: 'cached', runId };
}

export function release(ctx: KernelContext, req: ReleaseRequest): ReleaseResult {
  return { released: ctx.cache.release(req.bodyId, req.version) };
}

export function stats(ctx: KernelContext, _req: StatsRequest): StatsResult {
  const heap = (ctx.wasm as unknown as { HEAPU8?: Uint8Array }).HEAPU8;
  return { cached: ctx.cache.size, heapBytes: heap?.byteLength ?? 0 };
}
