// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { LayoutDocument, createScaleDrawingState, createLayoutDocument, visibleDrawingEntities, drawingSketchPaths } from '@pushform/layout';
import { createLayoutRegistry } from './layout';
import { DocumentHost } from '../host/DocumentHost';
import { CommandRegistry } from '../registry/CommandRegistry';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from './sketch';

function setup() {
  const source = new LayoutDocument(createScaleDrawingState()), pageId = source.state.pageOrder[0]!;
  const sourceCommands = createLayoutRegistry(source).commands;
  sourceCommands.execute('layout.shape.add', { pageId, points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], closed: true });
  const target = createLayoutDocument(), commands = createLayoutRegistry(target).commands;
  const params = { pageId: target.state.pageOrder[0]!, sourceGuid: source.state.meta.guid, sourceName: 'Studio', sourcePageId: pageId,
    denominator: 50, x: 20, y: 30, rotation: 0, entities: visibleDrawingEntities(source.state, pageId) };
  return { source, sourceCommands, target, commands, params };
}
it('places full-size geometry at paper scale, updates one view, detaches and undoes', () => {
  const { source, target, commands, params } = setup();
  const original = source.state;
  const ids = commands.execute('layout.drawing.place', params) as number[];
  let page = target.state.pages.get(params.pageId)!;
  expect(page.entities.get(ids[0]!)!.points).toEqual([[20, 30], [140, 30], [140, 110], [20, 110]]);
  expect(page.entities.get(ids[0]!)!.locked).toBe(true);
  const second = commands.execute('layout.drawing.place', { ...params, denominator: 100 }) as number[];
  const updated = commands.execute('layout.drawing.place', { ...params, denominator: 25, replaceId: ids[0] }) as number[];
  page = target.state.pages.get(params.pageId)!;
  expect(page.entities.has(second[0]!)).toBe(true);
  expect(page.entities.has(ids[0]!)).toBe(false);
  expect(page.entities.get(updated[0]!)!.points[1]).toEqual([260, 30]);
  commands.execute('layout.drawing.detach', { pageId: params.pageId, entityId: updated[0] });
  expect(target.state.pages.get(params.pageId)!.entities.get(updated[0]!)!.drawingView).toBeUndefined();
  target.undoStack.undo();
  expect(target.state.pages.get(params.pageId)!.entities.get(updated[0]!)!.drawingView?.denominator).toBe(25);
  expect(source.state).toBe(original);
});
it('rejects invalid scale or a locked destination without edits', () => {
  const { target, commands, params } = setup();
  const before = target.state;
  expect(() => commands.execute('layout.drawing.place', { ...params, denominator: 0 })).toThrow();
  expect(target.state).toBe(before);
  target.transact('lock', d => { d.layers.get(d.activeLayerId)!.locked = true; });
  expect(() => commands.execute('layout.drawing.place', params)).toThrow(/layer/i);
  expect(target.state.pages.get(params.pageId)!.entities.size).toBe(0);
});
it('inserts a full-size closed sketch with a face and one undo step on each plane', () => {
  const { params } = setup();
  for (const plane of ['xy', 'xz', 'yz'] as const) {
    const host = new DocumentHost(), commands = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
    commands.registerAll(sketchCommands);
    const paths = drawingSketchPaths(params.entities, plane, [1, 2, 3], 0);
    commands.execute('sketch.insertDrawing', { paths });
    const sketch = host.doc.rootDefinition.entities.sketch;
    expect(sketch.faces.size).toBe(1);
    expect(sketch.edges.size).toBe(4);
    expect(host.doc.rootDefinition.entities.bodies.size).toBe(0);
    const points = [...sketch.vertices.values()].map(v => v.p);
    expect(points).toContainEqual([1, 2, 3]);
    expect(points).toContainEqual(plane === 'xy' ? [7, -2, 3] : plane === 'xz' ? [7, 2, -1] : [1, 8, -1]);
    host.undo(); expect(host.doc.rootDefinition.entities.sketch.edges.size).toBe(0);
    host.redo(); expect(host.doc.rootDefinition.entities.sketch.faces.size).toBe(1);
  }
});
it('keeps true dimension values and readable printed type at multiple sheet scales', () => {
  const { source, sourceCommands, params, commands, target } = setup();
  sourceCommands.execute('layout.dimension.add', { pageId: params.sourcePageId, points: [[0, 0], [6000, 0], [0, -400]] });
  const entities = visibleDrawingEntities(source.state, params.sourcePageId);
  for (const denominator of [25, 50, 100]) {
    const ids = commands.execute('layout.drawing.place', { ...params, entities, denominator }) as number[];
    const dimension = ids.map(id => target.state.pages.get(params.pageId)!.entities.get(id)!).find(e => e.dimension)!;
    expect(dimension.dimension!.cachedValueMm / dimension.dimension!.scale!).toBeCloseTo(6000);
    expect(dimension.dimension!.fontSizePt).toBe(10);
  }
});

it('scales physical stroke widths and dashes with a placed drawing without changing its source', () => {
  const { source, sourceCommands, params, commands, target } = setup();
  const sourceId = source.state.pages.get(params.sourcePageId)!.entityOrder[0]!;
  const strokeWeightPt = 10 * 72 / 25.4;
  sourceCommands.execute('layout.shape.setStyle', { pageId: params.sourcePageId, entityId: sourceId,
    strokeWeightPt, strokeDashMm: [40, 20] });
  const entities = visibleDrawingEntities(source.state, params.sourcePageId);
  for (const denominator of [25, 50, 100]) {
    const ids = commands.execute('layout.drawing.place', { ...params, entities, denominator }) as number[];
    const style = target.state.pages.get(params.pageId)!.entities.get(ids[0]!)!.style!;
    expect(style.strokeWeightPt * 25.4 / 72).toBeCloseTo(10 / denominator);
    expect(style.strokeDashMm).toEqual([40 / denominator, 20 / denominator]);
  }
  expect(source.state.pages.get(params.sourcePageId)!.entities.get(sourceId)!.style!.strokeWeightPt).toBe(strokeWeightPt);
});
