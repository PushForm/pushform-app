// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, entitiesForLayer } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!, base = doc.state.activeLayerId;
  const labels: string[] = [];
  doc.events.on('change', event => labels.push(`${event.source}:${event.label}`));
  const run = <T = unknown>(id: string, params: object = {}): T => commands.execute(id, params) as T;
  const line = (y: number): number => run<number>('layout.shape.add', { pageId, points: [[0, y], [10, y]] });
  const entity = (id: number) => doc.state.pages.get(pageId)!.entities.get(id) ?? doc.state.sharedEntities.get(id);
  const order = (layerId: number): number[] => entitiesForLayer(doc.state.pages.get(pageId)!, doc.state, layerId).map(item => item.id);
  return { doc, commands, run, pageId, base, labels, line, entity, order };
}

describe('layout.shape.setHidden', () => {
  it('hides and shows objects as one undoable step, leaving them out of every drawn view', () => {
    const { doc, run, pageId, base, labels, line, entity, order } = setup();
    const a = line(0), b = line(5);
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: true });
    expect(entity(a)?.hidden).toBe(true);
    expect(labels.at(-1)).toBe('transact:Hide Objects');
    expect(order(base)).toEqual([b]);
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: false });
    expect(entity(a)).not.toHaveProperty('hidden');
    run('edit.undo');
    expect(entity(a)?.hidden).toBe(true);
    run('edit.undo');
    expect(entity(a)).not.toHaveProperty('hidden');
    // Showing a shown object records nothing.
    const newest = doc.undoStack.peek();
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: false });
    expect(doc.undoStack.peek()).toBe(newest);
  });

  it('hides locked objects but needs the layer shown on the page and unlocked', () => {
    const { run, pageId, base, line, entity } = setup();
    const a = line(0);
    run('layout.layer.add', { name: 'Spare' });
    run('layout.shape.setLocked', { pageId, entityIds: [a], locked: true });
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: true });
    expect(entity(a)?.hidden).toBe(true);
    run('layout.layer.setLocked', { layerId: base, locked: true });
    expect(() => run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: false })).toThrow('Layer is unavailable');
    run('layout.layer.setLocked', { layerId: base, locked: false });
    run('layout.layer.setVisible', { pageId, layerId: base, visible: false });
    expect(() => run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: false })).toThrow('Layer is unavailable');
  });

  it('never welds new lines to, or anchors dimensions on, hidden objects', () => {
    const { run, pageId, line, entity } = setup();
    const a = line(0);
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: true });
    const drawn = run<number>('layout.path.addLine', { pageId, start: [10, 0], end: [20, 0] });
    expect(drawn).not.toBe(a);
    expect(entity(a)?.points).toEqual([[0, 0], [10, 0]]);
    const dimension = run<number>('layout.dimension.add', { pageId, points: [[0, 0], [10, 0], [5, 5]] });
    expect(entity(dimension)?.dimension?.anchors.some(anchor => anchor?.entityId === a)).toBe(false);
  });
});

describe('layout.shape.arrange', () => {
  it('places objects at a paint index within their layer as one undoable step, and records nothing for no change', () => {
    const { doc, run, pageId, base, labels, line, order } = setup();
    const a = line(0), b = line(5), c = line(10);
    run('layout.shape.arrange', { pageId, entityIds: [c], layerId: base, index: 0 });
    expect(order(base)).toEqual([c, a, b]);
    expect(labels.at(-1)).toBe('transact:Arrange Objects');
    // Several objects keep their relative order; an index past the end puts them in front.
    run('layout.shape.arrange', { pageId, entityIds: [a, c], layerId: base, index: 99 });
    expect(order(base)).toEqual([b, c, a]);
    run('edit.undo');
    expect(order(base)).toEqual([c, a, b]);
    const newest = doc.undoStack.peek();
    run('layout.shape.arrange', { pageId, entityIds: [a], layerId: base, index: 1 });
    expect(doc.undoStack.peek()).toBe(newest);
  });

  it('moves objects between page and shared layers, keeping groups whole', () => {
    const { run, pageId, base, line, entity, order, doc } = setup();
    const a = line(0), b = line(5), c = line(10);
    const shared = run<number>('layout.layer.add', { name: 'Notes', shared: true });
    run('layout.shape.arrange', { pageId, entityIds: [b], layerId: shared, index: 0 });
    expect(doc.state.sharedEntities.get(b)?.layerId).toBe(shared);
    expect(doc.state.pages.get(pageId)!.entities.has(b)).toBe(false);
    expect(order(shared)).toEqual([b]);
    run('edit.undo');
    expect(entity(b)?.layerId).toBe(base);
    expect(order(base)).toEqual([a, b, c]);
    run('layout.shape.group', { pageId, entityIds: [a, c] });
    expect(() => run('layout.shape.arrange', { pageId, entityIds: [a], layerId: shared, index: 0 }))
      .toThrow('Shared and page-local objects cannot be grouped together');
    run('layout.shape.arrange', { pageId, entityIds: [a, c], layerId: shared, index: 0 });
    expect(order(shared)).toEqual([a, c]);
  });

  it('refuses locked objects and destination layers that are locked or hidden on the page', () => {
    const { run, pageId, base, line } = setup();
    const a = line(0), b = line(5);
    const other = run<number>('layout.layer.add', { name: 'Other' });
    run('layout.layer.setLocked', { layerId: other, locked: true });
    expect(() => run('layout.shape.arrange', { pageId, entityIds: [a], layerId: other, index: 0 })).toThrow('Destination layer is unavailable');
    run('layout.layer.setLocked', { layerId: other, locked: false });
    run('layout.layer.setVisible', { pageId, layerId: other, visible: false });
    expect(() => run('layout.shape.arrange', { pageId, entityIds: [a], layerId: other, index: 0 })).toThrow('Destination layer is unavailable');
    run('layout.shape.setLocked', { pageId, entityIds: [b], locked: true });
    expect(() => run('layout.shape.arrange', { pageId, entityIds: [b], layerId: base, index: 0 })).toThrow('Object is locked');
  });
});

describe('layout.layer.duplicate and layout.page.duplicate', () => {
  it('copies a layer above the original with its settings and independent copies of its objects on every page', () => {
    const { doc, run, pageId, base, labels, line, order } = setup();
    const a = line(0), b = line(5);
    run('layout.shape.group', { pageId, entityIds: [a, b] });
    const dimension = run<number>('layout.dimension.add', { pageId, points: [[0, 0], [10, 0], [5, 5]] });
    const page2 = run<number>('layout.page.add');
    run('layout.layer.setVisible', { pageId: page2, layerId: base, visible: false });
    const copy = run<number>('layout.layer.duplicate', { layerId: base });
    expect(labels.at(-1)).toBe('transact:Duplicate Layer');
    expect(doc.state.layerOrder).toEqual([base, copy]);
    expect(doc.state.layers.get(copy)).toMatchObject({ name: 'Layer 1 Copy', visible: true, locked: false, shared: false });
    expect(doc.state.pages.get(page2)!.layerVisibility?.get(copy)).toBe(false);
    const copies = order(copy).map(id => doc.state.pages.get(pageId)!.entities.get(id)!);
    expect(copies).toHaveLength(3);
    expect(copies.every(entity => ![a, b, dimension].includes(entity.id))).toBe(true);
    // Copies share a new group of their own.
    expect(copies[0]!.groupId).toBeDefined();
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe(doc.state.pages.get(pageId)!.entities.get(a)!.groupId);
    run('edit.undo');
    expect(doc.state.layers.has(copy)).toBe(false);
    expect(order(base)).toEqual([a, b, dimension]);
  });

  it('copies shared layers into the shared objects', () => {
    const { doc, run, pageId } = setup();
    const notes = run<number>('layout.layer.add', { name: 'Notes', shared: true });
    const note = run<number>('layout.shape.add', { pageId, points: [[0, 0], [10, 0]] });
    const copy = run<number>('layout.layer.duplicate', { layerId: notes });
    expect(doc.state.layers.get(copy)?.shared).toBe(true);
    const copies = [...doc.state.sharedEntities.values()].filter(entity => entity.layerId === copy);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.id).not.toBe(note);
  });

  it('keeps hidden objects hidden and pictures intact when a page is duplicated', () => {
    const { doc, run, pageId, line } = setup();
    const a = line(0);
    run('layout.shape.setHidden', { pageId, entityIds: [a], hidden: true });
    const [image] = run<number[]>('layout.clipboard.paste', { pageId, entities: [{ kind: 'image', points: [[0, 0], [10, 0], [10, 10], [0, 10]],
      closed: true, image: { src: 'data:image/png;base64,aGVsbG8=' } }] });
    const copy = run<number>('layout.page.duplicate', { pageId });
    const entities = [...doc.state.pages.get(copy)!.entities.values()];
    expect(entities.find(entity => entity.kind === 'path')?.hidden).toBe(true);
    expect(entities.find(entity => entity.kind === 'image')?.image?.src).toBe(doc.state.pages.get(pageId)!.entities.get(image!)!.image!.src);
  });
});

describe('layout.document.setup', () => {
  it('sets the paper size and margin of every page as one undoable step, and new pages take them', () => {
    const { doc, run, pageId, labels } = setup();
    const second = run<number>('layout.page.add');
    run('layout.document.setup', { widthMm: 420, heightMm: 297, marginMm: 15 });
    expect(labels.at(-1)).toBe('transact:Document Setup');
    for (const id of [pageId, second]) {
      expect(doc.state.pages.get(id)!.size).toEqual([420, 297]);
      expect(doc.state.pages.get(id)!.margin).toEqual({ top: 15, right: 15, bottom: 15, left: 15 });
    }
    const third = run<number>('layout.page.add');
    expect(doc.state.pages.get(third)!.size).toEqual([420, 297]);
    expect(doc.state.pages.get(third)!.margin.left).toBe(15);
    run('edit.undo'); run('edit.undo');
    expect(doc.state.pages.get(second)!.size).toEqual([297, 210]);
    expect(() => run('layout.document.setup', { marginMm: 200 })).toThrow('Margins exceed page size');
  });
});

describe('paper and grid units', () => {
  it('stores the units the paper and grid sizes are shown in, with undo', () => {
    const { doc, run } = setup();
    run('layout.document.setup', { widthMm: 279.4, heightMm: 215.9, units: 'in' });
    expect(doc.state.settings.paperUnits).toBe('in');
    expect(doc.state.pages.get(doc.state.pageOrder[0]!)!.size).toEqual([279.4, 215.9]);
    run('layout.grid.set', { units: 'in', spacingMm: 12.7 });
    expect(doc.state.settings.grid).toMatchObject({ units: 'in', spacingMm: 12.7 });
    run('edit.undo'); run('edit.undo');
    expect(doc.state.settings.paperUnits).toBeUndefined();
    expect(doc.state.settings.grid.units).toBeUndefined();
  });
});
