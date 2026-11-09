// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { Builder, BuilderPlanError, range } from '../builders/parts';
import type { BuilderPlan, MaterialSpec } from '../builders/parts';
import * as D from './dimensions';
import { addFront, checkFive } from './plan';
import type { CabinetGlassPattern, CabinetGlassType, FrontStyle, GlassSpec } from './plan';

export interface CabinetDoorParams {
  readonly width: number;
  readonly height: number;
  readonly style?: FrontStyle | undefined;
  readonly stileWidth?: number | undefined;
  readonly glass?: { readonly pattern?: CabinetGlassPattern | undefined; readonly across?: number | undefined; readonly down?: number | undefined; readonly type?: CabinetGlassType | undefined } | undefined;
  readonly at?: Vec3 | undefined;
  readonly finish?: { readonly paint?: string | undefined; readonly stain?: string | undefined } | undefined;
  readonly name?: string | undefined;
}

/** One door on its own: a slab, or a frame around a flat, raised or glass panel, face toward -y. */
export function planCabinetDoor(p: CabinetDoorParams): BuilderPlan {
  const style = p.style ?? 'shaker', stile = p.stileWidth ?? D.STILE;
  if (p.glass && style !== 'glass') throw new BuilderPlanError('invalid_operation', 'glass describes a glass door; use style "glass".');
  if (p.finish?.paint !== undefined && p.finish.stain !== undefined) throw new BuilderPlanError('invalid_operation', 'finish takes paint or stain, not both.');
  const pattern = p.glass?.pattern ?? 'single';
  if (pattern !== 'grid' && (p.glass?.across !== undefined || p.glass?.down !== undefined)) throw new BuilderPlanError('invalid_operation', 'across and down need pattern: "grid".');
  checkFive(style, p.width, p.height, 'The door', stile);
  const glass: GlassSpec | null = style !== 'glass' ? null : {
    pattern, type: p.glass?.type ?? 'clear',
    ...(pattern === 'grid' ? { across: p.glass?.across ?? D.DEFAULT_LITES_ACROSS, down: p.glass?.down ?? D.DEFAULT_LITES_DOWN } : {}),
  };
  const b = new Builder(), name = p.name ?? 'Door';
  addFront(b, name, { x: range(0, p.width), z: range(0, p.height) }, 0, style, false, 'Slab', glass, stile);
  const show: MaterialSpec = p.finish?.stain !== undefined ? { library: p.finish.stain } : { paint: p.finish?.paint ?? D.DEFAULT_PAINT };
  return {
    name, at: p.at ?? [0, 0, 0], parts: b.parts,
    materials: { show, ...(glass ? { glass: { library: D.GLASS_KEYS[glass.type] } } : {}) },
    used: { width: p.width, height: p.height, style, stileWidth: stile, ...(glass ? { glass } : {}) },
  };
}
