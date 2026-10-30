// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4identity } from '@pushform/core';
import type { DefId, Id } from '@pushform/core';
import { createEntityContainer } from '@pushform/model';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from './sketch';
import { curveCommands } from './curves';
import { tagCommands } from './tags';
import { materialCommands } from './materials';
import { contextMenu } from './contextMenu';
import type { ContextMenuItem } from './contextMenu';

const labels = (items: readonly ContextMenuItem[]) => items.map((i) => i.label);

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(sketchCommands);
  return { host, registry };
}

function addInstances(host: DocumentHost): { group: Id; comp: Id } {
  let group = 0 as Id, comp = 0 as Id;
  host.doc.transact('setup', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    const defG = draft.meta.nextId++ as DefId, defC = draft.meta.nextId++ as DefId;
    draft.definitions.set(defG, { ...root, id: defG, name: 'Group#1', isGroup: true, entities: createEntityContainer() } as never);
    draft.definitions.set(defC, { ...root, id: defC, name: 'Chair', isGroup: false, entities: createEntityContainer() } as never);
    const attrs = { materialId: null, tagId: draft.defaultTagId, castShadows: true, receiveShadows: true, attributes: {} };
    group = draft.meta.nextId++ as Id;
    comp = draft.meta.nextId++ as Id;
    root.entities.instances.set(group, { id: group, definitionId: defG, transform: m4identity(), name: '', hidden: false, locked: false, ...attrs } as never);
    root.entities.instances.set(comp, { id: comp, definitionId: defC, transform: m4identity(), name: 'chair 1', hidden: true, locked: true, ...attrs } as never);
  });
  return { group, comp };
}

describe('contextMenu.itemsFor', () => {
  it('empty space: Paste In Place (enabled with a copy), Select All, Zoom Extents, Exit Group only inside a context', () => {
    const { host } = setup();
    const items = contextMenu.itemsFor(host.doc.state, []);
    expect(labels(items)).toEqual(['Paste In Place', 'Select All', 'Zoom Extents']);
    expect(items[0]).toMatchObject({ command: 'edit.pasteInPlace', disabled: true });
    expect(contextMenu.itemsFor(host.doc.state, [], { canPaste: true })[0]!.disabled).toBe(false);
    expect(items[1]).toMatchObject({ command: 'edit.selectAll', separator: true });
    expect(items[2]!.command).toBe('camera.zoomExtents');
    const inCtx = contextMenu.itemsFor(host.doc.state, [], { contextPath: [5 as Id] });
    expect(labels(inCtx)).toContain('Exit Group');
    expect(inCtx.at(-1)).toMatchObject({ command: 'context.exit' });
  });

  it('sketch edge: Hide via geometry.setHidden, Select submenu with the bounding faces, Make Group/Component, Soften', () => {
    const { host, registry } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const sketch = host.doc.rootDefinition.entities.sketch;
    const edgeId = [...sketch.edges.keys()][0]!;
    const faceId = [...sketch.faces.keys()][0]!;
    const ref: EntityRef = { kind: 'sketchEdge', path: [], id: edgeId };
    const items = contextMenu.itemsFor(host.doc.state, [ref]);
    expect(labels(items)).toEqual(['Entity Info', 'Erase', 'Hide', 'Select', 'Make Group', 'Make Component…', 'Intersect Faces', 'Soften/Smooth Edges', 'Zoom Selection']);
    expect(items[0]).toMatchObject({ command: 'ui.panel.open', params: { id: 'entityInfo' } });
    expect(items[1]!.command).toBe('edit.delete');
    expect(items[2]).toMatchObject({ command: 'geometry.setHidden', params: { refs: [ref], hidden: true } });
    const select = items[3]!;
    expect(select.children!.map((c) => c.label)).toEqual(['Connected Faces', 'All Connected', 'All on Same Tag', 'All with Same Material']);
    expect(select.children![0]).toMatchObject({ command: 'selection.set', params: { refs: [ref, { kind: 'sketchFace', path: [], id: faceId }] } });
    expect((select.children![1]!.params as { refs: EntityRef[] }).refs).toHaveLength(5); // face + 4 edges
    expect(items[4]).toMatchObject({ command: 'group.make', params: { refs: [ref] } });
    expect(items[5]!.command).toBe('ui.makeComponent');
    expect(items[7]).toMatchObject({ command: 'ui.panel.open', params: { id: 'softenEdges' } });
    expect(items[8]).toMatchObject({ command: 'camera.zoomSelection', separator: true });
    expect(items[8]!.disabled).toBeUndefined();
  });

  it('body edge and face: Hide via geometry.setHidden, Connected Faces from the edge key, Reverse Faces', () => {
    const { host } = setup();
    const edge: EntityRef = { kind: 'edge', path: [], id: 7 as Id, edgeKey: '0:1:0' };
    const edgeItems = contextMenu.itemsFor(host.doc.state, [edge]);
    expect(edgeItems[2]).toMatchObject({ command: 'geometry.setHidden', params: { refs: [edge], hidden: true } });
    const faces = (edgeItems[3]!.children![0]!.params as { refs: EntityRef[] }).refs;
    expect(faces).toEqual([edge, { kind: 'face', path: [], id: 7, faceId: 0, region: null }, { kind: 'face', path: [], id: 7, faceId: 1, region: null }]);
    expect(edgeItems[3]!.children![1]!.params).toEqual({ refs: [{ kind: 'body', path: [], id: 7 }] });

    const face: EntityRef = { kind: 'face', path: [], id: 7 as Id, faceId: 0 as never, region: null };
    const faceItems = contextMenu.itemsFor(host.doc.state, [face]);
    expect(labels(faceItems)).toEqual(['Entity Info', 'Erase', 'Hide', 'Select', 'Make Group', 'Make Component…', 'Intersect Faces', 'Reverse Faces', 'Zoom Selection']);
    expect(faceItems[2]).toMatchObject({ command: 'geometry.setHidden', params: { refs: [face], hidden: true } });
    expect(faceItems[2]!.disabled).toBeUndefined();
    expect(faceItems[7]).toMatchObject({ command: 'faces.reverse', params: { refs: [face] } });
    expect(faceItems[7]!.disabled).toBeUndefined();
  });

  it('hidden edges and faces offer Unhide; a mix with visible ones offers Hide; edges with faces can be hidden together', () => {
    const { host, registry } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const sketch = host.doc.rootDefinition.entities.sketch;
    const [e1, e2] = [...sketch.edges.keys()];
    const face: EntityRef = { kind: 'sketchFace', path: [], id: [...sketch.faces.keys()][0]! };
    const edge1: EntityRef = { kind: 'sketchEdge', path: [], id: e1! }, edge2: EntityRef = { kind: 'sketchEdge', path: [], id: e2! };
    registry.execute('geometry.setHidden', { refs: [edge1, face], hidden: true });
    expect(contextMenu.itemsFor(host.doc.state, [edge1])[2]).toMatchObject({ label: 'Unhide', params: { refs: [edge1], hidden: false } });
    expect(contextMenu.itemsFor(host.doc.state, [face])[2]).toMatchObject({ label: 'Unhide', params: { refs: [face], hidden: false } });
    expect(contextMenu.itemsFor(host.doc.state, [edge1, edge2])[2]).toMatchObject({ label: 'Hide', params: { hidden: true } });
    const mixed = contextMenu.itemsFor(host.doc.state, [face, edge2]);
    expect(labels(mixed)).toEqual(['Entity Info', 'Erase', 'Hide', 'Make Group', 'Make Component…', 'Intersect Faces', 'Zoom Selection']);
    expect(mixed[2]).toMatchObject({ command: 'geometry.setHidden', params: { refs: [face, edge2], hidden: true } });
    expect(labels(contextMenu.itemsFor(host.doc.state, [face, { kind: 'body', path: [], id: 7 as Id }]))).not.toContain('Hide');
  });

  it('body: Make Group/Component, Flip Along, Solid Tools and Zoom Selection', () => {
    const { host } = setup();
    const body: EntityRef = { kind: 'body', path: [], id: 7 as Id };
    const items = contextMenu.itemsFor(host.doc.state, [body]);
    expect(labels(items)).toEqual(['Entity Info', 'Erase', 'Hide', 'Make Group', 'Make Component…', 'Flip Along', 'Solid Tools', 'Zoom Selection']);
    expect(items[3]).toMatchObject({ command: 'group.make', params: { refs: [body] } });
  });

  it('instance: Hide/Lock toggles by state, Edit Group/Component, Explode, Make Unique and Change Axes (components), Rename', () => {
    const { host } = setup();
    const { group, comp } = addInstances(host);
    const g: EntityRef = { kind: 'instance', path: [], id: group };
    const gi = contextMenu.itemsFor(host.doc.state, [g]);
    expect(labels(gi)).toEqual(['Entity Info', 'Erase', 'Hide', 'Lock', 'Edit Group', 'Explode', 'Make Component…', 'Flip Along', 'Rename…', 'Zoom Selection']);
    expect(gi[2]).toMatchObject({ command: 'instance.setHidden', params: { refs: [g], hidden: true } });
    expect(gi[3]).toMatchObject({ command: 'instance.setLocked', params: { refs: [g], locked: true } });
    expect(gi[4]).toMatchObject({ command: 'context.enter', params: { path: [group] }, separator: true });
    expect(gi[5]).toMatchObject({ command: 'group.explode', params: { refs: [g] } });
    expect(gi[8]).toMatchObject({ command: 'ui.renameInstance', params: { ref: g } });

    const c: EntityRef = { kind: 'instance', path: [], id: comp };
    const ci = contextMenu.itemsFor(host.doc.state, [c]);
    expect(labels(ci)).toEqual(['Entity Info', 'Erase', 'Unhide', 'Unlock', 'Edit Component', 'Explode', 'Make Component…', 'Make Unique', 'Change Axes', 'Flip Along', 'Rename…', 'Zoom Selection']);
    expect(ci[2]).toMatchObject({ params: { refs: [c], hidden: false } });
    expect(ci[3]).toMatchObject({ params: { refs: [c], locked: false } });
    expect(ci[4]!.disabled).toBe(true); // locked: cannot edit
    expect(ci[7]).toMatchObject({ command: 'component.makeUnique', params: { refs: [c] } });

    // two instances: no Edit / Rename, Make Unique because one is a component
    const both = contextMenu.itemsFor(host.doc.state, [g, c]);
    expect(labels(both)).toEqual(['Entity Info', 'Erase', 'Hide', 'Lock', 'Explode', 'Make Component…', 'Make Unique', 'Flip Along', 'Zoom Selection']);
  });

  it('Weld Edges for two or more sketch edges, available when they form one chain; runs sketch.weld', () => {
    const { host, registry } = setup();
    registry.registerAll(curveCommands);
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const sketch = host.doc.rootDefinition.entities.sketch;
    const edges = [...sketch.edges.values()];
    const ref = (id: Id): EntityRef => ({ kind: 'sketchEdge', path: [], id });
    const weld = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Weld Edges');
    expect(weld([ref(edges[0]!.id)])).toBeUndefined();
    const first = edges[0]!;
    const adjacent = edges.find((e) => e !== first && (e.a === first.a || e.a === first.b || e.b === first.a || e.b === first.b))!;
    const opposite = edges.find((e) => e !== first && e !== adjacent && ![e.a, e.b].some((v) => v === first.a || v === first.b))!;
    expect(weld([ref(opposite.id), ref(first.id)])).toMatchObject({ command: 'sketch.weld', disabled: true, separator: true });
    const loop = weld(edges.map((e) => ref(e.id)))!;
    expect(loop.disabled).toBe(false);
    const item = weld([ref(first.id), ref(adjacent.id)])!;
    expect(item).toMatchObject({ disabled: false, params: { edgeIds: [first.id, adjacent.id] } });
    const curveId = registry.execute(item.command, item.params) as number;
    expect(host.doc.rootDefinition.entities.sketch.edges.get(first.id)!.curveId).toBe(curveId);
  });

  it('Explode Curve for edges on curves, available when they all belong to one curve; runs sketch.explodeCurve', () => {
    const { host, registry } = setup();
    registry.registerAll(curveCommands);
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const ids = [...host.doc.rootDefinition.entities.sketch.edges.keys()];
    const ref = (id: Id): EntityRef => ({ kind: 'sketchEdge', path: [], id });
    const explode = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Explode Curve');
    expect(explode([ref(ids[0]!)])).toBeUndefined();
    const a = registry.execute('sketch.weld', { edgeIds: [ids[0]!] }) as number;
    const b = registry.execute('sketch.weld', { edgeIds: [ids[2]!] }) as number;
    expect(explode([ref(ids[0]!), ref(ids[2]!)])).toMatchObject({ disabled: true });
    expect(explode([ref(ids[0]!), ref(ids[1]!)])).toMatchObject({ disabled: true });
    const item = explode([ref(ids[0]!)])!;
    expect(item).toMatchObject({ command: 'sketch.explodeCurve', params: { curveId: a }, disabled: false });
    registry.execute(item.command, item.params);
    const sketch = host.doc.rootDefinition.entities.sketch;
    expect(sketch.curves.has(a as never)).toBe(false);
    expect(sketch.curves.has(b as never)).toBe(true);
    // Body edges and edges drawn on a body's faces are matched by their own curve.
    host.doc.transact('bodies', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.set(7 as Id, {
        id: 7, valid: true, tagId: draft.defaultTagId, faces: new Map(), curves: new Map(),
        edges: new Map([['0:1:0', { curveId: 11 }]]),
        imprints: new Map([[0, { edges: new Map([[3, { curveId: 11 }]]) }]]),
      } as never);
    });
    const bodyEdge: EntityRef = { kind: 'edge', path: [], id: 7 as Id, edgeKey: '0:1:0' };
    const imprint: EntityRef = { kind: 'imprintEdge', path: [], id: 7 as Id, faceId: 0 as never, edgeId: 3 };
    expect(explode([bodyEdge, imprint])).toMatchObject({ params: { curveId: 11 }, disabled: false });
  });

  it('Intersect Faces: With Model for faces, With Selection also needing a solid; shown unavailable for edges alone', () => {
    const { host } = setup();
    const face: EntityRef = { kind: 'face', path: [], id: 7 as Id, faceId: 0 as never, region: null };
    const body: EntityRef = { kind: 'body', path: [], id: 8 as Id };
    const edge: EntityRef = { kind: 'edge', path: [], id: 7 as Id, edgeKey: '0:1:0' };
    const intersect = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Intersect Faces')!;
    const onFace = intersect([face]);
    expect(onFace.children!.map((c) => [c.label, c.disabled])).toEqual([['With Model', false], ['With Selection', true]]);
    expect(onFace.children![0]).toMatchObject({ command: 'intersect.faces', params: { refs: [face], with: 'model' } });
    const withSolid = intersect([face, body]);
    expect(withSolid.children!.map((c) => c.disabled)).toEqual([false, false]);
    expect(withSolid.children![1]).toMatchObject({ params: { refs: [face, body], with: 'selection' } });
    expect(intersect([edge]).children!.map((c) => c.disabled)).toEqual([true, true]);
    expect(intersect([face, edge]).children!.map((c) => c.disabled)).toEqual([false, true]);
  });

  it('Flip Along Red, Green, Blue for solids, groups and components, unavailable while one of them is locked', () => {
    const { host } = setup();
    const { group, comp } = addInstances(host);
    const body: EntityRef = { kind: 'body', path: [], id: 7 as Id };
    const g: EntityRef = { kind: 'instance', path: [], id: group };
    const c: EntityRef = { kind: 'instance', path: [], id: comp }; // locked
    const flip = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Flip Along')!;
    const onBody = flip([body]);
    expect(onBody.children!.map((i) => i.label)).toEqual(['Red', 'Green', 'Blue']);
    expect(onBody.children!.map((i) => i.params)).toEqual([{ refs: [body], axis: 'x' }, { refs: [body], axis: 'y' }, { refs: [body], axis: 'z' }]);
    expect(onBody.children!.every((i) => i.command === 'edit.flipAlong' && !i.disabled)).toBe(true);
    expect(flip([g]).children!.every((i) => !i.disabled)).toBe(true);
    expect(flip([g, c]).children!.every((i) => i.disabled)).toBe(true);
  });

  it('Solid Tools: the pair operations for exactly two solids in selection order, Outer Shell for two or more', () => {
    const { host } = setup();
    host.doc.transact('bodies', (draft) => {
      const bodies = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies;
      for (const [id, valid] of [[7, true], [8, true], [9, true], [10, false]] as const)
        bodies.set(id as Id, { id, valid, tagId: draft.defaultTagId, faces: new Map(), edges: new Map(), imprints: new Map() } as never);
    });
    const body = (id: number): EntityRef => ({ kind: 'body', path: [], id: id as Id });
    const tools = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Solid Tools')!.children!;
    const enabled = (refs: EntityRef[]) => tools(refs).filter((i) => !i.disabled).map((i) => i.label);
    expect(tools([body(7)]).map((i) => i.label)).toEqual(['Union', 'Subtract', 'Trim', 'Intersect', 'Split', 'Outer Shell']);
    expect(enabled([body(7)])).toEqual([]);
    expect(enabled([body(8), body(7)])).toEqual(['Union', 'Subtract', 'Trim', 'Intersect', 'Split', 'Outer Shell']);
    expect(tools([body(8), body(7)])[1]).toMatchObject({ command: 'solids.subtract', params: { a: { kind: 'body', path: [], id: 8 }, b: { kind: 'body', path: [], id: 7 } } });
    expect(enabled([body(7), body(8), body(9)])).toEqual(['Outer Shell']);
    expect(tools([body(7), body(8), body(9)])[5]).toMatchObject({ command: 'solids.outerShell', params: { bodies: [7, 8, 9].map((id) => ({ kind: 'body', path: [], id })) } });
    expect(enabled([body(7), body(10)])).toEqual([]); // not a solid
    expect(enabled([body(7), body(99)])).toEqual([]); // gone
  });

  it('Select: All on Same Tag for one shared tag, All with Same Material for faces with one front material', () => {
    const { host, registry } = setup();
    registry.registerAll(tagCommands);
    registry.registerAll(materialCommands);
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    registry.execute('sketch.rectangle', { a: [2, 0, 0], b: [3, 0, 0], c: [3, 1, 0], d: [2, 1, 0] });
    const sketch = host.doc.rootDefinition.entities.sketch;
    const [e1, e2] = [...sketch.edges.keys()];
    const [f1, f2] = [...sketch.faces.keys()];
    const tag = host.doc.state.defaultTagId;
    const edge = (id: Id): EntityRef => ({ kind: 'sketchEdge', path: [], id });
    const face = (id: Id): EntityRef => ({ kind: 'sketchFace', path: [], id });
    const select = (refs: EntityRef[]) => {
      const children = contextMenu.itemsFor(host.doc.state, refs).find((i) => i.label === 'Select')!.children!;
      return { tag: children.find((i) => i.label === 'All on Same Tag')!, material: children.find((i) => i.label === 'All with Same Material')! };
    };
    expect(select([edge(e1!), edge(e2!)]).tag).toMatchObject({ command: 'tag.selectAll', params: { id: tag }, disabled: false });
    expect(select([face(f1!), face(f2!)]).tag).toMatchObject({ params: { id: tag }, disabled: false });
    expect(select([edge(e1!)]).material.disabled).toBe(true); // edges have no material
    const unpainted = select([face(f1!), face(f2!)]).material;
    expect(unpainted).toMatchObject({ command: 'material.selectFaces', params: { id: null }, disabled: false });
    host.doc.transact('paint and tag', (draft) => {
      const s = draft.definitions.get(draft.rootDefinitionId)!.entities.sketch;
      s.faces.get(f2!)!.frontMaterialId = 5 as never;
      s.faces.get(f2!)!.backMaterialId = 5 as never; // material.selectFaces matches either side
      s.edges.get(e2!)!.tagId = 77 as never;
    });
    expect(select([face(f1!), face(f2!)]).material.disabled).toBe(true);
    expect(select([face(f2!)]).material).toMatchObject({ params: { id: 5 }, disabled: false });
    expect(select([edge(e1!), edge(e2!)]).tag.disabled).toBe(true);
    expect(select([{ kind: 'sketchVertex', path: [], id: 1 as Id }]).tag.disabled).toBe(true);
    // The items run their commands: the unpainted face and every entity on the default tag.
    const run = (item: ContextMenuItem) => registry.execute(item.command, item.params);
    run(select([face(f1!)]).material);
    expect(host.selection.refs).toEqual([face(f1!)]);
    run(select([face(f1!)]).tag);
    expect(host.selection.refs.some((r) => r.kind === 'sketchEdge' && r.id === e2)).toBe(false);
    expect(host.selection.refs.some((r) => r.kind === 'sketchEdge' && r.id === e1)).toBe(true);
  });

  it('mixed kinds fall back to the shared items', () => {
    const { host } = setup();
    const { group } = addInstances(host);
    const refs: EntityRef[] = [
      { kind: 'instance', path: [], id: group },
      { kind: 'body', path: [], id: 7 as Id },
    ];
    expect(labels(contextMenu.itemsFor(host.doc.state, refs))).toEqual(['Entity Info', 'Erase', 'Make Group', 'Make Component…', 'Zoom Selection']);
  });
});
