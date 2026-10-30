// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Revolve (lathe): a planar profile swept about an axis lying in its plane, via `CrossSection.revolve`.
 * The profile is expressed in a frame whose Z is the axis and whose X points to the side holding most
 * of the profile; the part on the negative-X side of the axis is clipped away; the revolved solid is
 * transformed back to world space and finalized with all-new face ids.
 */
import type { Mat4, SimplePolygon } from 'manifold-3d';
import { AREA_TOL, basisToWorld, m4fromBasis, v3addScaled, v3cross, v3dot, v3len, v3normalize, v3sub, type Vec3 } from '@pushform/core';
import { normalizePolygon, signedArea } from '@pushform/geom';
import type { ComponentsResult, RevolveRequest } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { finalizeManifold } from './finalize';
import { allNewIds } from './normalize';

interface LatheFrame {
  /** Column-major world transform of the lathe frame (x = radial, z = axis). */
  matrix: Mat4;
  /** Profile rings in (radius, height), outer CCW and holes CW. */
  rings: SimplePolygon[];
  /** Largest |coordinate| of the profile, for the clipping rectangle. */
  extent: number;
}

function latheFrame(req: RevolveRequest): LatheFrame {
  const n = req.profileBasis.n;
  if (!Number.isFinite(v3len(req.axisDir)) || v3len(req.axisDir) === 0) throw new KernelError('InvalidInput', 'revolve.axisDir must be non-zero');
  // Axis projected into the profile plane (a lathe axis lies in its profile's plane).
  const z = v3addScaled(req.axisDir, n, -v3dot(req.axisDir, n));
  if (v3len(z) < 1e-9) throw new KernelError('InvalidInput', 'revolve.axisDir is perpendicular to the profile plane');
  const Z = v3normalize(z);
  const O = v3addScaled(req.axisOrigin, n, -v3dot(v3sub(req.axisOrigin, req.profileBasis.origin), n));
  const X0 = v3normalize(v3cross(n, Z));

  const world = req.profile.map((ring) => ring.map((p) => basisToWorld(req.profileBasis, p[0] ?? 0, p[1] ?? 0)));
  const outer = world[0];
  if (outer === undefined || outer.length < 3) throw new KernelError('InvalidInput', 'revolve.profile needs an outer ring');
  let cx = 0;
  for (const p of outer) cx += v3dot(v3sub(p, O), X0);
  const X: Vec3 = cx >= 0 ? X0 : [-X0[0], -X0[1], -X0[2]];
  const Y = v3cross(Z, X);

  let extent = 0;
  const rings = world.map((ring) =>
    ring.map((p): [number, number] => {
      const r = v3sub(p, O);
      const x = v3dot(r, X), y = v3dot(r, Z);
      extent = Math.max(extent, Math.abs(x), Math.abs(y));
      return [x, y];
    }),
  );
  const norm = normalizePolygon(rings).filter((ring) => ring.length >= 3) as SimplePolygon[];
  if (norm.length === 0 || Math.abs(signedArea(norm[0]!)) <= AREA_TOL) throw new KernelError('InvalidInput', 'revolve.profile has no area');
  return { matrix: m4fromBasis(O, X, Y, Z) as Mat4, rings: norm, extent };
}

/** Revolve a profile about an axis; `segments` facets per full turn (at least 3 over the revolved angle). */
export function revolve(ctx: KernelContext, req: RevolveRequest): ComponentsResult {
  if (!Number.isFinite(req.angleDeg) || req.angleDeg <= 0 || req.angleDeg > 360) {
    throw new KernelError('InvalidInput', 'revolve.angleDeg must be in (0, 360]');
  }
  if (!Number.isInteger(req.segments) || req.segments < 3) throw new KernelError('InvalidInput', 'revolve.segments must be an integer >= 3');
  const frame = latheFrame(req);
  const { CrossSection } = ctx.wasm;
  return withScope((scope) => {
    const cs = scope.track(new CrossSection(frame.rings, 'Positive'));
    const w = frame.extent * 2 + 1;
    const half = scope.track(new CrossSection([[[0, -w], [w, -w], [w, w], [0, w]]], 'Positive'));
    const clipped = scope.track(cs.intersect(half));
    if (clipped.isEmpty()) throw new KernelError('InvalidInput', 'revolve.profile lies entirely on the far side of the axis');
    // Manifold spreads `circularSegments` over the revolved angle, so scale the per-turn count.
    const divisions = Math.max(3, Math.ceil((req.segments * req.angleDeg) / 360));
    const local = scope.track(clipped.revolve(divisions, req.angleDeg));
    const solid = scope.track(local.transform(frame.matrix));
    const fin = finalizeManifold(ctx, solid, { nextFaceId: req.nextFaceId, chooseId: allNewIds });
    return { components: fin.components, nextFaceId: fin.nextFaceId };
  });
}
