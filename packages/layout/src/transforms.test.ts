// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { LayoutEntity, LayoutText } from './LayoutDocument';
import { layoutLabelLeader } from './labels';
import { rotateLayoutEntity } from './rotation';
import { rotateLayoutEntities, scaleLayoutEntities } from './transforms';

type Point = [number, number];
const TEXT: LayoutText = { content: 'Note', fontFamily: 'Verdana', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false,
  align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' };
const path = (id: number, points: Point[]): LayoutEntity => ({ id, layerId: 1, kind: 'path', points, closed: false });
const text = (id: number, points: Point[], extra: Partial<LayoutText> = {}): LayoutEntity => ({ id, layerId: 1, kind: 'text', points, closed: false, text: { ...TEXT, ...extra } });
const label = (points: Point[]): LayoutEntity => ({ id: 3, layerId: 1, kind: 'label', points, closed: false,
  text: { ...TEXT, bounded: false, leader: 'elbow', endpoint: 'arrow' } });
const dimension = (alignment: 'aligned' | 'horizontal' | 'vertical' | 'rotated', angleDeg?: number): LayoutEntity => ({
  id: 4, layerId: 1, kind: 'dimension', points: [[0, 0], [10, 0], [5, -5]], closed: false,
  dimension: { alignment, ...(angleDeg === undefined ? {} : { angleDeg }), anchors: [null, null], units: 'mm', precision: 1, showUnits: true, text: '<>',
    fontFamily: 'Verdana', fontSizePt: 10, endpoint: 'arrow', arrowSizeMm: 2, extensionGapMm: 1, extensionOverrunMm: 1.5, cachedValueMm: 10, detached: false },
} as unknown as LayoutEntity);
const close = (actual: readonly Point[], expected: readonly Point[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => { expect(point[0]).toBeCloseTo(expected[i]![0]); expect(point[1]).toBeCloseTo(expected[i]![1]); });
};

describe('rotating objects together', () => {
  it('turns paths and text rigidly about one pivot', () => {
    const [line, box] = rotateLayoutEntities([path(1, [[10, 0], [20, 0]]), text(2, [[0, 10], [10, 20]])], [0, 0], 90);
    close(line!.points, [[0, 10], [0, 20]]);
    // The text box's center turns about the pivot and the box turns with it.
    close(box!.points, [[-20, 0], [-10, 10]]);
    expect(box!.text!.rotationDeg).toBe(90);
  });

  it('turns a label about the pivot with its text upright and its last segment horizontal', () => {
    // Text box from (20, 0) to (40, 10); the leader meets it at (20, 5) from a bend at (15, 5), tip at (10, 20).
    const source = label([[20, 0], [40, 10], [10, 20], [15, 5]]);
    const [turned] = rotateLayoutEntities([source], [0, 0], 90);
    close([turned!.points[2]!, turned!.points[3]!], [[-20, 10], [-5, 15]]);
    expect(turned!.text!.rotationDeg ?? 0).toBe(0);
    const leader = layoutLabelLeader(turned!)!;
    expect(leader.start[1]).toBeCloseTo(leader.bend[1]);
    expect(leader.start[0] - leader.bend[0]).toBeCloseTo(5);
  });

  it('turns horizontal and vertical dimensions into rotated ones, except by quarter turns', () => {
    expect(rotateLayoutEntity(dimension('horizontal'), [0, 0], 30).dimension).toMatchObject({ alignment: 'rotated', angleDeg: 30 });
    expect(rotateLayoutEntity(dimension('vertical'), [0, 0], 30).dimension).toMatchObject({ alignment: 'rotated', angleDeg: 120 });
    expect(rotateLayoutEntity(dimension('horizontal'), [0, 0], 90).dimension!.alignment).toBe('vertical');
    expect(rotateLayoutEntity(dimension('vertical'), [0, 0], -270).dimension!.alignment).toBe('horizontal');
    expect(rotateLayoutEntity(dimension('horizontal'), [0, 0], 180).dimension!.alignment).toBe('horizontal');
    expect(rotateLayoutEntity(dimension('rotated', 170), [0, 0], 20).dimension).toMatchObject({ alignment: 'rotated', angleDeg: 10 });
    expect(rotateLayoutEntity(dimension('aligned'), [0, 0], 30).dimension!.alignment).toBe('aligned');
  });
});

describe('scaling objects together', () => {
  it('scales paths point by point and text boxes by their center and sides, with type by the smaller factor', () => {
    const [line, box] = scaleLayoutEntities([path(1, [[10, 10], [30, 10]]), text(2, [[10, 20], [30, 30]], {
      spans: [{ start: 0, end: 2, bold: true, italic: false, underline: false, fontSizePt: 20 }],
      lineSpacing: { mode: 'exactly', value: 12 }, tabStopsPt: [36] })], [10, 10], 2, 0.5);
    close(line!.points, [[10, 10], [50, 10]]);
    close(box!.points, [[10, 15], [50, 20]]);
    expect(box!.text).toMatchObject({ fontSizePt: 5, lineSpacing: { mode: 'exactly', value: 6 }, tabStopsPt: [18] });
    expect(box!.text!.spans![0]!.fontSizePt).toBe(10);
  });

  it('keeps a rotated text box rotated and stretches each side along its own direction', () => {
    // A box turned a quarter turn: its width runs down the page, so the vertical factor sets it.
    const [box] = scaleLayoutEntities([text(2, [[0, 0], [20, 10]], { rotationDeg: 90 })], [10, 5], 3, 2);
    close(box!.points, [[-10, -10], [30, 20]]);
    expect(box!.text!.rotationDeg).toBe(90);
    expect(box!.text!.fontSizePt).toBe(20);
  });

  it('scales a label point by point, keeping its leader horizontal, and a dimension with its style', () => {
    const [turned, measured] = scaleLayoutEntities([label([[20, 0], [40, 10], [10, 20], [15, 5]]), dimension('rotated', 45)], [0, 0], 2, 1);
    close(turned!.points, [[40, 0], [80, 10], [20, 20], [30, 5]]);
    const leader = layoutLabelLeader(turned!)!;
    expect(leader.start[1]).toBeCloseTo(leader.bend[1]);
    expect(measured!.dimension).toMatchObject({ fontSizePt: 10, arrowSizeMm: 2 });
    expect(measured!.dimension!.angleDeg).toBeCloseTo(Math.atan2(1, 2) * 180 / Math.PI);
  });

  it('refuses factors that are not positive and finite', () => {
    expect(() => scaleLayoutEntities([path(1, [[0, 0], [1, 1]])], [0, 0], 0, 1)).toThrow('positive');
    expect(() => scaleLayoutEntities([path(1, [[0, 0], [1, 1]])], [0, 0], 1, Infinity)).toThrow('positive');
  });
});
