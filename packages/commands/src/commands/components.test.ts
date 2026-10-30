// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4translation } from '@pushform/core';
import type { DefId, Id, Mat4 } from '@pushform/core';
import { allocId, createEntityContainer } from '@pushform/model';
import type { DocumentDraft, DocumentState } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { componentCommands, componentPlacement } from './components';

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

/** A model with components A and B and a group; A is placed at the top and holds a placement of B. */
function setup() {
  const host = new DocumentHost();
  const activated: string[] = [];
  const registry = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host]]), tools: { activate: (id: string) => activated.push(id) } as never });
  for (const list of [editCommands, componentCommands]) registry.registerAll(list);
  const ids = { a: 0 as DefId, b: 0 as DefId, group: 0 as DefId, aTop: 0 as Id, groupTop: 0 as Id, bInA: 0 as Id };
  host.edit('fixture', (draft) => {
    const s = draftState(draft);
    const root = s.definitions.get(s.rootDefinitionId)!;
    const define = (name: string, isGroup: boolean): DefId => {
      const id = allocId<DefId>(draft);
      s.definitions.set(id, { ...root, id, name, description: '', isGroup, entities: createEntityContainer(), bounds: null,
        behaviors: { glueTo: 'none', cutsOpening: false, alwaysFaceCamera: false, shadowsFaceSun: false } });
      return id;
    };
    const place = (into: DefId, def: DefId, x = 0): Id => {
      const id = allocId<Id>(draft);
      const container = s.definitions.get(into)!.entities;
      container.instances.set(id, { id, definitionId: def, transform: m4translation([x, 0, 0]) as unknown as Mat4, name: '', materialId: null,
        tagId: s.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} });
      container.order.push(id);
      return id;
    };
    ids.a = define('A', false); ids.b = define('B', false); ids.group = define('Group', true);
    ids.aTop = place(s.rootDefinitionId, ids.a); ids.groupTop = place(s.rootDefinitionId, ids.group, 5); ids.bInA = place(ids.a, ids.b);
  });
  host.undoStack.clear();
  return { host, registry, ids, activated, state: () => host.doc.state };
}
const topInstances = (state: DocumentState) => [...state.definitions.get(state.rootDefinitionId)!.entities.instances.values()];

describe('Components panel commands', () => {
  it('places a component at a point in the open context, selects it, and undoes in one step', () => {
    const { host, registry, ids, state } = setup();
    const before = topInstances(state()).length;
    const id = registry.execute('component.place', { definitionId: ids.b, point: [1, 2, 3] }) as number;
    const placed = topInstances(state()).find((i) => i.id === id)!;
    expect(placed.definitionId).toBe(ids.b);
    expect([...placed.transform].slice(12, 15)).toEqual([1, 2, 3]);
    expect(host.selection.refs).toEqual([{ kind: 'instance', path: [], id }]);
    host.undo();
    expect(topInstances(state())).toHaveLength(before);
    // Inside the open component A (placed at the origin), the point stays where it is in the model.
    host.setContext([ids.aTop]);
    const inner = registry.execute('component.place', { definitionId: ids.b, point: [4, 0, 0] }) as number;
    expect([...state().definitions.get(ids.a)!.entities.instances.get(inner as Id)!.transform].slice(12, 15)).toEqual([4, 0, 0]);
  });

  it('refuses to place a component inside itself, a group, or the model', () => {
    const { host, registry, ids } = setup();
    host.setContext([ids.aTop, ids.bInA]);
    expect(() => registry.execute('component.place', { definitionId: ids.a, point: [0, 0, 0] })).toThrow(/inside itself/);
    expect(() => registry.execute('component.place', { definitionId: ids.b, point: [0, 0, 0] })).toThrow(/inside itself/);
    host.setContext([]);
    expect(() => registry.execute('component.place', { definitionId: ids.group, point: [0, 0, 0] })).toThrow(/not found/);
  });

  it('starts placing by activating the Place Component tool with the chosen component', () => {
    const { registry, ids, activated } = setup();
    registry.execute('component.startPlacing', { definitionId: ids.b });
    expect(componentPlacement.current).toBe(ids.b);
    expect(activated).toEqual(['placeComponent']);
  });

  it('selects the instances in the open context and replaces selected component instances, not groups', () => {
    const { host, registry, ids, state } = setup();
    expect(registry.execute('component.selectInstances', { definitionId: ids.a })).toBe(1);
    expect(host.selection.refs).toEqual([{ kind: 'instance', path: [], id: ids.aTop }]);
    host.selection.set([{ kind: 'instance', path: [], id: ids.aTop }, { kind: 'instance', path: [], id: ids.groupTop }]);
    expect(registry.execute('component.replaceSelected', { definitionId: ids.b })).toBe(1);
    const top = topInstances(state());
    expect(top.find((i) => i.id === ids.aTop)!.definitionId).toBe(ids.b);
    expect(top.find((i) => i.id === ids.groupTop)!.definitionId).toBe(ids.group);
    host.undo();
    expect(topInstances(state()).find((i) => i.id === ids.aTop)!.definitionId).toBe(ids.a);
    host.selection.set([]);
    expect(() => registry.execute('component.replaceSelected', { definitionId: ids.b })).toThrow(/Select component instances/);
  });

  it('refuses to delete a component that is placed, even only inside another component', () => {
    const { registry, ids, state } = setup();
    expect(() => registry.execute('component.delete', { definitionId: ids.a })).toThrow(/placed in the model/);
    expect(() => registry.execute('component.delete', { definitionId: ids.b })).toThrow(/placed in the model/);
    expect(state().definitions.has(ids.b)).toBe(true);
  });

  it('edits name, description and behaviors, keeping names unique', () => {
    const { host, registry, ids, state } = setup();
    registry.execute('definition.setProperties', { definitionId: ids.a, name: 'Chair', description: 'Oak', glueTo: 'horizontal', cutsOpening: true, alwaysFaceCamera: true, shadowsFaceSun: true });
    expect(state().definitions.get(ids.a)).toMatchObject({ name: 'Chair', description: 'Oak', behaviors: { glueTo: 'horizontal', cutsOpening: true, alwaysFaceCamera: true, shadowsFaceSun: true } });
    expect(() => registry.execute('definition.setProperties', { definitionId: ids.a, name: 'B' })).toThrow(/already exists/);
    host.undo();
    expect(state().definitions.get(ids.a)).toMatchObject({ name: 'A', description: '', behaviors: { glueTo: 'none' } });
  });
});

it('deletes a component no instance uses', () => {
  const { host, registry, state } = setup();
  let spare = 0 as DefId;
  host.edit('fixture', (draft) => {
    const s = draftState(draft);
    const root = s.definitions.get(s.rootDefinitionId)!;
    spare = allocId<DefId>(draft);
    s.definitions.set(spare, { ...root, id: spare, name: 'Spare', isGroup: false, entities: createEntityContainer(), bounds: null });
  });
  registry.execute('component.delete', { definitionId: spare });
  expect(state().definitions.has(spare)).toBe(false);
  host.undo();
  expect(state().definitions.has(spare)).toBe(true);
});
