// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('makes a dimension rotated, keeps its angle through transforms and copies, and measures along it', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const entityId = commands.execute('layout.dimension.add', { pageId, points: [[0, 0], [40, 30], [0, -10]], style: { alignment: 'aligned' } }) as number;
  const dim = () => doc.state.pages.get(pageId)!.entities.get(entityId)!.dimension!;
  expect(dim().cachedValueMm).toBeCloseTo(50);
  // Made rotated without an angle, it keeps its measured direction (atan2(30, 40) = 36.87°).
  commands.execute('layout.dimension.update', { pageId, entityId, style: { alignment: 'rotated' } });
  expect(dim().angleDeg).toBeCloseTo(36.8699, 3);
  commands.execute('layout.dimension.update', { pageId, entityId, style: { angleDeg: 0 } });
  expect(dim().cachedValueMm).toBeCloseTo(40);
  commands.execute('layout.dimension.update', { pageId, entityId, style: { angleDeg: 270 } });
  expect(dim().angleDeg).toBe(90);
  expect(dim().cachedValueMm).toBeCloseTo(30);
  // The line turns with the dimension: a 90° rotation, then a flip, bring it back to 0° and 180° - 0°.
  commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90, pivot: [0, 0] });
  expect(dim().angleDeg).toBeCloseTo(0);
  commands.execute('layout.dimension.update', { pageId, entityId, style: { angleDeg: 30 } });
  commands.execute('layout.shape.flip', { pageId, entityId, axis: 'horizontal', pivot: [0, 0] });
  expect(dim().angleDeg).toBeCloseTo(150);
  commands.execute('layout.shape.scale', { pageId, entityId, scaleX: 1, scaleY: 2, pivot: [0, 0] });
  expect(dim().angleDeg).toBeCloseTo(180 - Math.atan2(2 * Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)) * 180 / Math.PI);
  const source = doc.state.pages.get(pageId)!.entities.get(entityId)!;
  const [copy] = commands.execute('layout.clipboard.paste', { pageId, entities: [source] }) as number[];
  expect(doc.state.pages.get(pageId)!.entities.get(copy!)!.dimension).toMatchObject({ alignment: 'rotated', angleDeg: dim().angleDeg });
  commands.execute('edit.undo'); commands.execute('edit.undo');
  expect(dim().angleDeg).toBeCloseTo(150);
});
