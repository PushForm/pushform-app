// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, TagId } from '@pushform/core';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { MemoryDisplayHost } from '../host/DisplayHost';
import { displayOf, SERVICE_DISPLAY, SERVICE_DOCUMENT } from '../host/services';
import { modelCommands } from './model';
import { sketchCommands } from './sketch';
import { groupCommands } from './groups';
import { styleCommands } from './styles';
import { tagCommands, tagEffectivelyVisible, tagInfos, tagUsage } from './tags';

function setup() {
  const host = new DocumentHost();
  const display = new MemoryDisplayHost();
  const registry = new CommandRegistry({
    tx: host,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_DISPLAY, display],
    ]),
  });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(groupCommands);
  registry.registerAll(styleCommands);
  registry.registerAll(tagCommands);
  const state = () => host.doc.state;
  return { host, registry, display, state };
}

describe('tag.create / rename / color / dashes / folders', () => {
  it('creates uniquely named tags with palette colors, renames, recolors, sets dashes and groups in folders', () => {
    const { registry, state, host } = setup();
    const a = registry.execute('tag.create', { name: 'Walls' }) as number;
    const b = registry.execute('tag.create', {}) as number;
    expect(state().tags.get(a as TagId)).toMatchObject({ name: 'Walls', visible: true, dashes: null, folderId: null });
    expect(state().tags.get(b as TagId)?.name).toMatch(/^Tag\d+$/);
    expect(() => registry.execute('tag.create', { name: 'Walls' })).not.toThrow();
    expect([...state().tags.values()].filter((t) => t.name.startsWith('Walls')).map((t) => t.name)).toEqual(['Walls', 'Walls2']);
    registry.execute('tag.rename', { id: a, name: 'Exterior walls' });
    expect(state().tags.get(a as TagId)?.name).toBe('Exterior walls');
    expect(() => registry.execute('tag.rename', { id: b, name: 'Exterior walls' })).toThrow(/already exists/);
    registry.execute('tag.setColor', { id: a, color: [1, 0, 0] });
    registry.execute('tag.setDashes', { id: a, dashes: 'dash' });
    expect(state().tags.get(a as TagId)).toMatchObject({ color: [1, 0, 0], dashes: 'dash' });
    registry.execute('tag.setDashes', { id: a, dashes: 'solid' });
    expect(state().tags.get(a as TagId)?.dashes).toBeNull();

    const folder = registry.execute('tag.folder.create', { name: 'Site', tagIds: [a] }) as number;
    expect(state().tags.get(a as TagId)?.folderId).toBe(folder);
    registry.execute('tag.folder.rename', { id: folder, name: 'Building' });
    expect(state().tagFolders.get(folder as never)?.name).toBe('Building');
    registry.execute('tag.folder.setVisible', { id: folder, visible: false });
    expect(tagEffectivelyVisible(state(), a as TagId)).toBe(false);
    expect(tagEffectivelyVisible(state(), b as TagId)).toBe(true);
    registry.execute('tag.folder.delete', { id: folder });
    expect(state().tagFolders.size).toBe(0);
    expect(state().tags.get(a as TagId)?.folderId).toBeNull();
    // everything above is undoable
    const n = host.undoStack.length;
    expect(n).toBeGreaterThan(5);
    host.undo();
    expect(state().tagFolders.size).toBe(1);
  });
});

describe('tag.assign / setActive / visibility', () => {
  it('assigns tags to bodies (with faces and edges), faces, sketch edges and instances; new entities get the active tag', () => {
    const { registry, state, host, display } = setup();
    const tag = registry.execute('tag.create', { name: 'Roof' }) as number;
    const bodyId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
    const bodyRef: EntityRef = { kind: 'body', path: [], id: bodyId };
    expect(registry.execute('tag.assign', { refs: [bodyRef], tagId: tag })).toBe(1);
    const body = () => host.doc.rootDefinition.entities.bodies.get(bodyId)!;
    expect(body().tagId).toBe(tag);
    expect([...body().faces.values()].every((f) => f.tagId === tag)).toBe(true);
    expect([...body().edges.values()].every((e) => e.tagId === tag)).toBe(true);
    // face override
    const faceId = body().faces.keys().next().value!;
    const other = registry.execute('tag.create', { name: 'Other' }) as number;
    registry.execute('tag.assign', { refs: [{ kind: 'face', path: [], id: bodyId, faceId, region: null }], tagId: other });
    expect(body().faces.get(faceId)?.tagId).toBe(other);
    expect(body().tagId).toBe(tag);
    // selection default + sketch edge
    const ids = registry.execute('sketch.addEdge', { a: [5, 0, 0], b: [6, 0, 0] }) as number[];
    host.selection.set([{ kind: 'sketchEdge', path: [], id: ids[0]! as Id }]);
    expect(registry.execute('tag.assign', { tagId: tag })).toBe(1);
    expect(host.doc.rootDefinition.entities.sketch.edges.get(ids[0]! as Id)?.tagId).toBe(tag);
    // active tag drives creation
    registry.execute('tag.setActive', { id: other });
    expect(display.get().activeTagId).toBe(other);
    const ids2 = registry.execute('sketch.addEdge', { a: [7, 0, 0], b: [8, 0, 0] }) as number[];
    expect(host.doc.rootDefinition.entities.sketch.edges.get(ids2[0]! as Id)?.tagId).toBe(other);
    const box2 = registry.execute('model.addBox', { min: [3, 3, 3], max: [4, 4, 4] }) as Id;
    expect(host.doc.rootDefinition.entities.bodies.get(box2)?.tagId).toBe(other);
    registry.execute('tag.setActive', { id: null });
    const box3 = registry.execute('model.addBox', { min: [6, 6, 6], max: [7, 7, 7] }) as Id;
    expect(host.doc.rootDefinition.entities.bodies.get(box3)?.tagId).toBe(state().defaultTagId);
    expect(() => registry.execute('tag.setActive', { id: 999999 })).toThrow(/not found/);
    // usage + infos
    const usage = tagUsage(state());
    expect(usage.get(tag as TagId)).toBeGreaterThan(1);
    expect(tagInfos(state()).find((t) => t.id === tag)?.uses).toBe(usage.get(tag as TagId));
    // visibility
    registry.execute('tag.setVisible', { ids: [tag], visible: false });
    expect(state().tags.get(tag as TagId)?.visible).toBe(false);
    expect(tagEffectivelyVisible(state(), tag as TagId)).toBe(false);
    // selectAll
    expect(registry.execute('tag.selectAll', { id: tag })).toBe(2); // body + sketch edge
  });
});

describe('tag.delete modes and tag.purge', () => {
  it('untagged / current / delete', () => {
    const { registry, state, host } = setup();
    const a = registry.execute('tag.create', { name: 'A' }) as number;
    const b = registry.execute('tag.create', { name: 'B' }) as number;
    const c = registry.execute('tag.create', { name: 'C' }) as number;
    const box = registry.execute('model.addBox') as Id;
    registry.execute('tag.assign', { refs: [{ kind: 'body', path: [], id: box }], tagId: a });
    const edge = (registry.execute('sketch.addEdge', { a: [5, 0, 0], b: [6, 0, 0] }) as number[])[0]! as Id;
    registry.execute('tag.assign', { refs: [{ kind: 'sketchEdge', path: [], id: edge }], tagId: b });
    expect(() => registry.execute('tag.delete', { id: state().defaultTagId, contents: 'untagged' })).toThrow(/Untagged/);

    // untagged
    expect(registry.execute('tag.delete', { id: a, contents: 'untagged' })).toMatchObject({ deleted: 0 });
    expect(host.doc.rootDefinition.entities.bodies.get(box)?.tagId).toBe(state().defaultTagId);
    expect(state().tags.has(a as TagId)).toBe(false);
    // current
    registry.execute('tag.setActive', { id: c });
    registry.execute('tag.delete', { id: b, contents: 'current' });
    expect(host.doc.rootDefinition.entities.sketch.edges.get(edge)?.tagId).toBe(c);
    // delete entities
    registry.execute('tag.delete', { id: c, contents: 'delete' });
    expect(host.doc.rootDefinition.entities.sketch.edges.has(edge)).toBe(false);
    expect(state().tags.size).toBe(1);
    host.undo();
    expect(host.doc.rootDefinition.entities.sketch.edges.has(edge)).toBe(true);
    expect(state().tags.has(c as TagId)).toBe(true);

    // purge removes unused tags and empty folders only
    const used = registry.execute('tag.create', { name: 'Used' }) as number;
    registry.execute('tag.assign', { refs: [{ kind: 'body', path: [], id: box }], tagId: used });
    const unused = registry.execute('tag.create', { name: 'Unused' }) as number;
    registry.execute('tag.setActive', { id: unused });
    registry.execute('tag.folder.create', { name: 'Empty' });
    const purged = registry.execute('tag.purge') as number;
    expect(purged).toBeGreaterThanOrEqual(2);
    // The active tag was purged, so new entities go back to Untagged.
    expect(displayOf(registry.ctx).get().activeTagId).toBeNull();
    // C survives: the restored sketch edge still uses it
    expect([...state().tags.values()].map((t) => t.name).sort()).toEqual(['C', 'Untagged', 'Used']);
    expect(state().tagFolders.size).toBe(0);
  });

  it('view.colorByTag toggles the active style modeling flag', () => {
    const { registry, state } = setup();
    expect(state().styles.get(state().activeStyleId)?.modeling.colorByTag).toBeUndefined();
    expect(registry.execute('view.colorByTag')).toBe(true);
    expect(state().styles.get(state().activeStyleId)?.modeling.colorByTag).toBe(true);
    expect(registry.execute('view.colorByTag', { value: false })).toBe(false);
    expect(state().styles.get(state().activeStyleId)?.modeling.colorByTag).toBe(false);
  });
});
