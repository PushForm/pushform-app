// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, LAYOUT_RECTANGLE_KINDS } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it.each([null, '#ffffff', '#cceeff'])('fills new closed shapes even with an older empty default (%s), keeping open paths unfilled', fillColor => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  expect(doc.state.defaultStyle.fillColor).toBe('#ffffff');
  commands.execute('layout.style.setDefault', { fillColor });
  const expected = fillColor ?? '#ffffff';
  const entity = (id: unknown) => doc.state.pages.get(pageId)!.entities.get(id as number)!;
  for (const kind of LAYOUT_RECTANGLE_KINDS) {
    const id = commands.execute('layout.rectangle.add', { pageId, kind, first: [10, 10], second: [60, 40] });
    expect(entity(id)).toMatchObject({ closed: true, style: { fillColor: expected } });
  }
  const pie = commands.execute('layout.arc.add', { pageId, kind: 'pie', points: [[80, 20], [100, 20], [80, 40]] });
  expect(entity(pie)).toMatchObject({ closed: true, style: { fillColor: expected } });
  // Circle, ellipse, and polygon tools all create native closed paths through shape.add.
  const points = [[10, 80], [30, 70], [50, 80], [30, 90]];
  const closed = commands.execute('layout.shape.add', { pageId, points, closed: true });
  expect(entity(closed).style?.fillColor).toBe(expected);
  const open = commands.execute('layout.shape.add', { pageId, points, closed: false });
  expect(entity(open).style?.fillColor).toBeNull();
  const arc = commands.execute('layout.arc.add', { pageId, kind: 'arc', points: [[80, 20], [100, 20], [80, 40]] });
  expect(entity(arc).style?.fillColor).toBeNull();
  commands.execute('layout.shape.setPath', { pageId, entityId: open, points, closed: true });
  expect(entity(open).style?.fillColor).toBe(expected);
  commands.execute('layout.shape.setStyle', { pageId, entityId: closed, fillColor: null });
  commands.execute('layout.shape.rotate', { pageId, entityId: closed, angleDeg: 90 });
  expect(entity(closed).style?.fillColor).toBeNull(); // Explicit styling remains editable.
  commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(entity(closed).style?.fillColor).toBe(expected);
});
