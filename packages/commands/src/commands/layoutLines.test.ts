// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

describe('Connected layout lines', () => {
  function setup() {
    const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc);
    const pageId = doc.state.pageOrder[0]!;
    const line = (a: [number, number], b: [number, number]): number => commands.execute('layout.path.addLine', { pageId, start: a, end: b }) as number;
    const page = () => doc.state.pages.get(pageId)!;
    return { doc, commands, pageId, line, page };
  }
  it('forms one filled boundary, with per-segment undo and redo', () => {
    const { commands, line, page } = setup();
    const id = line([10, 10], [50, 10]);
    expect(line([50, 10], [50, 40])).toBe(id);
    line([50, 40], [10, 40]);
    expect(page().entities.size).toBe(1);
    expect(page().entities.get(id)!.closed).toBe(false);
    line([10, 40], [10, 10]);
    expect(page().entities.get(id)).toMatchObject({ closed: true, points: [[10, 10], [50, 10], [50, 40], [10, 40]], style: { fillColor: '#ffffff' } });
    commands.execute('edit.undo');
    expect(page().entities.get(id)).toMatchObject({ closed: false, style: { fillColor: null } });
    commands.execute('edit.undo');
    expect(page().entities.get(id)!.points).toHaveLength(3);
    commands.execute('edit.redo'); commands.execute('edit.redo');
    expect(page().entities.get(id)!.closed).toBe(true);
  });
  it('joins separately drawn paths in either direction and preserves dimension associations', () => {
    const { commands, pageId, line, page } = setup();
    const first = line([0, 0], [20, 0]);
    const second = line([40, 0], [40, 20]);
    const dimId = commands.execute('layout.dimension.add', { pageId, points: [[40, 0], [40, 20], [50, 10]],
      anchors: [0, 1].map((pointIndex) => ({ entityId: second, pointIndex, pointCount: 2 })) }) as number;
    expect(line([40, 0], [20, 0])).toBe(second);
    expect(page().entities.has(first)).toBe(false);
    expect(page().entities.get(second)!.points).toEqual([[40, 20], [40, 0], [20, 0], [0, 0]]);
    expect(page().entities.get(dimId)!.dimension).toMatchObject({ cachedValueMm: 20, detached: false,
      anchors: [{ entityId: second, pointIndex: 1, pointCount: 4 }, { entityId: second, pointIndex: 0, pointCount: 4 }] });
    commands.execute('edit.undo');
    expect(page().entities.has(first)).toBe(true);
    expect(page().entities.get(dimId)!.dimension!.anchors[0]!.pointCount).toBe(2);
  });
  it('uses the default fill and leaves self-crossing and degenerate loops unfilled', () => {
    const { commands, line, page } = setup();
    commands.execute('layout.style.setDefault', { fillColor: '#ccddff' });
    const id = line([0, 0], [20, 0]); line([20, 0], [10, 20]); line([10, 20], [0, 0]);
    expect(page().entities.get(id)!.style!.fillColor).toBe('#ccddff');
    const crossing = line([40, 0], [60, 20]); line([60, 20], [40, 20]); line([40, 20], [60, 0]); line([60, 0], [40, 0]);
    expect(page().entities.get(crossing)!.closed).toBe(false);
    const flat = line([80, 0], [100, 0]); line([100, 0], [120, 0]); line([120, 0], [80, 0]);
    expect(page().entities.get(flat)!.closed).toBe(false);
  });
  it('respects layer boundaries and stores shared paths only once', () => {
    const { doc, commands, pageId, line, page } = setup();
    const original = line([0, 0], [20, 0]);
    commands.execute('layout.layer.add', { name: 'Shared', shared: true });
    const shared = line([20, 0], [20, 20]); line([20, 20], [0, 0]); line([0, 0], [20, 0]);
    expect(page().entities.get(original)!.points).toHaveLength(2);
    expect(doc.state.sharedEntities.size).toBe(1);
    expect(doc.state.sharedEntities.get(shared)!.closed).toBe(true);
    commands.execute('layout.layer.add', { name: 'Other' });
    commands.execute('layout.layer.setLocked', { layerId: 1, locked: true });
    expect(() => commands.execute('layout.layer.activate', { layerId: 1 })).toThrow('unavailable');
    expect(doc.state.pages.get(pageId)!.entities.size).toBe(1);
  });
  it('preserves reversed curve controls and avoids ambiguous branches', () => {
    const { commands, pageId, line, page } = setup();
    const curve = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [20, 0]],
      handles: [{ out: [5, 10] }, { in: [15, 10] }] }) as number;
    line([0, 0], [0, 20]);
    expect(page().entities.get(curve)!.points).toEqual([[20, 0], [0, 0], [0, 20]]);
    expect(page().entities.get(curve)!.handles).toEqual([{ out: [15, 10] }, { in: [5, 10], out: undefined }, {}]);
    commands.execute('layout.shape.add', { pageId, points: [[40, 40], [60, 40]] });
    commands.execute('layout.shape.add', { pageId, points: [[40, 40], [40, 60]] });
    const branch = line([40, 40], [20, 40]);
    expect(page().entities.get(branch)!.points).toEqual([[40, 40], [20, 40]]);
    expect(page().entities.size).toBe(4);
  });

});
