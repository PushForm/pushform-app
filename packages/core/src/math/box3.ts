// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3, MVec3 } from './vec3';

export interface Box3 {
  readonly min: Vec3;
  readonly max: Vec3;
}
export function box3Empty(): { min: MVec3; max: MVec3 } {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
export function box3IsEmpty(b: Box3): boolean {
  return b.min[0] > b.max[0];
}
export function box3Expand(b: { min: MVec3; max: MVec3 }, p: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (p[i]! < b.min[i]!) b.min[i] = p[i]!;
    if (p[i]! > b.max[i]!) b.max[i] = p[i]!;
  }
}
export function box3Union(a: Box3, b: Box3): { min: MVec3; max: MVec3 } {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}
export function box3Center(b: Box3): MVec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}
export function box3Size(b: Box3): MVec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}
export function box3FromPositions(pos: ArrayLike<number>): { min: MVec3; max: MVec3 } {
  const b = box3Empty();
  for (let i = 0; i + 2 < pos.length; i += 3) box3Expand(b, [pos[i]!, pos[i + 1]!, pos[i + 2]!]);
  return b;
}
