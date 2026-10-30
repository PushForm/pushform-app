// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, LAYOUT_ARC_KINDS } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('creates native styled arcs, supports undo/redo and shared layers, and rejects invalid input atomically', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  commands.execute('layout.style.setDefault', { fillColor: '#cceeff', strokeWeightPt: 2 });
  for (const kind of LAYOUT_ARC_KINDS) {
    const id = commands.execute('layout.arc.add', { pageId, kind, points: [[20, 20], [40, 20], [30, 40]] }) as number;
    expect(doc.state.pages.get(pageId)!.entities.get(id)).toMatchObject({ kind: 'path', closed: kind === 'pie',
      style: { fillColor: kind === 'pie' ? '#cceeff' : null, strokeWeightPt: 2 } });
    expect(doc.state.pages.get(pageId)!.entities.get(id)!.handles!.some(h => h.out)).toBe(true);
    commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(false);
    commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entities.has(id)).toBe(true);
  }
  const before = doc.state;
  expect(() => commands.execute('layout.arc.add', { pageId, kind: 'arc3', points: [[0, 0], [10, 0], [20, 0]] })).toThrow();
  expect(doc.state).toBe(before);
  const shared = commands.execute('layout.layer.add', { name: 'Shared', shared: true }) as number;
  const id = commands.execute('layout.arc.add', { pageId, kind: 'arc2', points: [[0, 0], [20, 0], [10, 10]] }) as number;
  expect(doc.state.sharedEntities.has(id)).toBe(true);
  commands.execute('layout.layer.setVisible', { layerId: shared, visible: false });
  expect(() => commands.execute('layout.arc.add', { pageId, kind: 'pie', points: [[0, 0], [20, 0], [10, 10]] })).toThrow('unavailable');
});
