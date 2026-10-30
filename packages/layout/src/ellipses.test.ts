// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutEllipse } from './ellipses';
import { flattenLayoutPath } from './path';

it('draws a circle as four smooth Bézier quarters that stay on the circle', () => {
  const shape = createLayoutEllipse([20, 30], 10, 10);
  expect(shape.closed).toBe(true);
  expect(shape.points).toEqual([[30, 30], [20, 40], [10, 30], [20, 20]]);
  expect(shape.handles).toHaveLength(4);
  for (const [i, handle] of shape.handles!.entries()) {
    const anchor = shape.points[i]!;
    // Smooth: both handles lie on one line through the anchor, on opposite sides.
    const [ax, ay] = [handle.in![0] - anchor[0], handle.in![1] - anchor[1]], [bx, by] = [handle.out![0] - anchor[0], handle.out![1] - anchor[1]];
    expect(ax * by - ay * bx).toBeCloseTo(0);
    expect(ax * bx + ay * by).toBeLessThan(0);
  }
  // Four cubic quarters stay within 0.03% of the radius everywhere.
  for (const point of flattenLayoutPath(shape.points, shape.handles, true)) expect(Math.abs(Math.hypot(point[0] - 20, point[1] - 30) - 10)).toBeLessThan(0.003);
});

it('stretches the quarters to the ellipse radii and rejects degenerate ellipses', () => {
  const { points, handles } = createLayoutEllipse([0, 0], 20, 5);
  expect(points).toEqual([[20, 0], [0, 5], [-20, 0], [0, -5]]);
  for (const point of flattenLayoutPath(points, handles, true)) expect(Math.abs(Math.hypot(point[0] / 20, point[1] / 5) - 1)).toBeLessThan(0.0003);
  expect(() => createLayoutEllipse([0, 0], 0, 5)).toThrow();
  expect(() => createLayoutEllipse([0, 0], 5, Number.NaN)).toThrow();
});
