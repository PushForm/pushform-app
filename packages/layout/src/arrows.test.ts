// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { LAYOUT_ARROW_FILE_CODES, LAYOUT_ARROW_TYPES, layoutArrowFromFile, layoutArrowShapes, layoutPathArrows } from './index';

const unit = 9 * 25.4 / 72;

describe('arrows', () => {
  it('reads every LayOut arrow code and none for the codes that are not arrows', () => {
    for (const type of LAYOUT_ARROW_TYPES) expect(layoutArrowFromFile(LAYOUT_ARROW_FILE_CODES[type], 6)).toEqual({ type, sizePt: 6 });
    expect(new Set(Object.values(LAYOUT_ARROW_FILE_CODES)).size).toBe(LAYOUT_ARROW_TYPES.length);
    for (const code of [0, 15, 16, 99]) expect(layoutArrowFromFile(code, 4)).toBeNull();
    // LayOut draws a zero-size arrow as nothing.
    expect(layoutArrowFromFile(5, 0)).toBeNull();
  });

  it('draws a triangle 3 units long and 2 wide with its point at the line end', () => {
    const { shapes, back } = layoutArrowShapes({ type: 'filled-triangle', sizePt: 9 }, [0, 0], [10, 0]);
    expect(shapes).toEqual([{ points: [[0, 0], [3 * unit, unit], [3 * unit, -unit]], closed: true, filled: true }]);
    expect(back).toBeCloseTo(3 * unit);
  });

  it('stops a straight line behind an open arrowhead but not behind a filled one, a curve, or a closed shape', () => {
    const line: [number, number][] = [[0, 0], [20, 0]];
    const open = layoutPathArrows(line, undefined, false, { startArrow: { type: 'open-triangle', sizePt: 9 }, endArrow: { type: 'filled-circle', sizePt: 9 } });
    expect(open.points[0]![0]).toBeCloseTo(3 * unit);
    expect(open.points[1]).toEqual([20, 0]);
    expect(open.shapes).toHaveLength(2);
    // The input is not changed.
    expect(line[0]).toEqual([0, 0]);
    const curved = layoutPathArrows(line, [{ out: [5, 5] }, {}], false, { startArrow: { type: 'open-triangle', sizePt: 9 } });
    expect(curved.points[0]).toEqual([0, 0]);
    // The arrow points along the curve's handle.
    expect(curved.shapes[0]!.points[1]![1]).toBeGreaterThan(0);
    expect(layoutPathArrows([[0, 0], [20, 0], [10, 10]], undefined, true, { startArrow: { type: 'open-triangle', sizePt: 9 } }).shapes).toEqual([]);
    // A segment no longer than the arrowhead keeps its end.
    expect(layoutPathArrows([[0, 0], [2, 0]], undefined, false, { endArrow: { type: 'open-diamond', sizePt: 9 } }).points[1]).toEqual([2, 0]);
  });

  it('points each arrow away from its line', () => {
    const { shapes } = layoutPathArrows([[0, 0], [20, 0]], undefined, false, { startArrow: { type: 'filled-triangle', sizePt: 9 }, endArrow: { type: 'filled-triangle', sizePt: 9 } });
    expect(shapes[0]!.points[0]).toEqual([0, 0]); expect(shapes[0]!.points[1]![0]).toBeGreaterThan(0);
    expect(shapes[1]!.points[0]).toEqual([20, 0]); expect(shapes[1]!.points[1]![0]).toBeLessThan(20);
  });
});
