// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export type Vec2 = readonly [number, number];
export type MVec2 = [number, number];

export const v2 = (x: number, y: number): MVec2 => [x, y];
export const v2add = (a: Vec2, b: Vec2): MVec2 => [a[0] + b[0], a[1] + b[1]];
export const v2sub = (a: Vec2, b: Vec2): MVec2 => [a[0] - b[0], a[1] - b[1]];
export const v2scale = (a: Vec2, s: number): MVec2 => [a[0] * s, a[1] * s];
export const v2dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
/** 2D cross product (z component). */
export const v2cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const v2len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const v2dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const v2normalize = (a: Vec2): MVec2 => {
  const l = v2len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};
export const v2perp = (a: Vec2): MVec2 => [-a[1], a[0]];
export const v2lerp = (a: Vec2, b: Vec2, t: number): MVec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
export const v2eq = (a: Vec2, b: Vec2, tol = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
