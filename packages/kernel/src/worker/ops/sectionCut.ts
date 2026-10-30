// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mat4 } from 'manifold-3d';
import { COPLANAR_TOL, basisToWorld, m4fromBasis, m4invert, planeBasis, v3scale } from '@pushform/core';
import type { SectionCutRequest, SectionCutResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { getBody } from './bodies';

/**
 * Plane ∩ body as closed loops. The body is moved into the plane's basis frame (plane -> z = 0) and
 * sliced with Manifold's `slice`, then the 2D polygons are mapped back to world space.
 */
export function sectionCut(ctx: KernelContext, req: SectionCutRequest): SectionCutResult {
  const entry = getBody(ctx, req.body);
  const basis = planeBasis(v3scale(req.plane.n, -req.plane.d), req.plane.n);
  const toLocal = m4invert(m4fromBasis(basis.origin, basis.u, basis.v, basis.n));
  if (toLocal === null) throw new KernelError('InvalidInput', 'sectionCut.plane normal must be non-zero');
  return withScope((scope) => {
    const local = scope.track(entry.manifold.transform(toLocal as Mat4));
    // slice() keeps every triangle-plane crossing; simplify drops the collinear ones.
    const cross = scope.track(scope.track(local.slice(0)).simplify(COPLANAR_TOL));
    const loops = cross.toPolygons().map((poly) => {
      const out = new Float64Array(poly.length * 3);
      poly.forEach(([x, y], i) => out.set(basisToWorld(basis, x, y), i * 3));
      return out;
    });
    return { loops };
  });
}
