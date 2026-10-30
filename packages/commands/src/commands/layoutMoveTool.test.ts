// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, createLayoutLabelGeometry } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const page = () => doc.state.pages.get(pageId)!;
  const rect = (x: number) => commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [x, 10], second: [x + 10, 20] }) as number;
  const label = (anchorId: number) => commands.execute('layout.text.add', { pageId, kind: 'label',
    points: createLayoutLabelGeometry([20, 10], [60, 40], [95, 40]).points,
    labelAnchor: { entityId: anchorId, pointIndex: 0, pointCount: 4 },
    text: { content: 'Note', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
      underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
  return { doc, commands, pageId, page, rect, label };
}

describe('Move tool commands', () => {
  it('makes an array of copies in one undoable step, each directly above the previous one', () => {
    const { doc, commands, pageId, page, rect } = setup();
    const first = rect(10), other = rect(100);
    const ids = commands.execute('layout.shape.move', { pageId, entityIds: [first], delta: [15, 0], copy: true, whole: true, count: 3 }) as number[];
    expect(ids).toHaveLength(3);
    expect(ids.map((id) => page().entities.get(id)!.points[0])).toEqual([[25, 10], [40, 10], [55, 10]]);
    expect(page().entityOrder).toEqual([first, ...ids, other]);
    expect(page().entities.get(first)!.points[0]).toEqual([10, 10]);
    commands.execute('edit.undo');
    expect(page().entityOrder).toEqual([first, other]);
    expect(doc.undoStack.canUndo).toBe(true); // Only the array was removed, not the rectangles.
  });

  it('gives each array step its own copied groups and label attachments', () => {
    const { commands, pageId, page, rect, label } = setup();
    const source = rect(10), note = label(source);
    commands.execute('layout.shape.group', { pageId, entityIds: [source, note] });
    const groupId = page().entities.get(source)!.groupId;
    const ids = commands.execute('layout.shape.move', { pageId, entityIds: [source, note], delta: [0, 30], copy: true, whole: true, count: 2 }) as number[];
    const [rect1, label1, rect2, label2] = ids.map((id) => page().entities.get(id)!);
    expect(label1!.labelAnchor?.entityId).toBe(rect1!.id);
    expect(label2!.labelAnchor?.entityId).toBe(rect2!.id);
    expect(label2!.points[2]).toEqual([10, 70]);
    expect(rect1!.groupId).toBe(label1!.groupId);
    expect(new Set([groupId, rect1!.groupId, rect2!.groupId]).size).toBe(3);
  });

  it('moves labels whole, keeping an attachment only to an object that moves with them', () => {
    const { commands, pageId, page, rect, label } = setup();
    const source = rect(10), note = label(source);
    const before = page().entities.get(note)!.points;
    commands.execute('layout.shape.move', { pageId, entityIds: [note], delta: [5, 5], whole: true });
    expect(page().entities.get(note)!.points).toEqual(before.map(([x, y]) => [x + 5, y + 5]));
    expect(page().entities.get(note)!.labelAnchor).toBeUndefined();
    commands.execute('edit.undo');
    commands.execute('layout.shape.move', { pageId, entityIds: [source, note], delta: [5, 5], whole: true });
    expect(page().entities.get(note)!.labelAnchor?.entityId).toBe(source);
    expect(page().entities.get(note)!.points).toEqual(before.map(([x, y]) => [x + 5, y + 5]));
  });

  it('copies associated dimensions as fixed paper points, as Paste does', () => {
    const { commands, pageId, page, rect } = setup();
    const source = rect(10);
    const dimension = commands.execute('layout.dimension.add', { pageId, points: [[10, 10], [20, 10], [15, 5]],
      anchors: [0, 1].map((pointIndex) => ({ entityId: source, pointIndex, pointCount: 4 })) }) as number;
    const [copy] = commands.execute('layout.shape.move', { pageId, entityIds: [dimension], delta: [0, 50], copy: true, whole: true }) as number[];
    expect(page().entities.get(copy!)!.points).toEqual([[10, 60], [20, 60], [15, 55]]);
    expect(page().entities.get(copy!)!.dimension!.anchors).toEqual([null, null]);
    expect(page().entities.get(dimension)!.dimension!.anchors[0]?.entityId).toBe(source);
  });

  it('rejects arrays of moves and counts below one', () => {
    const { commands, pageId, page, rect } = setup();
    const id = rect(10), order = [...page().entityOrder];
    expect(() => commands.execute('layout.shape.move', { pageId, entityIds: [id], delta: [5, 0], count: 2 })).toThrow();
    expect(() => commands.execute('layout.shape.move', { pageId, entityIds: [id], delta: [5, 0], copy: true, count: 0 })).toThrow();
    expect(page().entityOrder).toEqual(order);
  });
});
