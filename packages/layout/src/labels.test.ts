// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutLabelGeometry, layoutLabelLeader, moveLayoutLabel, labelAnchorAt, previewLayoutLabel } from './labels';
import { createLayoutDocumentState, type LayoutEntity, type LayoutText } from './LayoutDocument';

const text: LayoutText = { content: 'Label', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false,
  italic: false, underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' };
it('places text on either side, centered on the chosen horizontal leader, independent of final pointer height', () => {
  const right = createLayoutLabelGeometry([10, 10], [30, 30], [60, 100]);
  expect(right).toEqual({ points: [[60, 20], [110, 40], [10, 10], [30, 30]], align: 'left', vertical: 'middle' });
  const left = createLayoutLabelGeometry([100, 10], [80, 30], [60, -100]);
  expect(left).toEqual({ points: [[10, 20], [60, 40], [100, 10], [80, 30]], align: 'right', vertical: 'middle' });
  for (const geometry of [right, left]) {
    const entity: LayoutEntity = { id: 3, kind: 'label', layerId: 1, points: geometry.points, closed: false, text };
    const leader = layoutLabelLeader(entity)!;
    expect(leader.bend).toEqual(geometry.points[3]);
    expect(leader.start).toEqual([60, 30]);
  }
});
it('retains legacy automatic elbows and rejects degenerate placement', () => {
  const entity: LayoutEntity = { id: 3, kind: 'label', layerId: 1, points: [[10, 10], [60, 30], [0, 0]], closed: false, text };
  expect(layoutLabelLeader(entity)).toEqual({ tip: [0, 0], bend: [5, 20], start: [10, 20] });
  expect(() => createLayoutLabelGeometry([10, 10], [10, 10], [30, 20])).toThrow('bend');
  expect(() => createLayoutLabelGeometry([10, 10], [30, 30], [30, 80])).toThrow('left or right');
});

it('meets the text at its leader offset below the box center', () => {
  const entity: LayoutEntity = { id: 3, kind: 'label', layerId: 1, points: [[60, 20], [110, 40], [10, 10], [30, 36]], closed: false,
    text: { ...text, vertical: 'bottom', leaderOffsetMm: 6 } };
  expect(layoutLabelLeader(entity)).toEqual({ tip: [10, 10], bend: [30, 36], start: [60, 36] });
  // Moving the text keeps the leader on the same line of text.
  expect(layoutLabelLeader(moveLayoutLabel(entity, [5, 10], 'text'))).toEqual({ tip: [10, 10], bend: [30, 46], start: [65, 46] });
  const legacy = { ...entity, points: entity.points.slice(0, 3) };
  expect(layoutLabelLeader(legacy)).toEqual({ tip: [10, 10], bend: [55, 36], start: [60, 36] });
});

it('uses text and leader drag geometry for unattached and legacy labels without mutating the original', () => {
  const source: LayoutEntity = { id: 3, kind: 'label', layerId: 1, points: [[60, 20], [110, 40], [10, 10], [30, 30]], closed: false, text };
  expect(moveLayoutLabel(source, [10, 20], 'text').points).toEqual([[70, 40], [120, 60], [10, 10], [30, 50]]);
  expect(moveLayoutLabel(source, [10, 20], 'leader').points).toEqual([[70, 40], [120, 60], [20, 30], [40, 50]]);
  const legacy = { ...source, points: source.points.slice(0, 3) };
  expect(layoutLabelLeader(moveLayoutLabel(legacy, [10, 20], 'text'))).toEqual({ tip: [10, 10], bend: [55, 50], start: [70, 50] });
  expect(source.points).toEqual([[60, 20], [110, 40], [10, 10], [30, 30]]);
});

it('attaches only to visible vertices and resolves rotated text corners in previews', () => {
  const state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  const source: LayoutEntity = { id: 3, kind: 'text', layerId: 1, points: [[20, 20], [40, 40]], closed: false, text: { ...text, rotationDeg: 90 } };
  page.entities.set(3, source); page.entityOrder.push(3);
  expect(labelAnchorAt([40, 20], page, state)).toEqual({ entityId: 3, pointIndex: 0, pointCount: 4 });
  expect(labelAnchorAt([30, 20], page, state)).toBeNull();
  const label: LayoutEntity = { id: 4, kind: 'label', layerId: 1, points: [[60, 20], [110, 40], [40, 20], [50, 30]], closed: false, text,
    labelAnchor: { entityId: 3, pointIndex: 0, pointCount: 4 } };
  const preview = previewLayoutLabel(label, () => ({ ...source, points: [[30, 30], [50, 50]] }));
  expect(preview.points[2]).toEqual([50, 30]); expect(label.points[2]).toEqual([40, 20]);
  state.layers.get(1)!.visible = false;
  expect(labelAnchorAt([40, 20], page, state)).toBeNull();
});
