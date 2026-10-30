// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { layoutRotationAngle, snapLayoutRotationAngle, rotateLayoutPath } from './rotation';

it('measures signed angles relative to arbitrary reference directions and unwraps beyond 180 degrees', () => {
  expect(layoutRotationAngle([20, 30], [30, 40], [10, 40])).toBeCloseTo(90);
  expect(layoutRotationAngle([20, 30], [30, 40], [30, 20])).toBeCloseTo(-90);
  expect(layoutRotationAngle([0, 0], [10, 0], [0, -10], 180)).toBeCloseTo(270);
  expect(layoutRotationAngle([0, 0], [10, 0], [0, 10], -180)).toBeCloseTo(-270);
  expect(() => layoutRotationAngle([0, 0], [0, 0], [10, 0])).toThrow('away');
  expect(() => layoutRotationAngle([0, 0], [10, 0], [0, 0])).toThrow('away');
  expect(() => layoutRotationAngle([0, 0], [NaN, 0], [10, 0])).toThrow('finite');
});

it('rotates native anchors and controls around the pivot without changing the source', () => {
  const source = { points: [[10, 10], [20, 10], [20, 20]] as [number, number][],
    handles: [{ out: [15, 10] as [number, number] }, { in: [20, 5] as [number, number] }, {}], closed: false };
  const before = structuredClone(source), rotated = rotateLayoutPath(source, [10, 10], 90);
  expect(rotated.points).toEqual([[10, 10], [10, 20], [0, 20]]);
  expect(rotated.handles![0]!.out).toEqual([10, 15]);
  expect(rotated.handles![1]!.in).toEqual([15, 20]);
  expect(rotated.closed).toBe(false); expect(source).toEqual(before);
  expect(rotateLayoutPath(source, [10, 10], 450)).toEqual(rotated);
  expect(() => rotateLayoutPath(source, [0, 0], Infinity)).toThrow('finite');
});

it('holds pointer angles at 90-degree detents near them and keeps every other angle', () => {
  // 50 mm from the pivot with a 2 mm tolerance, the detent spans about ±2.3°.
  const snap = (angle: number): number => snapLayoutRotationAngle(angle, 50, 2);
  for (const quarter of [-720, -450, -360, -270, -180, -90, 0, 90, 180, 270, 360, 450, 720]) {
    for (const offset of [-2.2, -1, 0, 1, 2.2]) expect(snap(quarter + offset)).toBe(quarter);
    for (const offset of [-44.9, -30, -2.4, 2.4, 30, 44.9]) expect(snap(quarter + offset)).toBeCloseTo(quarter + offset);
  }
  expect(snap(-1)).toBe(0);
  expect(snap(37.5)).toBe(37.5);
  // Farther from the pivot the same tolerance is a smaller angle.
  expect(snapLayoutRotationAngle(91, 50, 2)).toBe(90);
  expect(snapLayoutRotationAngle(91, 200, 2)).toBe(91);
  expect(() => snap(Infinity)).toThrow('finite');
  expect(() => snap(NaN)).toThrow('finite');
});
