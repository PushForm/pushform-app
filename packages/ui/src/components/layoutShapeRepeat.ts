// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPathHandle, LayoutRectangleKind } from '@pushform/layout';

type Point = [number, number];

/**
 * The last shape a drawing tool made, as the command that drew it, so a double-click can draw it again.
 * `anchor` is the shape's first placement point: a rectangle's first corner (its center when drawn from the center),
 * a circle's or polygon's center, an ellipse's first corner.
 */
export type LayoutShapeRepeat =
  | { anchor: Point; rectangle: { kind: LayoutRectangleKind; first: Point; second: Point; amountMm: number } }
  | { anchor: Point; shape: { points: Point[]; handles?: LayoutPathHandle[]; closed: boolean } };

/** The command and parameters that draw the repeated shape with its first placement point at `at`. */
export function repeatLayoutShape(repeat: LayoutShapeRepeat, pageId: number, at: Point):
  { id: 'layout.rectangle.add' | 'layout.shape.add'; params: Record<string, unknown> } {
  const dx = at[0] - repeat.anchor[0], dy = at[1] - repeat.anchor[1];
  const move = (p: Point): Point => [p[0] + dx, p[1] + dy];
  if ('rectangle' in repeat) {
    const { kind, first, second, amountMm } = repeat.rectangle;
    return { id: 'layout.rectangle.add', params: { pageId, kind, first: move(first), second: move(second), amountMm } };
  }
  const { points, handles, closed } = repeat.shape;
  return { id: 'layout.shape.add', params: { pageId, points: points.map(move), closed,
    ...(handles ? { handles: handles.map((handle) => ({ ...(handle.in ? { in: move(handle.in) } : {}),
      ...(handle.out ? { out: move(handle.out) } : {}) })) } : {}) } };
}
