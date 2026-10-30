// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('preserves dash styles through transforms, clipboard, page duplication and undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const entityId = commands.execute('layout.shape.add', { pageId, points: [[10, 20], [90, 20]] }) as number;
  const source = () => doc.state.pages.get(pageId)!.entities.get(entityId)!;
  const dash = [4, 2, 1, 2];
  commands.execute('layout.shape.setStyle', { pageId, entityId, strokeDashMm: dash });
  commands.execute('layout.shape.setStyle', { pageId, entityId, strokeColor: '#ff0000' });
  commands.execute('layout.shape.move', { pageId, entityId, delta: [5, 5] });
  commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90 });
  commands.execute('layout.shape.scale', { pageId, entityId, scaleX: 2, scaleY: 2 });
  expect(source().style?.strokeDashMm).toEqual(dash);
  expect(source().points).toHaveLength(2);
  const ids = commands.execute('layout.clipboard.paste', { pageId, entities: [source()] }) as number[];
  expect(doc.state.pages.get(pageId)!.entities.get(ids[0]!)!.style?.strokeDashMm).toEqual(dash);
  const copyId = commands.execute('layout.page.duplicate', { pageId }) as number;
  expect([...doc.state.pages.get(copyId)!.entities.values()].map(entity => entity.style?.strokeDashMm)).toEqual([dash, dash]);
  commands.execute('layout.shape.setStyle', { pageId, entityId, strokeDashMm: [] });
  expect(source().style?.strokeDashMm).toBeUndefined();
  commands.execute('edit.undo'); expect(source().style?.strokeDashMm).toEqual(dash);
  commands.execute('edit.redo'); expect(source().style?.strokeDashMm).toBeUndefined();
  for (const invalid of [[4], [4, -2], [0, 2], [Infinity, 2]]) {
    expect(() => commands.execute('layout.shape.setStyle', { pageId, entityId, strokeDashMm: invalid })).toThrow();
  }
});
