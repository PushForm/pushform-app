// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, entitiesForLayer } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

describe('Layout commands', () => {
  it('keeps Bézier controls with copies and transforms', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const id = commands.execute('layout.shape.add', {
      pageId, points: [[0, 0], [30, 0]],
      handles: [{ out: [10, 15] }, { in: [20, 15] }],
    }) as number;
    const copyId = commands.execute('layout.shape.move', {
      pageId, entityId: id, delta: [5, 5], copy: true,
    }) as number;
    expect(doc.state.pages.get(pageId)?.entities.get(copyId)?.handles).toEqual([
      { out: [15, 20] }, { in: [25, 20] },
    ]);
    commands.execute('layout.shape.flip', { pageId, entityId: copyId, axis: 'vertical', pivot: [0, 0] });
    expect(doc.state.pages.get(pageId)?.entities.get(copyId)?.handles?.[0]?.out).toEqual([15, -20]);
    expect(doc.state.pages.get(pageId)?.entities.get(id)?.handles?.[0]?.out).toEqual([10, 15]);
    commands.execute('edit.undo');
    expect(doc.state.pages.get(pageId)?.entities.get(copyId)?.handles?.[0]?.out).toEqual([15, 20]);
    expect(() => commands.execute('layout.shape.setPath', {
      pageId, entityId: id, points: [[0, 0], [30, 0]], handles: [{}],
    })).toThrow('Path handles must match anchor count');
  });

  it('draws and duplicates a page through registry transactions with isolated undo', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const first = doc.state.pageOrder[0]!;
    const entityId = commands.execute('layout.shape.add', {
      pageId: first,
      points: [
        [0, 0],
        [100, 0],
      ],
      closed: false,
    }) as number;
    const second = commands.execute('layout.page.duplicate', { pageId: first }) as number;
    expect(doc.state.pages.get(second)?.entities.size).toBe(1);
    expect(doc.state.pages.get(first)?.entities.get(entityId)?.points[1]).toEqual([100, 0]);
    commands.execute('edit.undo');
    expect(doc.state.pages.has(second)).toBe(false);
    expect(doc.state.pages.get(first)?.entities.has(entityId)).toBe(true);
    commands.execute('edit.undo');
    expect(doc.state.pages.get(first)?.entities.size).toBe(0);
  });

  it('refuses to draw on a locked layer', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const layerId = doc.state.activeLayerId;
    commands.execute('layout.layer.add', { name: 'Editable' });
    commands.execute('layout.layer.setLocked', { layerId, locked: true });
    expect(() => commands.execute('layout.layer.activate', { layerId })).toThrow('unavailable');
  });

  it('applies default and selected path styles through undoable commands', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    commands.execute('layout.style.setDefault', { strokeColor: '#ff0000' });
    const entityId = commands.execute('layout.shape.add', {
      pageId,
      points: [[0, 0], [100, 0]],
      closed: false,
    }) as number;
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.style?.strokeColor).toBe('#ff0000');
    commands.execute('layout.shape.setStyle', { pageId, entityId, fillColor: '#00ff00' });
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.style?.fillColor).toBe('#00ff00');
    commands.execute('edit.undo');
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.style?.fillColor).toBeNull();
  });

  it('moves and copies paths with independent geometry and undo', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const entityId = commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [30, 20]], closed: false,
    }) as number;
    expect(commands.execute('layout.shape.move', {
      pageId, entityId, delta: [5, -2],
    })).toBe(entityId);
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[15, 18], [35, 18]]);
    const copyId = commands.execute('layout.shape.move', {
      pageId, entityId, delta: [0, 12], copy: true,
    }) as number;
    const page = doc.state.pages.get(pageId)!;
    expect(page.entityOrder).toEqual([entityId, copyId]);
    expect(page.entities.get(copyId)?.points).toEqual([[15, 30], [35, 30]]);
    expect(page.entities.get(entityId)?.points).toEqual([[15, 18], [35, 18]]);
    commands.execute('edit.undo');
    expect(doc.state.pages.get(pageId)?.entities.has(copyId)).toBe(false);
    commands.execute('edit.undo');
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[10, 20], [30, 20]]);
    commands.execute('edit.redo');
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[15, 18], [35, 18]]);
  });

  it('rejects transforms on a locked layer or missing entity', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const entityId = commands.execute('layout.shape.add', {
      pageId, points: [[0, 0], [10, 0]], closed: false,
    }) as number;
    expect(() => commands.execute('layout.shape.move', {
      pageId, entityId: 999, delta: [1, 0],
    })).toThrow('Unknown shape');
    const sourceLayerId = doc.state.activeLayerId;
    commands.execute('layout.layer.add', { name: 'Editable' });
    commands.execute('layout.layer.setLocked', { layerId: sourceLayerId, locked: true });
    expect(() => commands.execute('layout.shape.move', {
      pageId, entityId, delta: [1, 0],
    })).toThrow('Layer is unavailable');
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[0, 0], [10, 0]]);
  });

  it('rotates, scales, and flips a path around its center with undo', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const entityId = commands.execute('layout.shape.add', {
      pageId, points: [[0, 0], [20, 0]], closed: false,
    }) as number;
    const points = () => doc.state.pages.get(pageId)!.entities.get(entityId)!.points;
    commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90 });
    expect(points()[0]![0]).toBeCloseTo(10);
    expect(points()[0]![1]).toBeCloseTo(-10);
    expect(points()[1]![0]).toBeCloseTo(10);
    expect(points()[1]![1]).toBeCloseTo(10);
    commands.execute('edit.undo');
    expect(points()).toEqual([[0, 0], [20, 0]]);

    commands.execute('layout.shape.scale', { pageId, entityId, scaleX: 2, scaleY: 1 });
    expect(points()).toEqual([[-10, 0], [30, 0]]);
    commands.execute('edit.undo');
    commands.execute('layout.shape.flip', { pageId, entityId, axis: 'horizontal' });
    expect(points()).toEqual([[20, 0], [0, 0]]);
    commands.execute('edit.undo');
    commands.execute('layout.shape.rotate', { pageId, entityId, angleDeg: 90, pivot: [0, 0] });
    expect(points()[1]![0]).toBeCloseTo(0);
    expect(points()[1]![1]).toBeCloseTo(20);
    expect(() => commands.execute('layout.shape.scale', {
      pageId, entityId, scaleX: 0, scaleY: 1,
    })).toThrow();
  });

  it('reorders layers and paths, and assigns a path to another layer', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const lowerLayerId = doc.state.activeLayerId;
    const add = () => commands.execute('layout.shape.add', {
      pageId, points: [[0, 0], [10, 0]], closed: false,
    }) as number;
    const first = add(), second = add();
    const upperLayerId = commands.execute('layout.layer.add', { name: 'Upper' }) as number;
    const third = add();
    commands.execute('layout.shape.order', { pageId, entityId: first, direction: 'front' });
    expect(doc.state.pages.get(pageId)?.entityOrder).toEqual([second, first, third]);
    commands.execute('layout.shape.order', { pageId, entityId: first, direction: 'backward' });
    expect(doc.state.pages.get(pageId)?.entityOrder).toEqual([first, second, third]);
    commands.execute('layout.shape.assignLayer', { pageId, entityId: first, layerId: upperLayerId });
    expect(doc.state.pages.get(pageId)?.entityOrder).toEqual([second, third, first]);
    expect(doc.state.pages.get(pageId)?.entities.get(first)?.layerId).toBe(upperLayerId);
    commands.execute('layout.shape.order', { pageId, entityId: first, direction: 'back' });
    expect(doc.state.pages.get(pageId)?.entityOrder).toEqual([second, first, third]);
    commands.execute('layout.layer.move', { layerId: lowerLayerId, toIndex: 1 });
    expect(doc.state.layerOrder).toEqual([upperLayerId, lowerLayerId]);
    commands.execute('edit.undo');
    expect(doc.state.layerOrder).toEqual([lowerLayerId, upperLayerId]);
    commands.execute('edit.redo');
    expect(doc.state.layerOrder).toEqual([upperLayerId, lowerLayerId]);
    commands.execute('layout.layer.setLocked', { layerId: upperLayerId, locked: true });
    expect(() => commands.execute('layout.shape.assignLayer', {
      pageId, entityId: second, layerId: upperLayerId,
    })).toThrow('Destination layer is unavailable');
    expect(() => commands.execute('layout.shape.order', {
      pageId, entityId: first, direction: 'front',
    })).toThrow('Layer is unavailable');
  });

  it('stores a shared path once and edits it from every page', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const firstPageId = doc.state.pageOrder[0]!;
    const ordinaryLayerId = doc.state.activeLayerId;
    const sharedLayerId = commands.execute('layout.layer.add', {
      name: 'Title block', shared: true,
    }) as number;
    const entityId = commands.execute('layout.shape.add', {
      pageId: firstPageId, points: [[10, 10], [110, 10]], closed: false,
    }) as number;
    const secondPageId = commands.execute('layout.page.add') as number;
    expect(doc.state.pages.get(secondPageId)!.size).toEqual([297, 210]);
    const first = doc.state.pages.get(firstPageId)!;
    const second = doc.state.pages.get(secondPageId)!;
    expect(first.entities.size).toBe(0);
    expect(second.entities.size).toBe(0);
    expect(doc.state.sharedEntities.size).toBe(1);
    expect(entitiesForLayer(first, doc.state, sharedLayerId)[0]?.id).toBe(entityId);
    expect(entitiesForLayer(second, doc.state, sharedLayerId)[0]?.id).toBe(entityId);

    commands.execute('layout.shape.move', {
      pageId: secondPageId, entityId, delta: [5, 0],
    });
    expect(doc.state.sharedEntities.get(entityId)?.points[0]).toEqual([15, 10]);
    commands.execute('edit.undo');
    expect(doc.state.sharedEntities.get(entityId)?.points[0]).toEqual([10, 10]);
    const duplicateId = commands.execute('layout.page.duplicate', { pageId: firstPageId }) as number;
    expect(doc.state.pages.get(duplicateId)?.entities.size).toBe(0);
    expect(doc.state.sharedEntities.size).toBe(1);

    commands.execute('layout.shape.assignLayer', {
      pageId: secondPageId, entityId, layerId: ordinaryLayerId,
    });
    expect(doc.state.sharedEntities.has(entityId)).toBe(false);
    expect(doc.state.pages.get(secondPageId)?.entities.has(entityId)).toBe(true);
    expect(doc.state.pages.get(firstPageId)?.entities.has(entityId)).toBe(false);
    commands.execute('edit.undo');
    expect(doc.state.sharedEntities.has(entityId)).toBe(true);
    expect(doc.state.pages.get(secondPageId)?.entities.has(entityId)).toBe(false);
    commands.execute('layout.shape.delete', { pageId: secondPageId, entityId });
    expect(doc.state.sharedEntities.size).toBe(0);
    commands.execute('edit.undo');
    expect(doc.state.sharedEntities.has(entityId)).toBe(true);

    commands.execute('layout.layer.activate', { layerId: ordinaryLayerId });
    const localId = commands.execute('layout.shape.add', {
      pageId: secondPageId, points: [[0, 0], [20, 0]], closed: false,
    }) as number;
    commands.execute('layout.shape.assignLayer', {
      pageId: secondPageId, entityId: localId, layerId: sharedLayerId,
    });
    expect(doc.state.pages.get(secondPageId)?.entities.has(localId)).toBe(false);
    expect(doc.state.sharedEntities.has(localId)).toBe(true);
    expect(entitiesForLayer(first, doc.state, sharedLayerId).map((entity) => entity.id))
      .toContain(localId);
    const copyId = commands.execute('layout.shape.move', {
      pageId: firstPageId, entityId: localId, delta: [5, 0], copy: true,
    }) as number;
    expect(doc.state.sharedEntities.has(copyId)).toBe(true);
    expect(doc.state.sharedEntityOrder).toEqual([entityId, localId, copyId]);
    commands.execute('edit.undo');
    expect(doc.state.sharedEntities.has(copyId)).toBe(false);
    commands.execute('layout.shape.order', {
      pageId: secondPageId, entityId: localId, direction: 'back',
    });
    expect(doc.state.sharedEntityOrder).toEqual([localId, entityId]);
    commands.execute('edit.undo');
    commands.execute('edit.undo');
    expect(doc.state.pages.get(secondPageId)?.entities.has(localId)).toBe(true);
    expect(doc.state.sharedEntities.has(localId)).toBe(false);
  });

  it('replaces path anchors through one undoable edit on ordinary and shared layers', () => {
    const doc = createLayoutDocument();
    const { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const entityId = commands.execute('layout.shape.add', {
      pageId, points: [[0, 0], [20, 0], [20, 20]], closed: true,
    }) as number;
    commands.execute('layout.shape.setPath', {
      pageId, entityId, points: [[0, 0], [25, 0], [25, 20], [0, 20]],
    });
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([
      [0, 0], [25, 0], [25, 20], [0, 20],
    ]);
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.closed).toBe(true);
    commands.execute('edit.undo');
    expect(doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([
      [0, 0], [20, 0], [20, 20],
    ]);
    expect(() => commands.execute('layout.shape.setPath', {
      pageId, entityId, points: [[0, 0], [10, 0]],
    })).toThrow('at least three points');

    const sharedLayerId = commands.execute('layout.layer.add', {
      name: 'Shared', shared: true,
    }) as number;
    commands.execute('layout.shape.assignLayer', { pageId, entityId, layerId: sharedLayerId });
    const secondPageId = commands.execute('layout.page.add') as number;
    commands.execute('layout.shape.setPath', {
      pageId: secondPageId, entityId,
      points: [[0, 0], [30, 0], [30, 20]],
    });
    expect(doc.state.sharedEntities.get(entityId)?.points[1]).toEqual([30, 0]);
    commands.execute('layout.layer.setLocked', {
      layerId: sharedLayerId, locked: true,
    });
    expect(() => commands.execute('layout.shape.setPath', {
      pageId, entityId, points: [[0, 0], [40, 0], [40, 20]],
    })).toThrow('Layer is unavailable');
  });
});

it('deletes layer contents from all pages and shared storage in one reversible command', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const first = doc.state.pageOrder[0]!;
  const fallback = doc.state.activeLayerId;
  const layerId = commands.execute('layout.layer.add', { name: 'Notes' }) as number;
  const shapeId = commands.execute('layout.shape.add', { pageId: first, points: [[0, 0], [10, 10]], closed: false }) as number;
  const second = commands.execute('layout.page.duplicate', { pageId: first }) as number;
  commands.execute('layout.layer.delete', { layerId });
  expect(doc.state.activeLayerId).toBe(fallback);
  expect(doc.state.pages.get(first)?.entityOrder).toEqual([]);
  expect(doc.state.pages.get(second)?.entities.size).toBe(0);
  commands.execute('edit.undo');
  expect(doc.state.pages.get(first)?.entities.has(shapeId)).toBe(true);
  expect(doc.state.pages.get(second)?.entities.size).toBe(1);
  const shared = commands.execute('layout.layer.add', { name: 'Border', shared: true }) as number;
  commands.execute('layout.shape.add', { pageId: first, points: [[0, 0], [20, 20]], closed: false });
  commands.execute('layout.layer.delete', { layerId: shared });
  expect(doc.state.sharedEntities.size).toBe(0);
  expect(doc.state.sharedEntityOrder).toEqual([]);
  commands.execute('edit.undo');
  expect(doc.state.sharedEntities.size).toBe(1);
  expect(doc.state.sharedEntityOrder).toHaveLength(1);
  commands.execute('edit.redo');
  commands.execute('layout.layer.delete', { layerId });
  expect(() => commands.execute('layout.layer.delete', { layerId: fallback })).toThrow('At least one layer must remain editable');
});

it('toggles layer page scope, preserves content and dimensions, and consolidates identical copies', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const first = doc.state.pageOrder[0]!;
  const second = commands.execute('layout.page.add', {}) as number;
  const layerId = doc.state.activeLayerId;
  const shape = commands.execute('layout.shape.add', { pageId: first, points: [[10, 10], [40, 10]], closed: false,
    handles: [{ out: [20, 15] }, {}], style: { strokeColor: '#123456', strokeWeightPt: 2, fillColor: null } }) as number;
  const dimension = commands.execute('layout.dimension.add', { pageId: first, points: [[10, 10], [40, 10], [10, 30]],
    anchors: [{ entityId: shape, pointIndex: 0, pointCount: 2 }, { entityId: shape, pointIndex: 1, pointCount: 2 }] }) as number;
  commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: true });
  expect(doc.state.layers.get(layerId)?.shared).toBe(true);
  expect(doc.state.sharedEntityOrder).toEqual([shape, dimension]);
  expect(doc.state.pages.get(first)?.entityOrder).toEqual([]);
  commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: false });
  expect(doc.state.sharedEntityOrder).toEqual([]);
  expect(doc.state.pages.get(first)?.entityOrder).toEqual([shape, dimension]);
  const other = doc.state.pages.get(second)!;
  const otherShape = other.entityOrder[0]!;
  expect(otherShape).not.toBe(shape);
  expect(other.entities.get(otherShape)?.handles).toEqual([{ out: [20, 15] }, {}]);
  expect(other.entities.get(other.entityOrder[1]!)?.dimension?.anchors[0]?.entityId).toBe(otherShape);
  commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: true });
  expect(doc.state.sharedEntityOrder).toEqual([shape, dimension]);
  expect(doc.state.pages.get(second)?.entities.size).toBe(0);
  commands.execute('edit.undo');
  expect(doc.state.pages.get(second)?.entities.size).toBe(2);
  expect(doc.state.layers.get(layerId)?.shared).toBe(false);
  commands.execute('layout.shape.move', { pageId: second, entityId: otherShape, delta: [10, 0] });
  const version = doc.version;
  expect(() => commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: true })).toThrow('Choose whether to include');
  expect(doc.version).toBe(version);
  expect(doc.state.sharedEntities.size).toBe(0);
  expect(doc.state.pages.get(first)?.entities.size).toBe(2);
  expect(doc.state.pages.get(second)?.entities.get(otherShape)?.points[0]).toEqual([20, 10]);
});

it.each(['current', 'all'] as const)('converts multiple pages using the explicit %s source and restores them with undo', (source) => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const first = doc.state.pageOrder[0]!;
  const layerId = doc.state.activeLayerId;
  const line = commands.execute('layout.shape.add', { pageId: first, points: [[0, 0], [20, 0]], closed: false }) as number;
  const second = commands.execute('layout.page.add', {}) as number;
  const other = commands.execute('layout.shape.add', { pageId: second, points: [[30, 30], [80, 30]], closed: false }) as number;
  const dimension = commands.execute('layout.dimension.add', { pageId: second, points: [[30, 30], [80, 30], [30, 50]],
    anchors: [{ entityId: other, pointIndex: 0, pointCount: 2 }, { entityId: other, pointIndex: 1, pointCount: 2 }] }) as number;
  commands.execute('layout.layer.setShared', { pageId: first, layerId, shared: true, source });
  expect(doc.state.sharedEntityOrder).toEqual(source === 'all' ? [line, other, dimension] : [line]);
  expect(doc.state.pages.get(first)?.entities.size).toBe(0);
  expect(doc.state.pages.get(second)?.entities.size).toBe(0);
  if (source === 'all') {
    expect(doc.state.sharedEntities.get(dimension)?.dimension?.anchors[0]?.entityId).toBe(other);
    expect(doc.state.sharedEntities.get(dimension)?.dimension?.detached).toBe(false);
  }
  commands.execute('edit.undo');
  expect(doc.state.layers.get(layerId)?.shared).toBe(false);
  expect(doc.state.pages.get(first)?.entityOrder).toEqual([line]);
  expect(doc.state.pages.get(second)?.entityOrder).toEqual([other, dimension]);
  commands.execute('edit.redo');
  expect(doc.state.sharedEntityOrder).toEqual(source === 'all' ? [line, other, dimension] : [line]);
});
