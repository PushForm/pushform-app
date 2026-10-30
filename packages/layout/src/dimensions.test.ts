// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { angularPlacementReflex, angularDimensionError, inferLinearDimensionAlignment, angularDimensionGeometry, angularMeasurement, createAngularDimension, createLinearDimension, formatAngularDimension, formatLayoutLength, formatLinearDimension, layoutDimensionScaleLabel, layoutLengthPrecisionLabel, LAYOUT_DIMENSION_SCALES, previewLayoutDimension, resolveLayoutDimension } from './dimensions';
import { angularRaysFromPoints } from './angularEdges';
import { linearDimensionGeometry, linearMeasurement, normalizeDimensionAngle } from './dimensions';
import { rotateLayoutEntity } from './rotation';
import type { LayoutEntity } from './LayoutDocument';
it('computes small and reflex arcs across the angle wrap boundary', () => {
  const vertex: [number, number] = [0, 0];
  expect(angularMeasurement(vertex, [1, 0], [0, 1])).toBeCloseTo(90);
  expect(angularMeasurement(vertex, [1, 0], [-1, 0])).toBeCloseTo(180);
  expect(angularMeasurement(vertex, [0, 0], [0, 1])).toBeNull();
  const dim = createAngularDimension();
  const entity: LayoutEntity = { id: 1, kind: 'angular-dimension', layerId: 1, closed: false,
    points: [vertex, [-1, 0.1], [-1, -0.1], [-5, 0]], angularDimension: dim };
  expect(angularDimensionGeometry(entity).sweep).toBeGreaterThan(0);
  expect(angularDimensionGeometry(entity).sweep).toBeLessThan(Math.PI / 4);
  dim.reflex = true;
  expect(angularDimensionGeometry(entity).sweep).toBeLessThan(-Math.PI);
  dim.cachedAngleDeg = 90; dim.units = 'radians'; dim.precision = 3;
  expect(formatAngularDimension(dim)).toBe('1.571 rad');
});

it('gently captures dimensions within three degrees of either axis in every direction', () => {
  for (const signX of [-1, 1]) for (const signY of [-1, 1]) {
    expect(inferLinearDimensionAlignment([30, 40], [30 + signX * 100, 40 + signY * 4])).toBe('horizontal');
    expect(inferLinearDimensionAlignment([30, 40], [30 + signX * 4, 40 + signY * 100])).toBe('vertical');
    expect(inferLinearDimensionAlignment([30, 40], [30 + signX * 100, 40 + signY * 6])).toBe('aligned');
    expect(inferLinearDimensionAlignment([30, 40], [30 + signX * 6, 40 + signY * 100])).toBe('aligned');
  }
  expect(inferLinearDimensionAlignment([10, 10], [10, 10])).toBe('aligned');
});

it.each([1, 30, 90, 150, 180])('keeps %s degree measurement, arc sweep, and reflex label consistent in either ray order', degrees => {
  const vertex: [number, number] = [50, 60];
  const at = (angle: number, length: number): [number, number] => [vertex[0] + length * Math.cos(angle * Math.PI / 180), vertex[1] + length * Math.sin(angle * Math.PI / 180)];
  for (const sign of [-1, 1]) for (const reflex of [false, true]) {
    const first = at(179, 100), second = at(179 + degrees * sign, 15);
    const expected = reflex ? 360 - degrees : degrees;
    expect(angularMeasurement(vertex, first, second, reflex)).toBeCloseTo(expected, 8);
    const dim = { ...createAngularDimension(), reflex, cachedAngleDeg: expected };
    const entity: LayoutEntity = { id: 1, layerId: 1, kind: 'angular-dimension', closed: false,
      points: [vertex, first, second, [90, 60]], angularDimension: dim };
    const geometry = angularDimensionGeometry(entity);
    expect(Math.abs(geometry.sweep) * 180 / Math.PI).toBeCloseTo(expected, 8);
    expect(geometry.radius).toBeCloseTo(40);
    expect(Math.hypot(geometry.start[0] - 50, geometry.start[1] - 60)).toBeCloseTo(40);
    expect(angularDimensionError(entity.points)).toBeNull();
  }
});

it('validates draft stages, small angles, finite values, and near-vertex arc placement', () => {
  expect(angularMeasurement([0, 0], [100, 0], [100, 0.00001])).toBeGreaterThan(0);
  expect(angularMeasurement([0, 0], [Infinity, 0], [0, 1])).toBeNull();
  expect(angularDimensionError([[0, 0], [0, 0]])).toContain('first ray');
  expect(angularDimensionError([[0, 0], [1, 0], [2, 0]])).toContain('distinct rays');
  expect(angularDimensionError([[0, 0], [1, 0], [-1, 0], [0, 0.5]])).toBeNull();
  expect(angularDimensionError([[0, 0], [1, 0], [0, 1], [0.1, 0.1]])).toContain('0.5 mm');
});

it('chooses the sweep containing the placement point in either ray order, across the seam, and on the ray boundaries', () => {
  const at = (angle: number): [number, number] => [20 + 30 * Math.cos(angle * Math.PI / 180), 40 + 30 * Math.sin(angle * Math.PI / 180)];
  for (const start of [-179, -90, 0, 90, 179]) for (const order of [-1, 1]) {
    const first = at(start), second = at(start + order * 60);
    expect(angularPlacementReflex([20, 40], first, second, at(start + order * 30))).toBe(false);
    expect(angularPlacementReflex([20, 40], first, second, at(start - order * 30))).toBe(true);
    expect(angularPlacementReflex([20, 40], first, second, first)).toBe(false);
    expect(angularPlacementReflex([20, 40], first, second, second)).toBe(false);
  }
  expect(angularPlacementReflex([0, 0], [1, 0], [-1, 0], [0, 1])).toBe(false);
  expect(angularPlacementReflex([0, 0], [1, 0], [-1, 0], [0, -1])).toBe(true);
});

it('previews associated dimensions against looked-up source geometry without touching the stored entity', () => {
  const source: LayoutEntity = { id: 7, kind: 'path', layerId: 1, closed: false, points: [[10, 10], [110, 10]] };
  const anchor = (pointIndex: number) => ({ entityId: 7, pointIndex, pointCount: 2 });
  const linear: LayoutEntity = { id: 8, kind: 'dimension', layerId: 1, closed: false, points: [[10, 10], [110, 10], [60, 25]],
    dimension: { ...createLinearDimension(), anchors: [anchor(0), anchor(1)], cachedValueMm: 100, detached: true } };
  const dragged: LayoutEntity = { ...source, points: [[10, 10], [160, 10]] };
  const preview = previewLayoutDimension(linear, () => dragged);
  expect(preview.points).toEqual([[10, 10], [160, 10], [60, 25]]);
  expect(preview.dimension).toMatchObject({ cachedValueMm: 150, detached: false });
  expect(linear.points[1]).toEqual([110, 10]);
  expect(linear.dimension!.cachedValueMm).toBe(100);
  // A missing or re-vertexed source leaves the dimension exactly as stored.
  expect(previewLayoutDimension(linear, () => undefined)).toBe(linear);
  expect(previewLayoutDimension(linear, () => ({ ...dragged, points: [[0, 0], [1, 1], [2, 2]] }))).toBe(linear);
  expect(resolveLayoutDimension(linear, () => dragged)).toEqual({ points: [[10, 10], [160, 10]], value: 150 });

  const corner: LayoutEntity = { id: 9, kind: 'path', layerId: 1, closed: false, points: [[0, 20], [0, 0], [20, 0]] };
  const edge = (segmentIndex: number, direction: 1 | -1 = 1) => ({ entityId: 9, segmentIndex, pointCount: 3, direction });
  const angular: LayoutEntity = { id: 10, kind: 'angular-dimension', layerId: 1, closed: false, points: [[0, 0], [0, 20], [20, 0], [5, 5]],
    angularDimension: { ...createAngularDimension(), edgeAnchors: [edge(0, -1), edge(1)], cachedAngleDeg: 90 } };
  const sheared = previewLayoutDimension(angular, () => ({ ...corner, points: [[20, 20], [0, 0], [20, 0]] }));
  expect(sheared.angularDimension!.cachedAngleDeg).toBeCloseTo(45);
  expect(sheared.points[0]).toEqual([0, 0]);
  expect(sheared.points[3]).toEqual([5, 5]);
  // Collapsing the rays onto one line keeps the last valid preview.
  expect(previewLayoutDimension(angular, () => ({ ...corner, points: [[-20, 0], [0, 0], [20, 0]] }))).toBe(angular);
});

it('intersects four-point rays independently of point-pair length, order, and translated origins', () => {
  for (const offset of [0, 100]) {
    const forward = angularRaysFromPoints([[offset + 20, 40], [offset + 80, 40], [offset + 100, 60], [offset + 100, 100]]);
    expect(forward[0]).toEqual([offset + 100, 40]);
    expect(angularMeasurement(...forward)).toBeCloseTo(90);
    const reverse = angularRaysFromPoints([[offset + 80, 40], [offset + 20, 40], [offset + 100, 60], [offset + 120, 80]]);
    expect(reverse[0]).toEqual([offset + 80, 40]);
    expect(angularMeasurement(...reverse)).toBeCloseTo(135);
  }
  expect(() => angularRaysFromPoints([[0, 0], [0, 0], [0, 10], [10, 10]])).toThrow('different points');
  expect(() => angularRaysFromPoints([[0, 0], [10, 0], [0, 10], [10, 10]])).toThrow('nonparallel');
  expect(() => angularRaysFromPoints([[0, 0], [10, 0], [20, 0], [30, 0]])).toThrow('nonparallel');
  expect(() => angularRaysFromPoints([[0, 0], [Infinity, 0], [0, 0], [0, 10]])).toThrow('finite');
});

it('chooses the same farthest endpoints for every ray and endpoint ordering, including a straddled vertex', () => {
  const fixtures: [number, number][][] = [
    [[20, 40], [80, 40], [100, 60], [100, 100]],
    [[-60, 0], [20, 0], [0, -10], [0, 40]],
    [[-20, 0], [20, 0], [0, -20], [0, 20]], // Equal distances have a stable side as well.
  ];
  for (const fixture of fixtures) {
    const reference = angularRaysFromPoints(fixture);
    for (let order = 0; order < 8; order++) {
      const first = fixture.slice(0, 2), second = fixture.slice(2);
      if (order & 1) first.reverse();
      if (order & 2) second.reverse();
      const result = angularRaysFromPoints((order & 4 ? [second, first] : [first, second]).flat());
      expect(result[0]).toEqual(reference[0]);
      expect(result.slice(1)).toEqual(order & 4 ? [reference[2], reference[1]] : reference.slice(1));
    }
  }
});

// Expected strings are what LayOut 2027 rendered for the same settings through its Ruby API.
it.each([
  ['architectural', 4, true, true, 0, '0"'], ['architectural', 1, true, true, 0.5, '1/2"'],
  ['architectural', 4, true, true, 11.5625, '11 9/16"'], ['architectural', 4, true, true, 12, `1'-0"`],
  ['architectural', 4, true, true, 12.03125, `1'-1/16"`], ['architectural', 2, true, true, 60.5, `5'-1/2"`],
  ['architectural', 0, true, true, 18.96875, `1'-7"`], ['architectural', 4, false, true, 12, `1'`],
  ['architectural', 0, false, false, 120, `10'`], ['architectural', 4, false, true, 12.25, `1'-1/4"`],
  ['architectural', 1, true, false, 24, `2' 0"`], ['architectural', 2, true, false, 60.5, `5' 1/2"`],
  ['fractional', 0, true, true, 2.5, '3"'], ['fractional', 2, true, true, 0.75, '3/4"'],
  ['fractional', 2, true, true, 35.25, '35-1/4"'], ['fractional', 2, false, true, 1.5, '1-1/2'],
  ['fractional', 1, true, false, 11.5625, '11 1/2"'],
  ['engineering', 0, true, true, 18.96875, `1'`], ['engineering', 1, true, true, 0.5, `0'`],
  ['engineering', 1, true, true, 24, `2'`], ['engineering', 1, false, true, 35.25, `2.9'`],
  ['engineering', 3, true, true, 3.0001, `0.250'`],
] as const)('formats %s at precision %s (units %s, dashes %s): %s" reads as LayOut shows it', (format, precision, showUnits, showDashes, inches, expected) => {
  expect(formatLayoutLength(inches, { format, units: 'inch', precision, showUnits, showDashes })).toBe(expected);
});

it.each([
  ['inch', 2, true, 24, '24.00"'], ['inch', 2, false, 24, '24.00'], ['ft', 2, true, 60.5, `5.04'`],
  ['mm', 1, true, 1, '25.4 mm'], ['mm', 1, false, 1, '25.4'], ['cm', 2, true, 3.0001, '7.62 cm'],
  ['m', 2, true, 47.9999, '1.22 m'], ['pt', 0, true, 1, '72 pt'], ['pt', 3, true, 1.13, '81.4 pt'],
] as const)('formats decimal %s at %s places (units %s): %s" reads as LayOut shows it', (units, precision, showUnits, inches, expected) => {
  expect(formatLayoutLength(inches, { units, precision, showUnits })).toBe(expected);
  expect(formatLayoutLength(inches, { format: 'decimal', units, precision, showUnits })).toBe(expected);
});

it('rounds exact halves up even after millimeter conversion leaves them a hair below', () => {
  // 1.5" stored as 38.1 mm reads back as 1.4999999999999998".
  const dim = { ...createLinearDimension(), units: 'inch' as const, precision: 0, cachedValueMm: 1.5 * 25.4 };
  expect(formatLinearDimension(dim)).toBe('2"');
  expect(formatLinearDimension({ ...dim, format: 'fractional', precision: 3, cachedValueMm: 1.0625 * 25.4 })).toBe('1-1/8"');
  expect(formatLinearDimension({ ...dim, units: 'mm', precision: 1, cachedValueMm: 0.25 })).toBe('0.3 mm');
});

it('divides the measured paper length by the drawing scale and names common scales', () => {
  const dim = { ...createLinearDimension(), cachedValueMm: 20, precision: 0 };
  expect(formatLinearDimension(dim)).toBe('20 mm');
  expect(formatLinearDimension({ ...dim, scale: 1 / 50 })).toBe('1000 mm');
  expect(formatLinearDimension({ ...dim, units: 'inch', format: 'architectural', precision: 4, scale: 1 / 48, cachedValueMm: 25.4 })).toBe(`4'-0"`);
  expect(formatLinearDimension({ ...dim, text: 'Span <> typ.', scale: 2 })).toBe('Span 10 mm typ.');
  expect(layoutDimensionScaleLabel(1)).toBe('1:1');
  expect(layoutDimensionScaleLabel(0.02)).toBe('1:50');
  expect(layoutDimensionScaleLabel(0.020833333312947133)).toBe(`1/4" = 1'-0"`);
  expect(layoutDimensionScaleLabel(1 / 75)).toBe('1:75');
  expect(layoutDimensionScaleLabel(0.02206775125744883)).toBe('1:45.315');
  expect(layoutDimensionScaleLabel(2)).toBe('2:1');
  expect(LAYOUT_DIMENSION_SCALES.map(entry => entry.label)).toContain(`3" = 1'-0"`);
});

it('labels precision as the smallest step shown', () => {
  expect([0, 2, 6].map(precision => layoutLengthPrecisionLabel(undefined, precision))).toEqual(['0', '0.00', '0.000000']);
  expect([0, 1, 6].map(precision => layoutLengthPrecisionLabel('architectural', precision))).toEqual(['1"', '1/2"', '1/64"']);
  expect(layoutLengthPrecisionLabel('engineering', 3)).toBe('0.000');
});

it('measures and draws a rotated dimension along its own angle', () => {
  const dimension = { ...createLinearDimension(), alignment: 'rotated' as const, angleDeg: 30 };
  // A 2 x 1 separation measured along 30 degrees.
  expect(linearMeasurement([0, 0], [20, 10], 'rotated', 30)).toBeCloseTo(20 * Math.cos(Math.PI / 6) + 10 * Math.sin(Math.PI / 6));
  const entity: LayoutEntity = { id: 1, kind: 'dimension', layerId: 1, points: [[0, 0], [20, 10], [0, -10]], closed: false, dimension };
  const { start, end, normal } = linearDimensionGeometry(entity);
  // The line passes through the placement point at 30 degrees, and the endpoints are the measured points projected onto it.
  const u: [number, number] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  for (const point of [start, end]) expect((point[0] - 0) * -u[1] + (point[1] + 10) * u[0]).toBeCloseTo(0);
  expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeCloseTo(linearMeasurement([0, 0], [20, 10], 'rotated', 30));
  expect(normal[0] * u[0] + normal[1] * u[1]).toBeCloseTo(0);
  expect(resolveLayoutDimension(entity, () => undefined)!.value).toBeCloseTo(linearMeasurement([0, 0], [20, 10], 'rotated', 30));
  // A line has no head: angles are kept in [0, 180).
  expect([190, -10, 180, 0, 359.5].map(normalizeDimensionAngle)).toEqual([10, 170, 0, 0, 179.5]);
  // Rotating the dimension turns its line with it.
  expect(rotateLayoutEntity(entity, [0, 0], 160).dimension!.angleDeg).toBeCloseTo(10);
});
