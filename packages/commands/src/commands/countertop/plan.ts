// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import type { CutBox } from '../builders/mesh';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec } from '../builders/parts';

const inches = (n: number): number => n * 0.0254;
const DEFAULT_DEPTH = inches(25), DEFAULT_THICKNESS = inches(1.5), DEFAULT_CUTOUT_DEPTH = inches(16), DEFAULT_FROM_FRONT = inches(2.5);
const SPLASH_THICKNESS = inches(3 / 4), MIN_MARGIN = inches(1);
const DEFAULT_AT: Vec3 = [0, -inches(1.75), inches(34.5)];
const DEFAULT_FINISH = '#e6e2d8';

export interface CountertopParams {
  readonly width: number;
  readonly depth?: number | undefined;
  readonly thickness?: number | undefined;
  readonly at?: Vec3 | undefined;
  readonly leg?: { readonly side: 'left' | 'right'; readonly length: number; readonly depth?: number | undefined } | undefined;
  readonly cutouts?: readonly { readonly x: number; readonly width: number; readonly depth?: number | undefined; readonly fromFront?: number | undefined }[] | undefined;
  readonly backsplash?: number | undefined;
  readonly finish?: { readonly paint?: string | undefined; readonly library?: string | undefined } | undefined;
  readonly name?: string | undefined;
}

export function planCountertop(p: CountertopParams): BuilderPlan {
  const { width } = p;
  const depth = p.depth ?? DEFAULT_DEPTH, thickness = p.thickness ?? DEFAULT_THICKNESS, at = p.at ?? DEFAULT_AT;
  if (p.finish?.paint !== undefined && p.finish.library !== undefined) throw new BuilderPlanError('invalid_operation', 'finish takes paint or library, not both.');
  const legDepth = p.leg ? p.leg.depth ?? depth : 0, legLength = p.leg?.length ?? 0;
  if (p.leg && legDepth >= width) throw new BuilderPlanError('invalid_geometry', 'The leg is as wide as the whole top, so there is no L to make.');
  const total = depth + legLength;
  const front = legLength;
  const cuts: CutBox[] = [];
  if (p.leg) cuts.push(p.leg.side === 'left'
    ? { min: [legDepth, 0, 0], max: [width, legLength, thickness] }
    : { min: [0, 0, 0], max: [width - legDepth, legLength, thickness] });
  for (const c of p.cutouts ?? []) {
    const cutDepth = c.depth ?? DEFAULT_CUTOUT_DEPTH, fromFront = c.fromFront ?? DEFAULT_FROM_FRONT;
    if (c.x < MIN_MARGIN - 1e-9 || c.x + c.width > width - MIN_MARGIN + 1e-9 || fromFront < MIN_MARGIN - 1e-9 || fromFront + cutDepth > depth - MIN_MARGIN + 1e-9)
      throw new BuilderPlanError('invalid_geometry', 'A cutout must stay at least 1 in inside the main top. Move it or make it smaller.');
    cuts.push({ min: [c.x, front + fromFront, 0], max: [c.x + c.width, front + fromFront + cutDepth, thickness] });
  }
  const b = new Builder();
  b.add('Countertop', null, 'top', range(0, width), range(0, total), range(0, thickness), '+x', '+y', { cuts });
  if (p.backsplash !== undefined) b.add('Backsplash', null, 'top', range(0, width), range(total - SPLASH_THICKNESS, total), range(thickness, thickness + p.backsplash), '+x', '+z');
  const top: MaterialSpec = p.finish?.library !== undefined ? { library: p.finish.library } : { paint: p.finish?.paint ?? DEFAULT_FINISH };
  return {
    name: p.name ?? 'Countertop', at, parts: b.parts, materials: { top },
    used: { width, depth, thickness, at, backsplash: p.backsplash ?? 0, cutouts: p.cutouts?.length ?? 0, leg: p.leg ? { ...p.leg, depth: legDepth } : null },
  };
}
