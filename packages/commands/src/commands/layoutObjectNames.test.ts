// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument, layoutDefaultObjectNames, layoutObjectName } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const labels: string[] = [];
  doc.events.on('change', event => labels.push(`${event.source}:${event.label}`));
  const entity = (id: number) => doc.state.pages.get(pageId)!.entities.get(id) ?? doc.state.sharedEntities.get(id);
  return { doc, commands, pageId, labels, entity };
}

describe('layout.shape.rename', () => {
  it('renames, trims, clears to the default name and undoes as one Rename Object step', () => {
    const { doc, commands, pageId, labels, entity } = setup();
    const id = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [10, 0]] }) as number;
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: '  Datum  ' });
    expect(entity(id)?.name).toBe('Datum');
    expect(labels.at(-1)).toBe('transact:Rename Object');
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: '   ' });
    expect(entity(id)).not.toHaveProperty('name');
    expect(layoutObjectName(entity(id)!, layoutDefaultObjectNames(doc.state))).toBe('Line 1');
    commands.execute('edit.undo');
    expect(entity(id)?.name).toBe('Datum');
    expect(labels.at(-1)).toBe('undo:Rename Object');
    commands.execute('edit.undo');
    expect(entity(id)).not.toHaveProperty('name');
    commands.execute('edit.redo');
    expect(entity(id)?.name).toBe('Datum');
  });

  it('records nothing for an unchanged name and rejects names over the limit', () => {
    const { doc, commands, pageId, entity } = setup();
    const id = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [10, 0]] }) as number;
    const drawn = doc.undoStack.peek();
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: '' });
    expect(doc.undoStack.peek()).toBe(drawn);
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: 'A' });
    const renamed = doc.undoStack.peek();
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: ' A ' });
    expect(doc.undoStack.peek()).toBe(renamed);
    expect(() => commands.execute('layout.shape.rename', { pageId, entityId: id, name: 'x'.repeat(101) })).toThrow();
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: ` ${'x'.repeat(100)} ` });
    expect(entity(id)?.name).toHaveLength(100);
    expect(() => commands.execute('layout.shape.rename', { pageId, entityId: 999, name: 'Missing' })).toThrow('Unknown shape');
  });

  it('renames shared, locked and hidden objects', () => {
    const { commands, pageId, entity } = setup();
    const layerId = commands.execute('layout.layer.add', { name: 'Titleblock', shared: true }) as number;
    const id = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [10, 0], [10, 10]], closed: true }) as number;
    commands.execute('layout.shape.setLocked', { pageId, entityIds: [id], locked: true });
    commands.execute('layout.layer.setVisible', { layerId, visible: false });
    commands.execute('layout.layer.add', { name: 'Other' });
    commands.execute('layout.layer.setLocked', { layerId, locked: true });
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: 'Border' });
    expect(entity(id)?.name).toBe('Border');
  });
});

describe('layout.layer.rename', () => {
  it('renames a layer, including a locked one, and rejects empty names', () => {
    const { doc, commands, labels } = setup();
    const layerId = doc.state.activeLayerId;
    commands.execute('layout.layer.add', { name: 'Other' });
    commands.execute('layout.layer.setLocked', { layerId, locked: true });
    commands.execute('layout.layer.rename', { layerId, name: '  Notes ' });
    expect(doc.state.layers.get(layerId)?.name).toBe('Notes');
    expect(labels.at(-1)).toBe('transact:Rename Layer');
    expect(() => commands.execute('layout.layer.rename', { layerId, name: '  ' })).toThrow();
    expect(() => commands.execute('layout.layer.rename', { layerId: 999, name: 'Missing' })).toThrow('Unknown layer');
    commands.execute('edit.undo');
    expect(doc.state.layers.get(layerId)?.name).toBe('Layer 1');
  });

  it('renames a layer hidden on the page', () => {
    const { doc, commands, pageId } = setup();
    const layerId = doc.state.activeLayerId;
    commands.execute('layout.layer.add', { name: 'Other' });
    commands.execute('layout.layer.setVisible', { pageId, layerId, visible: false });
    commands.execute('layout.layer.rename', { layerId, name: 'Hidden notes' });
    expect(doc.state.layers.get(layerId)?.name).toBe('Hidden notes');
  });
});

describe('copies keep custom object names', () => {
  it('keeps the name through Move copies, arrays, page duplicates and paste', () => {
    const { doc, commands, pageId, entity } = setup();
    const id = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [10, 0]] }) as number;
    const plain = commands.execute('layout.shape.add', { pageId, points: [[0, 5], [10, 5]] }) as number;
    commands.execute('layout.shape.rename', { pageId, entityId: id, name: 'Datum' });
    const copy = commands.execute('layout.shape.move', { pageId, entityId: id, delta: [5, 5], copy: true }) as number;
    expect(entity(copy)?.name).toBe('Datum');
    const array = commands.execute('layout.shape.move', { pageId, entityIds: [id], delta: [0, 20], copy: true, whole: true, count: 2 }) as number[];
    expect(array.map(copyId => entity(copyId)?.name)).toEqual(['Datum', 'Datum']);
    const duplicate = commands.execute('layout.page.duplicate', { pageId }) as number;
    const duplicated = [...doc.state.pages.get(duplicate)!.entities.values()];
    expect(duplicated.filter(copyEntity => copyEntity.name === 'Datum')).toHaveLength(4);
    expect(duplicated.filter(copyEntity => copyEntity.name === undefined)).toHaveLength(1);
    expect(duplicated.every(copyEntity => ('name' in copyEntity) === (copyEntity.name !== undefined))).toBe(true);
    const pasted = commands.execute('layout.clipboard.paste', { pageId,
      entities: [JSON.parse(JSON.stringify(entity(id))), JSON.parse(JSON.stringify(entity(plain))), { ...JSON.parse(JSON.stringify(entity(plain))), name: '  ' }] }) as number[];
    expect(entity(pasted[0]!)?.name).toBe('Datum');
    expect(entity(pasted[1]!)).not.toHaveProperty('name');
    expect(entity(pasted[2]!)).not.toHaveProperty('name');
  });
});
