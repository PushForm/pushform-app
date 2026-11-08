// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';

export const HARDWARE_SHAPES = [
  'bar-round',
  'bar-square',
  'wire',
  'arch',
  'bridge',
  'cup',
  'cup-square',
  'edge',
  'edge-curved',
  'recessed',
  'recessed-round',
  'ring',
  'knob-round',
  'knob-disk',
  'knob-cylinder',
  'knob-oval',
  'knob-square',
  'knob-pyramid',
  'knob-hex',
  'knob-octagon',
  'knob-ball',
  'knob-t',
  'knob-t-square',
  'half-moon',
  'backplate',
] as const;
export type HardwareShape = (typeof HARDWARE_SHAPES)[number];
/** Lengths are meters. Local XY is the mounting face; +Z projects out from it. */
export interface HardwareOptions {
  shape: HardwareShape;
  length?: number;
  width?: number;
  projection?: number;
  spacing?: number;
  grip?: number;
  wall?: number;
  segments?: number;
}
export interface ResolvedHardwareOptions {
  shape: HardwareShape;
  length: number;
  width: number;
  projection: number;
  spacing: number;
  grip: number;
  wall: number;
  segments: number;
}
export function resolveHardwareOptions(input: HardwareOptions): ResolvedHardwareOptions {
  if (!HARDWARE_SHAPES.includes(input.shape)) throw new Error('Choose a supported hardware shape.');
  const knob = input.shape.startsWith('knob-');
  const pocket = input.shape.startsWith('recessed');
  const o: ResolvedHardwareOptions = {
    shape: input.shape,
    length: input.length ?? (knob ? 0.032 : 0.152),
    width: input.width ?? (knob ? 0.032 : pocket ? 0.04 : 0.012),
    projection: input.projection ?? (knob ? 0.027 : pocket ? 0.012 : 0.032),
    spacing: input.spacing ?? (knob ? 0 : 0.128),
    grip: input.grip ?? 0.01,
    wall: input.wall ?? 0.002,
    segments: input.segments ?? 40,
  };
  for (const key of ['length', 'width', 'projection', 'grip', 'wall'] as const)
    if (!Number.isFinite(o[key]) || o[key] < 0.0005 || o[key] > 2)
      throw new Error(`${key} must be between 0.5 mm and 2 m.`);
  if (!Number.isFinite(o.spacing) || o.spacing < 0 || o.spacing > 2)
    throw new Error('Mounting spacing must be between zero and 2 m.');
  if (!Number.isInteger(o.segments) || o.segments < 16 || o.segments > 80)
    throw new Error('Segments must be an integer from 16 to 80.');
  if (['bar-round', 'bar-square', 'wire', 'arch', 'bridge'].includes(o.shape)) {
    if (o.spacing < o.grip * 2 || o.spacing + o.grip > o.length + LENGTH_TOL)
      throw new Error('Mounting centers and grip must fit inside the overall length.');
    if (o.projection < o.grip * 1.5)
      throw new Error('Projection must leave clearance below the grip.');
  }
  if (
    ['cup', 'cup-square', 'recessed', 'recessed-round', 'edge', 'edge-curved'].includes(o.shape)
  ) {
    if (o.wall * 2 >= Math.min(o.width, o.projection, o.length))
      throw new Error('Wall thickness leaves no usable opening.');
  }
  return o;
}
