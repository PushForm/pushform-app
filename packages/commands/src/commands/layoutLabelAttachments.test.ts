// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, createLayoutLabelGeometry, layoutLabelLeader, layoutTextCenter, rotateLayoutPoint } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [40, 20]] }) as number;
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label',
    points: createLayoutLabelGeometry([20, 20], [60, 40], [95, 40]).points,
    labelAnchor: { entityId: sourceId, pointIndex: 0, pointCount: 2 },
    text: { content: 'Attached', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
      underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  const label = () => doc.state.pages.get(pageId)!.entities.get(labelId)!;
  return { doc, commands, pageId, sourceId, labelId, label };
}

it('follows source translation, rotation and same-topology vertex edits without moving label text or bend', () => {
  const { commands, pageId, sourceId, label } = setup();
  const bounds = label().points.slice(0, 2), bend = label().points[3];
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [10, 5] });
  expect(label().points[2]).toEqual([30, 25]);
  commands.execute('layout.shape.rotate', { pageId, entityId: sourceId, pivot: [0, 0], angleDeg: 90 });
  expect(label().points[2]![0]).toBeCloseTo(-25); expect(label().points[2]![1]).toBeCloseTo(30);
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[15, 10], [50, 25]] });
  expect(label().points[2]).toEqual([15, 10]);
  expect(label().points.slice(0, 2)).toEqual(bounds); expect(label().points[3]).toEqual(bend);
  commands.execute('edit.undo'); expect(label().points[2]![0]).toBeCloseTo(-25);
});

it('stretches the horizontal and diagonal segments when dragging text while keeping its tip attached', () => {
  const { commands, pageId, labelId, label } = setup();
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'text', delta: [15, 10] });
  expect(label().points).toEqual([[110, 40], [160, 60], [20, 20], [60, 50]]);
  expect(label().labelAnchor).toBeDefined();
  expect(layoutLabelLeader(label())).toEqual({ tip: [20, 20], bend: [60, 50], start: [110, 50] });
  commands.execute('edit.undo'); expect(label().points).toEqual([[95, 30], [145, 50], [20, 20], [60, 40]]);
  commands.execute('edit.redo'); expect(label().points[3]).toEqual([60, 50]);
});

it('detaches and translates the entire label when dragging its arrow, then treats text and leader drags separately', () => {
  const { commands, pageId, labelId, sourceId, label } = setup();
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'tip', delta: [10, 15] });
  expect(label().labelAnchor).toBeUndefined();
  expect(label().points).toEqual([[105, 45], [155, 65], [30, 35], [70, 55]]);
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [100, 100] });
  expect(label().points[2]).toEqual([30, 35]);
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'text', delta: [10, 0] });
  expect(label().points).toEqual([[115, 45], [165, 65], [30, 35], [70, 55]]);
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'text', delta: [0, 20] });
  expect(label().points).toEqual([[115, 65], [165, 85], [30, 35], [70, 75]]);
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'leader', delta: [10, 10] });
  expect(label().points).toEqual([[125, 75], [175, 95], [40, 45], [80, 85]]);
});

it('restores the attachment in the same undo step as undoing an arrow drag', () => {
  const { commands, pageId, labelId, label } = setup();
  const original = label();
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'tip', delta: [10, 15] });
  commands.execute('edit.undo'); expect(label()).toEqual(original);
  commands.execute('edit.redo'); expect(label().labelAnchor).toBeUndefined();
});

it('keeps a rotated label connected on paper when its text or source moves', () => {
  const { commands, pageId, sourceId, labelId, label } = setup();
  commands.execute('layout.shape.rotate', { pageId, entityId: labelId, angleDeg: 30 });
  const tip = () => rotateLayoutPoint(label().points[2]!, layoutTextCenter(label()), label().text!.rotationDeg ?? 0);
  expect(tip()[0]).toBeCloseTo(20); expect(tip()[1]).toBeCloseTo(20);
  commands.execute('layout.shape.move', { pageId, entityId: labelId, labelPart: 'text', delta: [30, 20] });
  expect(tip()[0]).toBeCloseTo(20); expect(tip()[1]).toBeCloseTo(20);
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [10, 5] });
  expect(tip()[0]).toBeCloseTo(30); expect(tip()[1]).toBeCloseTo(25);
});

it('remaps attachments on page duplication and on copying source and label together', () => {
  const { doc, commands, pageId, sourceId, labelId, label } = setup();
  const copiedPage = commands.execute('layout.page.duplicate', { pageId }) as number;
  const copies = [...doc.state.pages.get(copiedPage)!.entities.values()];
  const copiedLabel = copies.find(entity => entity.kind === 'label')!, copiedSource = copies.find(entity => entity.kind === 'path')!;
  expect(copiedLabel.labelAnchor?.entityId).toBe(copiedSource.id);
  const ids = commands.execute('layout.shape.move', { pageId, entityIds: [labelId, sourceId], delta: [10, 10], copy: true }) as number[];
  const copy = doc.state.pages.get(pageId)!.entities.get(ids[0]!)!;
  expect(copy.labelAnchor?.entityId).toBe(ids[1]); expect(copy.points[2]).toEqual([30, 30]);
  expect(label().points[2]).toEqual([20, 20]);
});

it.each(['delete', 'topology', 'anchor field'])('detaches safely on %s and restores with undo', change => {
  const { commands, pageId, sourceId, labelId, label } = setup();
  if (change === 'delete') commands.execute('layout.shape.delete', { pageId, entityId: sourceId });
  else if (change === 'topology') commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[20, 20], [30, 20], [40, 20]] });
  else commands.execute('layout.text.setBounds', { pageId, entityId: labelId, anchor: [25, 30] });
  expect(label().labelAnchor).toBeUndefined();
  expect(label().points[2]).toEqual(change === 'anchor field' ? [25, 30] : [20, 20]);
  commands.execute('edit.undo'); expect(label().labelAnchor?.entityId).toBe(sourceId); expect(label().points[2]).toEqual([20, 20]);
});

it('retains a vertex relationship through a known line-join mapping', () => {
  const { commands, pageId, sourceId, label } = setup();
  commands.execute('layout.path.addLine', { pageId, start: [5, 20], end: [20, 20] });
  expect(label().labelAnchor).toEqual({ entityId: sourceId, pointIndex: 1, pointCount: 3 });
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [10, 10] });
  expect(label().points[2]).toEqual([30, 30]);
});

it('keeps a dimension end and a label tip at a point along a segment through edits and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[20, 20], [60, 20], [60, 60]] }) as number;
  const dimensionId = commands.execute('layout.dimension.add', { pageId, points: [[30, 20], [60, 40], [45, 10]],
    anchors: [{ entityId: sourceId, pointIndex: 0, pointCount: 3, t: 0.25 }, { entityId: sourceId, pointIndex: 1, pointCount: 3, t: 0.5 }] }) as number;
  const labelId = commands.execute('layout.text.add', { pageId, kind: 'label', points: createLayoutLabelGeometry([40, 20], [70, 0], [100, 0]).points,
    labelAnchor: { entityId: sourceId, pointIndex: 0, pointCount: 3, t: 0.5 },
    text: { content: 'Mid', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
      underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'straight', endpoint: 'arrow' } }) as number;
  const entity = (id: number) => doc.state.pages.get(pageId)!.entities.get(id)!;
  expect(entity(dimensionId).dimension!.anchors[0]).toEqual({ entityId: sourceId, pointIndex: 0, pointCount: 3, t: 0.25 });
  commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[0, 0], [80, 0], [80, 80]] });
  expect(entity(dimensionId).points.slice(0, 2)).toEqual([[20, 0], [80, 40]]);
  expect(entity(labelId).points[2]).toEqual([40, 0]);
  commands.execute('edit.undo');
  expect(entity(dimensionId).points.slice(0, 2)).toEqual([[30, 20], [60, 40]]);
  // The last vertex of an open path starts no segment.
  expect(() => commands.execute('layout.dimension.add', { pageId, points: [[30, 20], [60, 40], [45, 10]],
    anchors: [{ entityId: sourceId, pointIndex: 2, pointCount: 3, t: 0.5 }, null] })).toThrow('Dimension anchor is unavailable');
});

it('updates page-local labels attached to shared objects on every page', () => {
  const { doc, commands, pageId, sourceId, label } = setup();
  const sharedLayer = commands.execute('layout.layer.add', { name: 'Shared', shared: true });
  commands.execute('layout.shape.assignLayer', { pageId, entityId: sourceId, layerId: sharedLayer });
  const nextPage = commands.execute('layout.page.duplicate', { pageId }) as number;
  commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [5, 10] });
  expect(label().points[2]).toEqual([25, 30]);
  const otherLabel = [...doc.state.pages.get(nextPage)!.entities.values()].find(entity => entity.kind === 'label')!;
  expect(otherLabel.labelAnchor?.entityId).toBe(sourceId); expect(otherLabel.points[2]).toEqual([25, 30]);
});
