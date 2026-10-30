// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Shared tail of every body-producing op: read the Manifold, normalize faces, rebuild it with
 * explicit face ids, simplify away redundant vertices, decompose into connected solids, measure.
 */
import type { Manifold } from 'manifold-3d';
import { COPLANAR_TOL } from '@pushform/core';
import type { FaceOrigin, KernelComponent } from '../../protocol';
import type { KernelContext } from '../context';
import { Scope } from '../context';
import { manifoldFromSoup, readManifold } from '../meshio';
import { normalizeTriangles, type ChooseFaceId, type NormalizedFace } from './normalize';

export interface FinalizeOptions {
  nextFaceId: number;
  chooseId: ChooseFaceId;
  /** Edges shorter than this and collinear vertices are removed; defaults to COPLANAR_TOL. */
  simplifyTolerance?: number;
}

export interface Finalized {
  components: KernelComponent[];
  /** Every face of the normalized result (before decompose), with its origins. */
  faces: NormalizedFace[];
  nextFaceId: number;
  /** originalID the normalized result was rebuilt with; every component's mesh carries it. */
  runId: number;
}

function subsetOrigin(all: FaceOrigin, faceId: Uint32Array): FaceOrigin {
  const out: FaceOrigin = new Map();
  for (const id of faceId) {
    if (out.has(id)) continue;
    const o = all.get(id);
    if (o !== undefined) out.set(id, o);
  }
  return out;
}

/** Normalize + rebuild + simplify + decompose + properties. Does not delete `m`. */
export function finalizeManifold(ctx: KernelContext, m: Manifold, opts: FinalizeOptions): Finalized {
  const read = readManifold(m);
  const norm = normalizeTriangles(read, opts.nextFaceId, opts.chooseId);
  const runId = ctx.wasm.Manifold.reserveIDs(1);
  if (norm.mesh.tris.length === 0) return { components: [], faces: [], nextFaceId: norm.nextFaceId, runId };

  const scope = new Scope();
  try {
    const rebuilt = scope.track(manifoldFromSoup(ctx.wasm, norm.mesh, runId));
    const simplified = scope.track(rebuilt.simplify(opts.simplifyTolerance ?? COPLANAR_TOL));
    const parts = simplified.decompose().map((p) => scope.track(p));
    const measured = parts.map((part) => ({ part, volume: part.volume(), area: part.surfaceArea() }));
    measured.sort((a, b) => b.volume - a.volume);
    const components: KernelComponent[] = measured.map(({ part, volume, area }) => {
      const r = readManifold(part);
      return {
        mesh: { verts: r.verts, tris: r.tris, faceId: r.faceId, runId },
        faceOrigin: subsetOrigin(norm.faceOrigin, r.faceId),
        props: { volume, area },
      };
    });
    return { components, faces: norm.faces, nextFaceId: norm.nextFaceId, runId };
  } finally {
    scope.dispose();
  }
}
