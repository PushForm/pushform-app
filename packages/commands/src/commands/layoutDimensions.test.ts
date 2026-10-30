// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, formatLinearDimension, linearDimensionGeometry } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  const sourceId = commands.execute('layout.shape.add', { pageId, points: [[10, 10], [110, 10]] }) as number;
  const entityId = commands.execute('layout.dimension.add', { pageId,
    points: [[10, 10], [110, 10], [60, 25]],
    anchors: [0, 1].map((pointIndex) => ({ entityId: sourceId, pointIndex, pointCount: 2 })),
  }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(entityId)!;
  return { doc, commands, pageId, sourceId, entityId, entity };
}

describe('Paper linear dimensions', () => {
  it('tracks source edits, retains the cached value when detached, and restores associations on undo', () => {
    const { commands, pageId, sourceId, entity } = setup();
    expect(entity().dimension).toMatchObject({ cachedValueMm: 100, detached: false });
    commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [130, 10]] });
    expect(entity().dimension!.cachedValueMm).toBe(120);
    commands.execute('layout.shape.delete', { pageId, entityId: sourceId });
    expect(entity().dimension).toMatchObject({ cachedValueMm: 120, detached: true });
    commands.execute('edit.undo');
    expect(entity().dimension).toMatchObject({ cachedValueMm: 120, detached: false });
    commands.execute('edit.undo');
    expect(entity().dimension!.cachedValueMm).toBe(100);
    commands.execute('edit.redo');
    expect(entity().dimension!.cachedValueMm).toBe(120);
    commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [50, 10], [130, 10]] });
    expect(entity().dimension).toMatchObject({ cachedValueMm: 120, detached: true });
    expect(entity().points[1]).toEqual([130, 10]);
  });

  it('formats real units, styles, and fixed paper measurements', () => {
    const { commands, pageId, entityId, entity } = setup();
    commands.execute('layout.dimension.update', { pageId, entityId,
      style: { units: 'inch', precision: 3, text: 'Overall <>', endpoint: 'tick' } });
    expect(formatLinearDimension(entity().dimension!)).toBe('Overall 3.937"');
    commands.execute('layout.dimension.update', { pageId, entityId, style: { units: 'm', precision: 2, showUnits: false } });
    expect(formatLinearDimension(entity().dimension!)).toBe('Overall 0.10');
    // Drawing scale and feet-and-inch formats are part of the undoable style.
    commands.execute('layout.dimension.update', { pageId, entityId, style: { scale: 1 / 50, showUnits: true } });
    expect(formatLinearDimension(entity().dimension!)).toBe('Overall 5.00 m');
    commands.execute('layout.dimension.update', { pageId, entityId, style: { format: 'architectural', units: 'inch', precision: 6, scale: 1 / 48, showDashes: false } });
    // 100 mm of paper at 1/4" = 1'-0" is 188.976", to the nearest 1/64".
    expect(formatLinearDimension(entity().dimension!)).toBe(`Overall 15' 8 31/32"`);
    expect(commands.execute('edit.undo')).toBeTruthy();
    expect(formatLinearDimension(entity().dimension!)).toBe('Overall 5.00 m');
    for (const style of [{ scale: 0 }, { scale: -2 }, { scale: Infinity }, { format: 'metric' }, { units: 'yd' }])
      expect(() => commands.execute('layout.dimension.update', { pageId, entityId, style })).toThrow();
    expect(formatLinearDimension(entity().dimension!)).toBe('Overall 5.00 m');
    commands.execute('layout.dimension.update', { pageId, entityId, detach: true });
    expect(entity().dimension!.anchors).toEqual([null, null]);
    const diagonalId = commands.execute('layout.dimension.add', { pageId, points: [[0, 0], [30, 40], [60, 0]] }) as number;
    commands.execute('layout.dimension.update', { pageId, entityId: diagonalId, style: { alignment: 'horizontal' } });
    expect(commands.execute('edit.undo')).toBeTruthy();
    expect(() => commands.execute('layout.dimension.add', { pageId, points: [[0, 0], [0, 0], [0, 5]] })).toThrow('distinct');
  });

  it('moves the line of an associated dimension and remaps sources when duplicating a page', () => {
    const { doc, commands, pageId, sourceId, entityId, entity } = setup();
    commands.execute('layout.shape.move', { pageId, entityId, delta: [0, 10] });
    expect(entity().points).toEqual([[10, 10], [110, 10], [60, 35]]);
    expect(linearDimensionGeometry(entity()).start).toEqual([10, 35]);
    const duplicatedPage = commands.execute('layout.page.duplicate', { pageId }) as number;
    const copy = doc.state.pages.get(duplicatedPage)!;
    const sourceCopy = [...copy.entities.values()].find((e) => e.kind === 'path')!;
    const dimensionCopy = [...copy.entities.values()].find((e) => e.dimension)!;
    expect(dimensionCopy.dimension!.anchors[0]!.entityId).toBe(sourceCopy.id);
    expect(sourceCopy.id).not.toBe(sourceId);
    commands.execute('layout.shape.setPath', { pageId: duplicatedPage, entityId: sourceCopy.id, points: [[10, 10], [210, 10]] });
    expect(doc.state.pages.get(duplicatedPage)!.entities.get(dimensionCopy.id)!.dimension!.cachedValueMm).toBe(200);
    expect(entity().dimension!.cachedValueMm).toBe(100);
  });

  it('protects locked dimensions and rejects page-local anchors for shared dimensions', () => {
    const { commands, pageId, sourceId, entityId } = setup();
    commands.execute('layout.layer.add', { name: 'Shared', shared: true });
    expect(() => commands.execute('layout.dimension.add', { pageId, points: [[10, 10], [110, 10], [50, 20]],
      anchors: [{ entityId: sourceId, pointIndex: 0, pointCount: 2 }, null] })).toThrow('unavailable');
    commands.execute('layout.layer.setLocked', { layerId: 1, locked: true });
    expect(() => commands.execute('layout.dimension.update', { pageId, entityId, style: { precision: 2 } })).toThrow('unavailable');
  });
});
