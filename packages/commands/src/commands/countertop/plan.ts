// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import type { CutBox } from '../builders/mesh';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec, Pt } from '../builders/parts';

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
  readonly leg?: { readonly side: 'left' | 'right'; readonly length: number; readonly depth?: number | undefined; readonly chamfer?: number | undefined } | undefined;
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
  const front = legLength, chamfer = p.leg?.chamfer ?? 0;
  if (p.leg && chamfer > 0 && (chamfer >= legLength || chamfer >= width - legDepth))
    throw new BuilderPlanError('invalid_geometry', 'The chamfer is larger than the inside corner it angles. Make it smaller.');
  const openings = (p.cutouts ?? []).map(c => {
    const cutDepth = c.depth ?? DEFAULT_CUTOUT_DEPTH, fromFront = c.fromFront ?? DEFAULT_FROM_FRONT;
    if (c.x < MIN_MARGIN - LENGTH_TOL || c.x + c.width > width - MIN_MARGIN + LENGTH_TOL || fromFront < MIN_MARGIN - LENGTH_TOL || fromFront + cutDepth > depth - MIN_MARGIN + LENGTH_TOL)
      throw new BuilderPlanError('invalid_geometry', 'A cutout must stay at least 1 in inside the main top. Move it or make it smaller.');
    return { x0: c.x, x1: c.x + c.width, y0: front + fromFront, y1: front + fromFront + cutDepth };
  });
  const b = new Builder();
  if (p.leg && chamfer > 0) {
    // An angled inside corner, as over a diagonal corner cabinet, cannot be cut from rectangular stock.
    const outline: Pt[] = p.leg.side === 'left'
      ? [[0, 0], [legDepth, 0], [legDepth, front - chamfer], [legDepth + chamfer, front], [width, front], [width, total], [0, total]]
      : [[width - legDepth, 0], [width, 0], [width, total], [0, total], [0, front], [width - legDepth - chamfer, front], [width - legDepth, front - chamfer]];
    b.addOutline('Countertop', 'top', outline, range(0, thickness), false, openings.map(o => [[o.x0, o.y0], [o.x0, o.y1], [o.x1, o.y1], [o.x1, o.y0]]));
  } else {
    const cuts: CutBox[] = [];
    if (p.leg) cuts.push(p.leg.side === 'left'
      ? { min: [legDepth, 0, 0], max: [width, legLength, thickness] }
      : { min: [0, 0, 0], max: [width - legDepth, legLength, thickness] });
    for (const o of openings) cuts.push({ min: [o.x0, o.y0, 0], max: [o.x1, o.y1, thickness] });
    b.add('Countertop', null, 'top', range(0, width), range(0, total), range(0, thickness), '+x', '+y', { cuts });
  }
  if (p.backsplash !== undefined) b.add('Backsplash', null, 'top', range(0, width), range(total - SPLASH_THICKNESS, total), range(thickness, thickness + p.backsplash), '+x', '+z');
  const top: MaterialSpec = p.finish?.library !== undefined ? { library: p.finish.library } : { paint: p.finish?.paint ?? DEFAULT_FINISH };
  return {
    name: p.name ?? 'Countertop', at, parts: b.parts, materials: { top },
    used: { width, depth, thickness, at, backsplash: p.backsplash ?? 0, cutouts: p.cutouts?.length ?? 0, leg: p.leg ? { ...p.leg, depth: legDepth } : null },
  };
}
