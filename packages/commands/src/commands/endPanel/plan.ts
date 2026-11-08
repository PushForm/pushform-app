// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import * as D from '../cabinet/dimensions';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec } from '../builders/parts';

const DEPTH_RANGE = [D.inches(6), D.inches(36)] as const;
const THICKNESS_RANGE = [D.inches(1 / 8), D.inches(3 / 2)] as const;
/** The door stock in front of the box, which a default panel reaches so its edge is flush with the doors. */
const DOOR_OVERHANG = D.STOCK;
const MIN_ABOVE_NOTCH = D.inches(6);
const MIN_BEHIND_NOTCH = D.inches(3);

export interface EndPanelParams {
  readonly type?: keyof typeof D.DEFAULT_HEIGHT | undefined;
  readonly height?: number | undefined;
  readonly depth?: number | undefined;
  readonly thickness?: number | undefined;
  readonly toeKick?: boolean | { readonly height?: number | undefined; readonly depth?: number | undefined } | undefined;
  readonly at?: Vec3 | undefined;
  readonly finish?: { readonly paint?: string | undefined; readonly stain?: string | undefined } | undefined;
  readonly name?: string | undefined;
}

const outside = (v: number, r: readonly [number, number]): boolean => v < r[0] - LENGTH_TOL || v > r[1] + LENGTH_TOL;
const unsound = (message: string): BuilderPlanError => new BuilderPlanError('invalid_geometry', message);

export function planEndPanel(p: EndPanelParams): BuilderPlan {
  const type = p.type ?? 'base';
  const height = p.height ?? D.DEFAULT_HEIGHT[type], depth = p.depth ?? D.DEFAULT_DEPTH[type] + DOOR_OVERHANG, thickness = p.thickness ?? D.STOCK;
  if (p.finish?.paint !== undefined && p.finish.stain !== undefined) throw new BuilderPlanError('invalid_operation', 'finish takes paint or stain, not both.');
  if (type === 'wall' && p.toeKick !== undefined && p.toeKick !== false) throw new BuilderPlanError('invalid_operation', 'A wall panel has no toe kick; remove toeKick.');
  if (outside(height, D.HEIGHT_RANGE)) throw unsound('An end panel is 12 to 108 in tall. Build a shorter or taller panel by hand.');
  if (outside(depth, DEPTH_RANGE)) throw unsound('An end panel is 6 to 36 in deep. Build a shallower or deeper panel by hand.');
  if (outside(thickness, THICKNESS_RANGE)) throw unsound('An end panel is 1/8 to 1 1/2 in thick. Build a thinner or thicker panel by hand.');

  const notched = type !== 'wall' && p.toeKick !== false;
  const custom = typeof p.toeKick === 'object' ? p.toeKick : undefined;
  const notchHeight = notched ? custom?.height ?? D.TOE_KICK_HEIGHT : 0, notchDepth = notched ? custom?.depth ?? D.TOE_KICK_DEPTH : 0;
  if (notched && (notchHeight > height - MIN_ABOVE_NOTCH + LENGTH_TOL || notchDepth > depth - MIN_BEHIND_NOTCH + LENGTH_TOL))
    throw unsound('The toe kick notch must leave at least 6 in of panel above it and 3 in behind it. Make it smaller or remove toeKick.');

  const at: Vec3 = p.at ?? [-thickness, -DOOR_OVERHANG, type === 'wall' ? D.WALL_HANG_HEIGHT : 0];
  const b = new Builder();
  // Length up the panel, width back along y: the notch at the front bottom is the corner at the local origin.
  b.add('End Panel', null, 'finish', range(0, thickness), range(0, depth), range(0, height), '+z', '+y', notched ? { cuts: [{ min: [0, 0, 0], max: [notchHeight, notchDepth, thickness] }] } : {});
  const finish: MaterialSpec = p.finish?.stain !== undefined ? { library: p.finish.stain } : { paint: p.finish?.paint ?? D.DEFAULT_PAINT };
  return {
    name: p.name ?? 'End Panel', at, parts: b.parts, materials: { finish },
    used: { type, height, depth, thickness, at, toeKick: notched ? { height: notchHeight, depth: notchDepth } : null, finish: p.finish ?? { paint: D.DEFAULT_PAINT } },
  };
}
