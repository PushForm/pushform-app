// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import * as D from '../cabinet/dimensions';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec } from '../builders/parts';

const WIDTH_RANGE = [D.inches(1 / 2), D.inches(12)] as const;
const THICKNESS_RANGE = [D.inches(1 / 4), D.inches(3 / 2)] as const;
const RETURN_DEPTH_RANGE = [D.inches(1 / 2), D.inches(24)] as const;
const DEFAULT_RETURN_DEPTH = D.inches(3);

export interface FillerParams {
  readonly width: number;
  readonly type?: keyof typeof D.DEFAULT_HEIGHT | undefined;
  readonly height?: number | undefined;
  readonly thickness?: number | undefined;
  readonly at?: Vec3 | undefined;
  readonly return?: { readonly side: 'left' | 'right'; readonly depth?: number | undefined } | undefined;
  readonly finish?: { readonly paint?: string | undefined; readonly stain?: string | undefined } | undefined;
  readonly name?: string | undefined;
}

const outside = (v: number, r: readonly [number, number]): boolean => v < r[0] - LENGTH_TOL || v > r[1] + LENGTH_TOL;
const unsound = (message: string): BuilderPlanError => new BuilderPlanError('invalid_geometry', message);

export function planFiller(p: FillerParams): BuilderPlan {
  const type = p.type ?? 'base', width = p.width;
  const toe = type === 'wall' ? 0 : D.TOE_KICK_HEIGHT;
  const height = p.height ?? D.DEFAULT_HEIGHT[type] - toe, thickness = p.thickness ?? D.STOCK;
  if (p.finish?.paint !== undefined && p.finish.stain !== undefined) throw new BuilderPlanError('invalid_operation', 'finish takes paint or stain, not both.');
  if (outside(width, WIDTH_RANGE)) throw unsound('A filler is 1/2 to 12 in wide. For anything wider, use end_panel or add_cabinet.');
  if (outside(height, D.HEIGHT_RANGE)) throw unsound('A filler is 12 to 108 in tall. Build a shorter or taller piece by hand.');
  if (outside(thickness, THICKNESS_RANGE)) throw unsound('A filler is 1/4 to 1 1/2 in thick. Build a thinner or thicker strip by hand.');
  const returnDepth = p.return ? p.return.depth ?? DEFAULT_RETURN_DEPTH : 0;
  if (p.return && outside(returnDepth, RETURN_DEPTH_RANGE)) throw unsound('A return is 1/2 to 24 in deep. Build a longer return by hand.');
  if (p.return && thickness > width + LENGTH_TOL) throw unsound('A filler with a return must be at least as wide as it is thick. Widen it or remove the return.');

  const at: Vec3 = p.at ?? [-width, -thickness, type === 'wall' ? D.WALL_HANG_HEIGHT : toe];
  const b = new Builder();
  b.add('Filler', null, 'finish', range(0, width), range(0, thickness), range(0, height), '+z', '+x');
  if (p.return) {
    const x = p.return.side === 'left' ? range(0, thickness) : range(width - thickness, width);
    b.add('Filler Return', null, 'finish', x, range(thickness, thickness + returnDepth), range(0, height), '+z', '+y');
  }
  const finish: MaterialSpec = p.finish?.stain !== undefined ? { library: p.finish.stain } : { paint: p.finish?.paint ?? D.DEFAULT_PAINT };
  return {
    name: p.name ?? 'Filler', at, parts: b.parts, materials: { finish },
    used: { type, width, height, thickness, at, return: p.return ? { side: p.return.side, depth: returnDepth } : null, finish: p.finish ?? { paint: D.DEFAULT_PAINT } },
  };
}
