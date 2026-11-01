// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { layoutEntryFields, layoutEntryKind, lockedPoint, pageAngle, type LayoutEntryInput } from './layoutEntry';

const base: LayoutEntryInput = { kind: 'line', anchor: [10, 10], cursor: [40, 10], label: 'Length', locks: {}, mmPerPx: 0.5, formatLength: (mm) => `${mm.toFixed(1)} mm` };

it('takes a line length and angle, box sizes, a radius, or one value by tool', () => {
  expect(layoutEntryKind('line', false, false)).toBe('line');
  expect(layoutEntryKind('rectangle', true, false)).toBe('box');
  expect(layoutEntryKind('circle', false, true)).toBe('radius');
  for (const tool of ['move', 'rotate', 'offset', 'fillet', 'chamfer']) expect(layoutEntryKind(tool, false, false)).toBe('single');
  expect(layoutEntryKind('select', false, false)).toBe('none');
});

it('shows a line Length field on a dimension line beside it and an Angle field on an arc at its start', () => {
  const { fields, segments } = layoutEntryFields({ ...base, cursor: [40, 10] });
  expect(fields.map(f => [f.id, f.value])).toEqual([['length', '30.0 mm'], ['angle', '0.0°']]);
  // Left of a rightward line is up the page, 28 px (14 mm here) away.
  expect(fields[0]!.at).toEqual([25, -4]);
  expect(fields[0]!.away).toEqual([0, -1]);
  expect(segments).toContainEqual([[10, -4], [40, -4]]);
  const down = layoutEntryFields({ ...base, cursor: [10, 40] });
  expect(down.fields[1]!.value).toBe('90.0°');
});

it('measures page angles clockwise from the right, as Rotate does', () => {
  expect(pageAngle([0, 0], [0, 1])).toBe(90);
  expect(pageAngle([0, 0], [-1, 0])).toBe(180);
  expect(pageAngle([0, 0], [0, -1])).toBe(-90);
});

it('puts box Width and Height outside the edges through the first corner', () => {
  const { fields } = layoutEntryFields({ ...base, kind: 'box', anchor: [10, 10], cursor: [70, 40], corners: [[10, 10], [70, 40]] });
  expect(fields.map(f => [f.id, f.value])).toEqual([['width', '60.0 mm'], ['height', '30.0 mm']]);
  expect(fields[0]!.at).toEqual([40, -4]);
  expect(fields[0]!.away).toEqual([0, -1]);
  expect(fields[1]!.at).toEqual([-4, 25]);
  expect(fields[1]!.away).toEqual([-1, 0]);
  // Drawn up and left, the dimensions move to the other sides.
  const flipped = layoutEntryFields({ ...base, kind: 'box', anchor: [70, 40], cursor: [10, 10], corners: [[70, 40], [10, 10]] });
  expect(flipped.fields[0]!.away).toEqual([0, 1]);
  expect(flipped.fields[1]!.away).toEqual([1, 0]);
});

it('puts a radius field past the rim toward the pointer', () => {
  const { fields, segments } = layoutEntryFields({ ...base, kind: 'radius', anchor: [0, 0], cursor: [20, 0] });
  expect(fields).toEqual([{ id: 'radius', label: 'Radius', value: '20.0 mm', at: [28, 0], away: [1, 0] }]);
  expect(segments).toEqual([[[0, 0], [28, 0]]]);
});

it('shows a single value beside the pointer only while the tool has one', () => {
  expect(layoutEntryFields({ ...base, kind: 'single', label: 'Distance' }).fields).toEqual([]);
  expect(layoutEntryFields({ ...base, kind: 'single', label: 'Distance', value: '5 mm' }).fields).toEqual([{ id: 'value', label: 'Distance', value: '5 mm' }]);
});

it('holds the pointer to locked values on its own side of the first corner', () => {
  const at = (p: readonly number[]) => p.map(v => Math.round(v * 1e9) / 1e9);
  expect(at(lockedPoint('line', [0, 0], [3, 4], { length: 10 }))).toEqual([6, 8]);
  expect(at(lockedPoint('line', [0, 0], [3, 4], { angle: 90 }))).toEqual([0, 5]);
  expect(at(lockedPoint('box', [10, 10], [0, 30], { width: 40 }))).toEqual([-30, 30]);
  expect(at(lockedPoint('box', [10, 10], [0, 30], { width: 40, height: 10 }, 2))).toEqual([-10, 15]);
  expect(lockedPoint('box', [10, 10], [0, 30], {})).toEqual([0, 30]);
});

it('shows an arc tool the field for its current step', () => {
  expect(layoutEntryKind('arc', false, false, true)).toBe('arc');
  const arc = (tool: string, points: [number, number][], cursor: [number, number], sweep = 0) =>
    layoutEntryFields({ ...base, kind: 'arc', anchor: null, cursor, arc: { tool, points, sweep } });
  expect(arc('arc', [], [5, 5]).fields).toEqual([]);
  expect(arc('pie', [[0, 0]], [20, 0]).fields.map(f => [f.id, f.value])).toEqual([['radius', '20.0 mm']]);
  const angle = arc('arc', [[0, 0], [20, 0]], [0, 20], Math.PI / 2).fields[0]!;
  expect([angle.id, angle.value]).toEqual(['angle', '90.0°']);
  // On a gray arc at the middle of the sweep, drawn outward.
  expect(angle.away![0]).toBeCloseTo(Math.SQRT1_2); expect(angle.away![1]).toBeCloseTo(Math.SQRT1_2);
  expect(arc('arc2', [[0, 0]], [30, 0]).fields.map(f => [f.id, f.value])).toEqual([['length', '30.0 mm']]);
  const bulge = arc('arc2', [[0, 0], [40, 0]], [20, 10]).fields[0]!;
  expect([bulge.id, bulge.value, bulge.away]).toEqual(['bulge', '10.0 mm', [-0, 1]]);
  expect(arc('arc3', [[0, 0], [10, 10]], [20, 0]).fields).toEqual([]);
});
