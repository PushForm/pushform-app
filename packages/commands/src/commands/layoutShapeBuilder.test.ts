// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LENGTH_TOL } from '@pushform/core';
import { createLayoutDocument, createLayoutShapeRegions, layoutShapeBuildSnapshot, layoutShapeRegionsAlong } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const ids = [[0, 0, 30, 30], [10, 10, 20, 20]].map(([x, y, right, bottom]) => commands.execute('layout.rectangle.add', {
    pageId, kind: 'rectangle', first: [x, y], second: [right, bottom],
  }) as number);
  doc.transact('Styles', draft => {
    draft.pages.get(pageId)!.entities.get(ids[0]!)!.style = { fillColor: '#ff0000', strokeColor: '#111111', strokeWeightPt: 2 };
    draft.pages.get(pageId)!.entities.get(ids[1]!)!.style = { fillColor: null, strokeColor: '#0000ff', strokeWeightPt: 3, strokeDashMm: [2, 1] };
  });
  const sources = ids.map(id => doc.state.pages.get(pageId)!.entities.get(id)!);
  const regions = createLayoutShapeRegions(sources);
  const first = layoutShapeRegionsAlong(regions, [15, 15], [15, 15]);
  const second = layoutShapeRegionsAlong(regions, [5, 5], [5, 5]);
  const params = { pageId, entityIds: ids, sourceSnapshot: layoutShapeBuildSnapshot(sources), keepOriginals: false,
    gestures: [{ mode: 'add' as const, regions: first }, { mode: 'add' as const, regions: second }] };
  return { doc, commands, pageId, ids, params, sources, first, second };
}
it('applies one first-region style to successively clicked regions and restores originals in one undo', () => {
  const { doc, commands, pageId, ids, params, sources } = setup(), before = doc.state;
  const result = commands.execute('layout.shape.build', params) as number[];
  expect(result).toHaveLength(1);
  const page = doc.state.pages.get(pageId)!;
  expect(page.entityOrder).toEqual(result);
  expect(ids.every(id => !page.entities.has(id))).toBe(true);
  for (const id of result) expect(page.entities.get(id)?.style).toEqual(sources[1]!.style);
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
  commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entityOrder).toEqual(result);
});
it('keeps originals and places results directly above the frontmost source', () => {
  const { doc, commands, pageId, ids, params } = setup();
  const unrelated = commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [40, 40], second: [50, 50] }) as number;
  const results = commands.execute('layout.shape.build', { ...params, keepOriginals: true }) as number[];
  expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([...ids, ...results, unrelated]);
});
it('rejects stale snapshots, unknown regions and locked operands atomically', () => {
  const { doc, commands, pageId, ids, params } = setup();
  let before = doc.state;
  expect(() => commands.execute('layout.shape.build', { ...params, sourceSnapshot: 'old' })).toThrow(/changed/);
  expect(() => commands.execute('layout.shape.build', { ...params, gestures: [{ mode: 'add', regions: ['old'] }] })).toThrow(/changed/);
  expect(doc.state).toBe(before);
  doc.transact('Lock', draft => { draft.pages.get(pageId)!.entities.get(ids[0]!)!.locked = true; });
  before = doc.state;
  expect(() => commands.execute('layout.shape.build', params)).toThrow(/locked/);
  expect(doc.state).toBe(before);
});
it.each([false, true])('keeps all undeleted sections with original styles in deletion-only mode (Keep originals %s)', keepOriginals => {
  const { doc, commands, pageId, params, first, sources } = setup(), before = doc.state;
  const results = commands.execute('layout.shape.build', { ...params, keepOriginals,
    gestures: [{ mode: 'remove', regions: first }] }) as number[];
  expect(results).toHaveLength(1);
  const remaining = doc.state.pages.get(pageId)!.entities.get(results[0]!)!;
  expect(remaining.contourStarts).toHaveLength(2);
  expect(remaining.style).toEqual(sources[0]!.style);
  expect(doc.state.pages.get(pageId)!.entities.size).toBe(1);
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
  commands.execute('edit.redo'); expect(doc.state.pages.get(pageId)!.entities.size).toBe(1);
});
it.each([false, true])('removes every section when all are marked Delete (Keep originals %s)', keepOriginals => {
  const { doc, commands, pageId, params, first, second } = setup(), before = doc.state;
  expect(commands.execute('layout.shape.build', { ...params, keepOriginals,
    gestures: [{ mode: 'remove', regions: [...first, ...second] }] })).toEqual([]);
  expect(doc.state.pages.get(pageId)!.entities.size).toBe(0);
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
});
it.each([false, true])('clips retained originals to the kept area, excluding untouched and deleted sections (explicit Delete %s)', markDelete => {
  const { doc, commands, pageId, params, first, second, ids } = setup(), before = doc.state;
  commands.execute('layout.shape.build', { ...params, keepOriginals: true,
    gestures: [{ mode: 'add', regions: first }, ...(markDelete ? [{ mode: 'remove', regions: second }] : [])] });
  const entities = [...doc.state.pages.get(pageId)!.entities.values()];
  expect(entities).toHaveLength(3);
  for (const entity of entities) for (const [x, y] of entity.points) {
    expect(x).toBeGreaterThanOrEqual(10); expect(x).toBeLessThanOrEqual(20);
    expect(y).toBeGreaterThanOrEqual(10); expect(y).toBeLessThanOrEqual(20);
  }
  expect(doc.state.pages.get(pageId)!.entities.has(ids[0]!)).toBe(false);
  expect(doc.state.pages.get(pageId)!.entities.has(ids[1]!)).toBe(true);
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
});
it('builds in shared-layer storage and restores both source objects with undo', () => {
  const { doc, commands, pageId, params, ids } = setup();
  commands.execute('layout.layer.setShared', { pageId, layerId: doc.state.activeLayerId, shared: true, source: 'current' });
  const sources = ids.map(id => doc.state.sharedEntities.get(id)!);
  const before = doc.state;
  const results = commands.execute('layout.shape.build', { ...params, sourceSnapshot: layoutShapeBuildSnapshot(sources) }) as number[];
  expect(doc.state.sharedEntityOrder).toEqual(results);
  expect(doc.state.pages.get(pageId)!.entities.size).toBe(0);
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
});

it.each([false, true])('applies a line cutter with undo and clips retained open originals (Keep originals %s)', keepOriginals => {
  const { doc, commands, pageId, ids } = setup();
  doc.transact('Open cutter', draft => {
    const line = draft.pages.get(pageId)!.entities.get(ids[1]!)!;
    line.closed = false; line.points = [[-10, 15], [40, 15]];
  });
  const before = doc.state, sources = ids.map(id => before.pages.get(pageId)!.entities.get(id)!);
  const regions = createLayoutShapeRegions(sources);
  const results = commands.execute('layout.shape.build', { pageId, entityIds: ids, keepOriginals,
    sourceSnapshot: layoutShapeBuildSnapshot(sources),
    gestures: [{ mode: 'add', regions: layoutShapeRegionsAlong(regions, [5, 5], [5, 5]) }] }) as number[];
  expect(results).toHaveLength(1);
  const entities = [...doc.state.pages.get(pageId)!.entities.values()];
  expect(entities).toHaveLength(keepOriginals ? 3 : 1);
  for (const entity of entities) for (const [x, y] of entity.points) {
    expect(x).toBeGreaterThanOrEqual(-LENGTH_TOL * 1000); expect(x).toBeLessThanOrEqual(30 + LENGTH_TOL * 1000);
    expect(y).toBeGreaterThanOrEqual(-LENGTH_TOL * 1000); expect(y).toBeLessThanOrEqual(15 + LENGTH_TOL * 1000);
  }
  if (keepOriginals) {
    const line = entities.find(entity => !entity.closed)!;
    expect(line.points).toHaveLength(2);
    expect(line.points[0]![0]).toBeCloseTo(0); expect(line.points[0]![1]).toBeCloseTo(15);
    expect(line.points[1]![0]).toBeCloseTo(30); expect(line.points[1]![1]).toBeCloseTo(15);
    expect(line.style).toEqual(sources[1]!.style);
  }
  commands.execute('edit.undo'); expect(doc.state).toEqual(before);
  commands.execute('edit.redo'); expect([...doc.state.pages.get(pageId)!.entities.values()]).toEqual(entities);
});
