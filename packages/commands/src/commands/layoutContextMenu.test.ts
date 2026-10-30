// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument, snapPaperPoint } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const add = (x: number) => commands.execute('layout.shape.add', { pageId, points: [[x, 30], [x + 20, 40]] }) as number;
  const ids = [add(30), add(60)];
  const entities = () => doc.state.pages.get(pageId)!.entities;
  return { doc, commands, pageId, ids, entities };
}

it('locks objects independently of layers, rejects edits, persists, and unlocks with undo', () => {
  const { doc, commands, pageId, ids, entities } = setup();
  commands.execute('layout.shape.setLocked', { pageId, entityIds: ids, locked: true });
  expect(doc.state.layers.get(doc.state.activeLayerId)?.locked).toBe(false);
  expect(() => commands.execute('layout.shape.move', { pageId, entityIds: ids, delta: [1, 2] })).toThrow('Object is locked');
  expect(() => commands.execute('layout.shape.delete', { pageId, entityIds: ids })).toThrow('Object is locked');
  commands.execute('layout.shape.setLocked', { pageId, entityIds: ids, locked: false });
  commands.execute('layout.shape.move', { pageId, entityIds: ids, delta: [1, 2] });
  expect(entities().get(ids[0]!)?.points[0]).toEqual([31, 32]);
  commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(entities().get(ids[0]!)?.locked).toBe(true);
});

it('groups, copies and duplicates groups with fresh identities, persists, and ungroups with undo', () => {
  const { doc, commands, pageId, ids, entities } = setup();
  const group = commands.execute('layout.shape.group', { pageId, entityIds: ids });
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([group, group]);
  const copied = commands.execute('layout.shape.move', { pageId, entityIds: ids, delta: [0, 10], copy: true }) as number[];
  const copyGroup = entities().get(copied[0]!)?.groupId;
  expect(copyGroup).toBeDefined(); expect(copyGroup).not.toBe(group);
  expect(entities().get(copied[1]!)?.groupId).toBe(copyGroup);
  const pasted = commands.execute('layout.clipboard.paste', { pageId, entities: ids.map(id => entities().get(id)) }) as number[];
  expect(entities().get(pasted[0]!)?.groupId).not.toBe(group);
  expect(entities().get(pasted[1]!)?.groupId).toBe(entities().get(pasted[0]!)?.groupId);
  const duplicate = commands.execute('layout.page.duplicate', { pageId }) as number;
  expect([...doc.state.pages.get(duplicate)!.entities.values()][0]?.groupId).not.toBe(group);
  commands.execute('layout.shape.ungroup', { pageId, entityIds: ids });
  expect(entities().get(ids[0]!)?.groupId).toBeUndefined();
  commands.execute('edit.undo'); expect(entities().get(ids[0]!)?.groupId).toBe(group);
});

it('keeps layer locks and shared/page scopes intact when grouping or unlocking', () => {
  const { doc, commands, pageId, ids } = setup();
  const shared = commands.execute('layout.layer.add', { name: 'Shared', shared: true }) as number;
  commands.execute('layout.shape.assignLayer', { pageId, entityId: ids[1], layerId: shared });
  expect(() => commands.execute('layout.shape.group', { pageId, entityIds: ids })).toThrow('cannot mix');
  commands.execute('layout.layer.setLocked', { layerId: doc.state.activeLayerId, locked: true });
  expect(() => commands.execute('layout.shape.setLocked', { pageId, entityIds: [ids[1]], locked: false })).toThrow('unavailable');
});

it('copies every group level independently and ungroups one level at a time', () => {
  const { doc, commands, pageId, ids, entities } = setup();
  for (const x of [90, 120]) ids.push(commands.execute('layout.shape.add', { pageId, points: [[x, 30], [x + 20, 40]] }) as number);
  const inner = commands.execute('layout.shape.group', { pageId, entityIds: ids.slice(0, 2) }) as number;
  const middle = commands.execute('layout.shape.group', { pageId, entityIds: ids.slice(0, 3) }) as number;
  const outer = commands.execute('layout.shape.group', { pageId, entityIds: ids }) as number;
  expect(entities().get(ids[0]!)?.nestedGroupIds).toEqual([middle, inner]);
  expect(entities().get(ids[2]!)?.nestedGroupIds).toEqual([middle]);
  const moved = commands.execute('layout.shape.move', { pageId, entityIds: ids, delta: [0, 10], copy: true }) as number[];
  const pasted = commands.execute('layout.clipboard.paste', { pageId, entities: ids.map(id => entities().get(id)) }) as number[];
  const duplicate = commands.execute('layout.page.duplicate', { pageId }) as number;
  const originalOrder = doc.state.pages.get(pageId)!.entityOrder, duplicatePage = doc.state.pages.get(duplicate)!;
  const copied = [moved.map(id => entities().get(id)!), pasted.map(id => entities().get(id)!),
    ids.map(id => duplicatePage.entities.get(duplicatePage.entityOrder[originalOrder.indexOf(id)]!)!)];
  const used = new Set([outer, middle, inner]);
  for (const group of copied) {
    const root = group[0]!.groupId!, [mid, leaf] = group[0]!.nestedGroupIds!;
    for (const id of [root, mid!, leaf!]) { expect(used.has(id)).toBe(false); used.add(id); }
    expect(group.map(entity => entity.groupId)).toEqual([root, root, root, root]);
    expect(group[1]!.nestedGroupIds).toEqual([mid, leaf]);
    expect(group[2]!.nestedGroupIds).toEqual([mid]); expect(group[3]!.nestedGroupIds).toBeUndefined();
  }
  commands.execute('layout.shape.ungroup', { pageId, entityIds: ids });
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([middle, middle, middle, undefined]);
  expect(entities().get(ids[0]!)?.nestedGroupIds).toEqual([inner]);
  commands.execute('layout.shape.ungroup', { pageId, entityIds: ids.slice(0, 3) });
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([inner, inner, undefined, undefined]);
  commands.execute('layout.shape.ungroup', { pageId, entityIds: ids.slice(0, 2) });
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([undefined, undefined, undefined, undefined]);
  commands.execute('edit.undo'); commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(entities().get(ids[0]!)?.nestedGroupIds).toEqual([middle, inner]);
  expect(entities().get(ids[0]!)?.groupId).toBe(outer);
});

it('toggles object and grid snap independently, with undo and persistence', () => {
  const { doc, commands, pageId } = setup();
  const snap = () => snapPaperPoint([30.2, 30.2], doc.state.pages.get(pageId)!, doc.state, 1);
  // A new document starts with both object snap and grid snap enabled.
  expect(doc.state.settings.grid.snap).toBe(true);
  expect(snap().kind).toBe('endpoint');
  commands.execute('layout.snap.set', { enabled: false });
  expect(snap().kind).toBe('grid');
  commands.execute('layout.grid.set', { snap: false });
  expect(snap().kind).toBeNull();
  commands.execute('edit.undo'); expect(snap().kind).toBe('grid');
  commands.execute('edit.undo'); expect(snap().kind).toBe('endpoint');
});

it('does not weld a new line to locked or grouped geometry', () => {
  const { commands, pageId, ids, entities } = setup();
  commands.execute('layout.shape.setLocked', { pageId, entityIds: [ids[0]], locked: true });
  commands.execute('layout.path.addLine', { pageId, start: [50, 40], end: [55, 45] });
  expect(entities().get(ids[0]!)?.points).toEqual([[30, 30], [50, 40]]);
});
