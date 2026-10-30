// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { MVec3, Vec3 } from '@pushform/core';
import { LENGTH_TOL, PushFormError, v3cross, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import { DEFAULT_AXES, definitionAt } from '@pushform/model';
import type { Axes, DocumentState } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import { currentFrame } from './context';

/**
 * Axes (Axes tool, context menu Reset). Written to the current context's definition (`axes`,
 * context-local): the model axes at the root, a component's axes inside it. Params are world.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * Right-handed orthonormal axes from an origin, an x direction and a y hint: x is normalized,
 * y is made perpendicular to x, z = x × y. A provided `z` only flips y when it points the other
 * way (axes are always right-handed).
 */
export function orthonormalAxes(origin: Vec3, x: Vec3, y: Vec3, z?: Vec3): Axes {
  if (v3len(x) <= LENGTH_TOL) throw new PushFormError('axes.degenerate', 'Axis directions must be non-zero');
  const ux = v3normalize(x);
  let uy: MVec3 = v3sub(y, [ux[0] * v3dot(ux, y), ux[1] * v3dot(ux, y), ux[2] * v3dot(ux, y)]);
  if (v3len(uy) <= LENGTH_TOL) throw new PushFormError('axes.degenerate', 'Axis directions must not be parallel');
  uy = v3normalize(uy);
  let uz = v3cross(ux, uy);
  if (z && v3dot(z, uz) < 0) {
    uy = [-uy[0], -uy[1], -uy[2]];
    uz = v3cross(ux, uy);
  }
  return { origin: [origin[0], origin[1], origin[2]], x: ux, y: uy, z: uz };
}

export const axesSet = defineCommand({
  id: 'axes.set',
  title: 'Place Axes',
  category: 'edit',
  params: z.object({ origin: vec3, x: vec3, y: vec3, z: vec3.optional() }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const f = currentFrame(host);
    const axes = orthonormalAxes(f.toLocal(p.origin), f.toLocalDir(p.x), f.toLocalDir(p.y), p.z ? f.toLocalDir(p.z) : undefined);
    host.edit('Place Axes', (draft) => {
      const def = definitionAt(draft as unknown as DocumentState, f.path);
      def.axes = { origin: [...axes.origin], x: [...axes.x], y: [...axes.y], z: [...axes.z] };
    });
    return axes;
  },
});

export const axesReset = defineCommand({
  id: 'axes.reset',
  title: 'Reset Axes',
  category: 'edit',
  params: z.object({}),
  undoable: true,
  run(ctx) {
    const host = hostOf(ctx);
    const path = host.context.path;
    host.edit('Reset Axes', (draft) => {
      const def = definitionAt(draft as unknown as DocumentState, path);
      def.axes = { origin: [...DEFAULT_AXES.origin], x: [...DEFAULT_AXES.x], y: [...DEFAULT_AXES.y], z: [...DEFAULT_AXES.z] };
    });
    return DEFAULT_AXES;
  },
});

export const axesCommands: readonly AnyCommand[] = [axesSet, axesReset];
