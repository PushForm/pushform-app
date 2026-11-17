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
  'knob-domed',
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
  /** Curved profile divisions for knob-domed, independent of radial divisions. */
  profileSegments?: number;
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
  profileSegments: number;
}
export function resolveHardwareOptions(input: HardwareOptions): ResolvedHardwareOptions {
  if (!HARDWARE_SHAPES.includes(input.shape)) throw new Error('Choose a supported hardware shape.');
  const knob = input.shape.startsWith('knob-');
  const pocket = input.shape.startsWith('recessed');
  const o: ResolvedHardwareOptions = {
    shape: input.shape,
    length:
      input.length ??
      (input.shape === 'wire'
        ? (input.spacing ?? 0.128) + (input.grip ?? 0.01)
        : knob
          ? 0.032
          : 0.152),
    width:
      input.width ??
      (input.shape === 'ring'
        ? 0.05
        : input.shape === 'half-moon'
          ? (input.length ?? 0.152) / 2
          : ['bar-round', 'wire', 'bridge', 'knob-t'].includes(input.shape)
            ? (input.grip ?? 0.01)
            : knob
              ? 0.032
              : pocket
                ? 0.04
                : input.shape.startsWith('cup')
                  ? 0.035
                  : 0.012),
    projection:
      input.projection ??
      (input.shape === 'knob-ball'
        ? (input.width ?? 0.032) * 1.25
        : knob
          ? 0.027
          : pocket
            ? 0.012
            : 0.032),
    spacing: input.spacing ?? (knob ? 0 : 0.128),
    grip: input.grip ?? (input.shape === 'backplate' ? 0.004 : 0.01),
    wall: input.wall ?? 0.002,
    segments: input.segments ?? 40,
    profileSegments: input.profileSegments ?? 20,
  };
  for (const key of ['length', 'width', 'projection', 'grip', 'wall'] as const)
    if (!Number.isFinite(o[key]) || o[key] < 0.0005 || o[key] > 2)
      throw new Error(`${key} must be between 0.5 mm and 2 m.`);
  if (!Number.isFinite(o.spacing) || o.spacing < 0 || o.spacing > 2)
    throw new Error('Mounting spacing must be between zero and 2 m.');
  if (!Number.isInteger(o.segments) || o.segments < 16 || o.segments > 80)
    throw new Error('Segments must be an integer from 16 to 80.');
  if (!Number.isInteger(o.profileSegments) || o.profileSegments < 8 || o.profileSegments > 32)
    throw new Error('Profile segments must be an integer from 8 to 32.');
  if (o.shape === 'knob-domed' && o.grip >= o.width)
    throw new Error('The mounting-base diameter must be smaller than the domed head diameter.');
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
  if (o.shape === 'wire' && Math.abs(o.length - o.spacing - o.grip) > LENGTH_TOL)
    throw new Error('For wire pulls, overall length is mounting spacing plus rod diameter.');
  if (['bar-round', 'wire', 'knob-t'].includes(o.shape) && Math.abs(o.width - o.grip) > LENGTH_TOL)
    throw new Error('Round grip width must equal its diameter.');
  if (o.shape === 'ring' && (o.width <= 2 * o.grip || o.projection < o.grip))
    throw new Error('A ring needs an open center and projection at least its section diameter.');
  if (o.shape === 'knob-ball' && o.projection <= o.width)
    throw new Error('Ball knob projection must exceed the ball diameter to leave a stem.');
  if (o.shape === 'cup-square' && 4 * o.wall >= Math.min(o.length, o.width))
    throw new Error('The rectangular cup rim leaves no pocket.');
  if (o.shape === 'recessed' && 4 * o.wall >= Math.min(o.length, o.width))
    throw new Error('The recessed rim leaves no pocket opening.');
  if (o.shape === 'recessed-round' && 4 * o.wall >= o.width)
    throw new Error('The recessed rim leaves no pocket opening.');
  if (o.shape === 'backplate' && o.grip >= o.width)
    throw new Error('The screw hole must fit inside the backplate.');
  if (['half-moon', 'edge', 'edge-curved'].includes(o.shape) && o.wall >= o.projection)
    throw new Error('The thickness must be smaller than the projection.');
  return o;
}
