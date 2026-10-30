// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, LAYOUT_RECTANGLE_KINDS } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('creates styled editable rectangle variants through undoable commands and respects layers', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.style.setDefault', { fillColor: '#cceeff', strokeWeightPt: 2 });
  for (const kind of LAYOUT_RECTANGLE_KINDS) {
    const id = commands.execute('layout.rectangle.add', { pageId, kind, first: [10, 10], second: [70, 40] }) as number;
    expect(doc.state.pages.get(pageId)!.entities.get(id)).toMatchObject({ kind: 'path', closed: true, style: { fillColor: '#cceeff', strokeWeightPt: 2 } });
    commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(false);
    commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(true);
  }
  expect(() => commands.execute('layout.rectangle.add', { pageId, kind: 'lozenge', first: [0, 0], second: [0, 10] })).toThrow('non-zero');
  const shared = commands.execute('layout.layer.add', { name: 'Shared', shared: true }) as number;
  const id = commands.execute('layout.rectangle.add', { pageId, kind: 'lozenge', first: [0, 0], second: [30, 10] }) as number;
  expect(doc.state.sharedEntities.has(id)).toBe(true);
  commands.execute('layout.layer.setVisible', { layerId: shared, visible: false });
  expect(() => commands.execute('layout.rectangle.add', { pageId, kind: 'lozenge', first: [0, 0], second: [30, 10] })).toThrow('unavailable');
});
