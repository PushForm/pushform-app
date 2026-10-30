// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from '@pushform/commands';
import { lastCreatedLayoutObjects, trackLayoutCreations } from './layoutLastCreated';

it('tracks creations across pages, keeps group order, skips undone/deleted objects, and survives repeated tracking', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), firstPage = doc.state.pageOrder[0]!;
  trackLayoutCreations(doc);
  const first = commands.execute('layout.shape.add', { pageId: firstPage, points: [[0, 0], [20, 10]], closed: false }) as number;
  const second = commands.execute('layout.shape.add', { pageId: firstPage, points: [[30, 0], [40, 10]], closed: false }) as number;
  commands.execute('layout.shape.group', { pageId: firstPage, entityIds: [first, second] });
  const secondPage = commands.execute('layout.page.add', { name: 'Other' }) as number;
  const page = () => doc.state.pages.get(secondPage)!;
  trackLayoutCreations(doc);
  expect(lastCreatedLayoutObjects(doc, page()).map(entity => entity.id)).toEqual([first, second]);
  const latest = commands.execute('layout.shape.add', { pageId: secondPage, points: [[0, 0], [20, 10]], closed: false }) as number;
  expect(lastCreatedLayoutObjects(doc, page()).map(entity => entity.id)).toEqual([latest]);
  commands.execute('edit.undo');
  expect(lastCreatedLayoutObjects(doc, page()).map(entity => entity.id)).toEqual([first, second]);
  commands.execute('edit.redo');
  expect(lastCreatedLayoutObjects(doc, page()).map(entity => entity.id)).toEqual([latest]);
  commands.execute('layout.shape.delete', { pageId: secondPage, entityId: latest });
  expect(lastCreatedLayoutObjects(doc, page()).map(entity => entity.id)).toEqual([first, second]);
});
