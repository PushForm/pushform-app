// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData } from '@pushform/core';
import type { KernelBackend } from '../backends/KernelBackend';
import type {
  BooleanRequest,
  BooleanResult,
  ComponentsResult,
  DecomposeRequest,
  EdgeBlendRequest,
  EdgeBlendResult,
  ExtrudeSketchRequest,
  FromTrianglesRequest,
  FromTrianglesResult,
  HullRequest,
  AutofoldRequest,
  FollowMeRequest,
  RevolveRequest,
  InitResponse,
  MeshWire,
  PropertiesRequest,
  PropertiesResult,
  PushPullRequest,
  PushPullResult,
  ReleaseResult,
  SectionCutRequest,
  SectionCutResult,
  SimplifyRequest,
  StatsResult,
  TransformRequest,
} from '../protocol';
import { KernelError } from '../protocol';

type Params<R extends { type: string }> = Omit<R, 'type'>;

/** Outcome of a coalesced call: the value when it is still the latest for its key, else `superseded`. */
export type CoalescedResult<T> = { status: 'current'; value: T } | { status: 'superseded' };

interface CoalesceState {
  gen: number;
  running: boolean;
  pending: { gen: number; fn: () => Promise<unknown>; resolve: (r: CoalescedResult<unknown>) => void; reject: (e: unknown) => void } | undefined;
}

interface Upload {
  version: number;
  mesh: MeshWire;
  runId: Promise<number>;
}

/** Wrap a canonical mesh for the wire without copying (backends never mutate request arrays). */
export function toMeshWire(mesh: MeshData, runId = 0): MeshWire {
  return { verts: mesh.verts, tris: mesh.tris, faceId: mesh.faceId, runId };
}

/**
 * Typed promise API over a {@link KernelBackend} with upload tracking (`ensureBody`) and per-key
 * coalescing (`coalesced`) for drag previews: one request in flight, one pending latest; anything
 * in between resolves as `superseded` and a result that finishes after a newer call is dropped.
 */
export class KernelClient {
  private readonly uploads = new Map<number, Upload>();
  private readonly coalesce = new Map<string, CoalesceState>();

  constructor(private readonly backend: KernelBackend) {
    backend.setMeshProvider?.((bodyId, version) => {
      const u = this.uploads.get(bodyId);
      return u !== undefined && u.version === version ? u.mesh : undefined;
    });
  }

  init(): Promise<InitResponse> {
    return this.backend.request({ type: 'init' });
  }

  /**
   * Make sure (bodyId, version) is cached in the worker, uploading `mesh` once. Resolves with the
   * worker-side runId. Only the latest version per body is remembered for re-uploads.
   */
  ensureBody(bodyId: number, version: number, mesh: MeshData | MeshWire): Promise<number> {
    const existing = this.uploads.get(bodyId);
    if (existing !== undefined && existing.version === version) return existing.runId;
    const wire = 'runId' in mesh ? mesh : toMeshWire(mesh);
    const runId = this.backend.request({ type: 'ensureBody', bodyId, version, mesh: wire }).then((res) => {
      if (res.status !== 'cached') throw new KernelError('Internal', 'worker asked for a mesh that was just sent');
      return res.runId;
    });
    const upload: Upload = { version, mesh: wire, runId };
    this.uploads.set(bodyId, upload);
    runId.catch(() => {
      if (this.uploads.get(bodyId) === upload) this.uploads.delete(bodyId);
    });
    return runId;
  }

  /** Forget a body on both sides. */
  async release(bodyId: number, version?: number): Promise<ReleaseResult> {
    const u = this.uploads.get(bodyId);
    if (u !== undefined && (version === undefined || u.version === version)) this.uploads.delete(bodyId);
    return this.backend.request(version === undefined ? { type: 'release', bodyId } : { type: 'release', bodyId, version });
  }

  pushPull(params: Params<PushPullRequest>): Promise<PushPullResult> {
    return this.backend.request({ type: 'pushPull', ...params });
  }
  extrudeSketch(params: Params<ExtrudeSketchRequest>): Promise<PushPullResult> {
    return this.backend.request({ type: 'extrudeSketch', ...params });
  }
  boolean(params: Params<BooleanRequest>): Promise<BooleanResult> {
    return this.backend.request({ type: 'boolean', ...params });
  }
  fromTriangles(params: Params<FromTrianglesRequest>): Promise<FromTrianglesResult> {
    return this.backend.request({ type: 'fromTriangles', ...params });
  }
  properties(params: Params<PropertiesRequest>): Promise<PropertiesResult> {
    return this.backend.request({ type: 'properties', ...params });
  }
  transform(params: Params<TransformRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'transform', ...params });
  }
  decompose(params: Params<DecomposeRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'decompose', ...params });
  }
  sectionCut(params: Params<SectionCutRequest>): Promise<SectionCutResult> {
    return this.backend.request({ type: 'sectionCut', ...params });
  }
  simplify(params: Params<SimplifyRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'simplify', ...params });
  }
  hull(params: Params<HullRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'hull', ...params });
  }
  autofold(params: Params<AutofoldRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'autofold', ...params });
  }
  followMe(params: Params<FollowMeRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'followMe', ...params });
  }
  revolve(params: Params<RevolveRequest>): Promise<ComponentsResult> {
    return this.backend.request({ type: 'revolve', ...params });
  }
  edgeBlend(params: Params<EdgeBlendRequest>): Promise<EdgeBlendResult> {
    return this.backend.request({ type: 'edgeBlend', ...params });
  }
  stats(): Promise<StatsResult> {
    return this.backend.request({ type: 'stats' });
  }

  /**
   * Run `fn` coalesced under `key`. While a call for the key is in flight the newest later call waits
   * as the single pending one; older waiting calls, and in-flight results overtaken by a newer call,
   * resolve as `superseded`. Errors only propagate from calls that are still current.
   */
  coalesced<T>(key: string, fn: () => Promise<T>): Promise<CoalescedResult<T>> {
    let state = this.coalesce.get(key);
    if (state === undefined) {
      state = { gen: 0, running: false, pending: undefined };
      this.coalesce.set(key, state);
    }
    const gen = ++state.gen;
    if (!state.running) return this.runCoalesced(key, state, gen, fn);
    state.pending?.resolve({ status: 'superseded' });
    const s = state;
    return new Promise<CoalescedResult<T>>((resolve, reject) => {
      s.pending = { gen, fn, resolve: resolve as (r: CoalescedResult<unknown>) => void, reject };
    });
  }

  private async runCoalesced<T>(key: string, state: CoalesceState, gen: number, fn: () => Promise<T>): Promise<CoalescedResult<T>> {
    state.running = true;
    try {
      const value = await fn();
      return gen === state.gen ? { status: 'current', value } : { status: 'superseded' };
    } catch (e) {
      if (gen === state.gen) throw e;
      return { status: 'superseded' };
    } finally {
      state.running = false;
      const next = state.pending;
      state.pending = undefined;
      if (next !== undefined) {
        this.runCoalesced(key, state, next.gen, next.fn).then(next.resolve, next.reject);
      } else if (this.coalesce.get(key) === state) {
        this.coalesce.delete(key);
      }
    }
  }

  /** Abort everything in flight and forget uploads (the backend's cache is gone after a restart). */
  abortAll(): void {
    this.backend.abortAll();
    this.uploads.clear();
  }

  dispose(): void {
    this.backend.dispose();
    this.uploads.clear();
  }
}
