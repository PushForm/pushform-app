// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';
function setup() {
  const doc = createLayoutDocument(),
    { commands } = createLayoutRegistry(doc),
    pageId = doc.state.pageOrder[0]!;
  const a = commands.execute('layout.rectangle.add', {
    pageId,
    kind: 'rectangle',
    first: [0, 0],
    second: [30, 30],
  }) as number;
  const b = commands.execute('layout.rectangle.add', {
    pageId,
    kind: 'rectangle',
    first: [10, 10],
    second: [20, 20],
  }) as number;
  return { doc, commands, pageId, a, b };
}
it('replaces operands atomically, keeps holes, and restores originals with undo/redo', () => {
  const { doc, commands, pageId, a, b } = setup(),
    before = doc.state;
  const result = commands.execute('layout.shape.boolean', {
    pageId,
    entityIds: [a, b],
    operation: 'subtract',
  }) as number;
  const page = doc.state.pages.get(pageId)!;
  expect(page.entityOrder).toEqual([result]);
  expect(page.entities.size).toBe(1);
  expect(page.entities.get(result)?.contourStarts).toHaveLength(2);
  expect(result).not.toBe(a);
  commands.execute('edit.undo');
  expect(doc.state).toEqual(before);
  commands.execute('edit.redo');
  expect(doc.state.pages.get(pageId)?.entities.get(result)?.contourStarts).toHaveLength(2);
});
it('rejects duplicates and locked objects without an edit', () => {
  const { doc, commands, pageId, a, b } = setup();
  const before = doc.state,
    version = doc.version;
  expect(() =>
    commands.execute('layout.shape.boolean', { pageId, entityIds: [a, a], operation: 'union' }),
  ).toThrow(/distinct/);
  expect(doc.state).toBe(before);
  expect(doc.version).toBe(version);
  doc.transact('Lock', (draft) => {
    draft.pages.get(pageId)!.entities.get(b)!.locked = true;
  });
  const locked = doc.state;
  expect(() =>
    commands.execute('layout.shape.boolean', { pageId, entityIds: [a, b], operation: 'union' }),
  ).toThrow(/locked/);
  expect(doc.state).toBe(locked);
});
it('represents an empty result by removing operands, with undo', () => {
  const { doc, commands, pageId, a, b } = setup();
  expect(
    commands.execute('layout.shape.boolean', { pageId, entityIds: [b, a], operation: 'subtract' }),
  ).toBeNull();
  expect(doc.state.pages.get(pageId)?.entities.size).toBe(0);
  commands.execute('edit.undo');
  expect(doc.state.pages.get(pageId)?.entities.size).toBe(2);
});

it('replaces shared-layer operands in the shared store and keeps unrelated order', () => {
  const { doc, commands, pageId, a, b } = setup();
  const c = commands.execute('layout.rectangle.add', {
    pageId,
    kind: 'rectangle',
    first: [50, 50],
    second: [60, 60],
  }) as number;
  doc.transact('Share', (draft) => {
    const page = draft.pages.get(pageId)!,
      layerId = page.entities.get(a)!.layerId;
    draft.layers.get(layerId)!.shared = true;
    for (const entityId of [a, b, c]) {
      draft.sharedEntities.set(entityId, page.entities.get(entityId)!);
      page.entities.delete(entityId);
    }
    draft.sharedEntityOrder = [a, c, b];
    page.entityOrder = [];
  });
  const result = commands.execute('layout.shape.boolean', {
    pageId,
    entityIds: [a, b],
    operation: 'subtract',
  }) as number;
  expect(doc.state.sharedEntityOrder).toEqual([result, c]);
  expect(doc.state.sharedEntities.get(result)?.contourStarts).toHaveLength(2);
  expect(doc.state.pages.get(pageId)?.entities.size).toBe(0);
});
it('rejects layer, visibility, group and open-path mismatches atomically', () => {
  for (const invalid of ['layer', 'hidden', 'group', 'open'] as const) {
    const { doc, commands, pageId, a, b } = setup();
    doc.transact('Invalid operand', (draft) => {
      const entity = draft.pages.get(pageId)!.entities.get(b)!;
      if (invalid === 'hidden') entity.hidden = true;
      if (invalid === 'group') entity.groupId = 999;
      if (invalid === 'open') entity.closed = false;
      if (invalid === 'layer') {
        const layer = draft.layers.get(entity.layerId)!;
        draft.layers.set(999, { ...layer, id: 999 });
        draft.layerOrder.push(999);
        entity.layerId = 999;
      }
    });
    const before = doc.state,
      version = doc.version;
    expect(() =>
      commands.execute('layout.shape.boolean', { pageId, entityIds: [a, b], operation: 'union' }),
    ).toThrow();
    expect(doc.state).toBe(before);
    expect(doc.version).toBe(version);
  }
});

it('preserves the target style and detaches annotations, restoring associations on undo', () => {
  const { doc, commands, pageId, a, b } = setup();
  commands.execute('layout.shape.setStyle', {
    pageId,
    entityId: a,
    fillColor: '#abc123',
    strokeWeightPt: 3,
  });
  const dimensionId = commands.execute('layout.dimension.add', {
    pageId,
    points: [
      [0, 0],
      [30, 0],
      [15, -5],
    ],
    anchors: [0, 1].map((pointIndex) => ({ entityId: a, pointIndex, pointCount: 4 })),
  }) as number;
  const before = doc.state,
    source = before.pages.get(pageId)!.entities.get(a)!;
  const result = commands.execute('layout.shape.boolean', {
    pageId,
    entityIds: [a, b],
    operation: 'subtract',
  }) as number;
  const page = doc.state.pages.get(pageId)!;
  expect(page.entities.get(result)?.style).toEqual(source.style);
  expect(page.entities.get(dimensionId)?.dimension).toMatchObject({
    detached: true,
    cachedValueMm: 30,
  });
  commands.execute('edit.undo');
  expect(doc.state).toEqual(before);
  expect(doc.state.pages.get(pageId)!.entities.get(dimensionId)?.dimension?.detached).toBe(false);
});

it.each(['division', 'cut-path'] as const)(
  '%s returns separate objects, consumes cutters and undoes in one step',
  (operation) => {
    const { doc, commands, pageId, a, b } = setup();
    const cutter = commands.execute('layout.shape.add', {
      pageId,
      points: [
        [15, -5],
        [15, 35],
      ],
      closed: false,
    }) as number;
    const before = doc.state,
      source = before.pages.get(pageId)!.entities.get(a)!;
    const resultIds = commands.execute('layout.shape.boolean', {
      pageId,
      entityIds: [a, cutter],
      operation,
    }) as number[];
    expect(resultIds).toHaveLength(2);
    const page = doc.state.pages.get(pageId)!;
    expect(page.entityOrder).toEqual([...resultIds, b]);
    expect(page.entities.has(a)).toBe(false);
    expect(page.entities.has(cutter)).toBe(false);
    for (const id of resultIds) {
      const result = page.entities.get(id)!;
      expect(result.closed).toBe(operation === 'division');
      expect(result.style?.strokeColor).toBe(source.style?.strokeColor);
      expect(result.style?.fillColor).toBe(
        operation === 'cut-path' ? null : source.style?.fillColor,
      );
    }
    commands.execute('edit.undo');
    expect(doc.state).toEqual(before);
    commands.execute('edit.redo');
    expect(doc.state.pages.get(pageId)!.entityOrder).toEqual([...resultIds, b]);
  },
);
