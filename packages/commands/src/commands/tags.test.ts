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
import { addCurveToDraft, curveCommands, type AddCurveParams } from './curves';
import { tessellateCircle } from '@pushform/geom';

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
  registry.registerAll(curveCommands);
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

describe('drawing on the active tag', () => {
  const circle = (center: [number, number, number], r: number) => {
    const t = tessellateCircle(center, [0, 0, 1], r, 12, 0);
    return { points: t.points, closed: true, curve: t.curve };
  };

  it('curves put their edges and the faces they form on the active tag; Pie closing edges too', () => {
    const { registry, host } = setup();
    const tag = registry.execute('tag.create', { name: 'Trim' }) as number;
    registry.execute('tag.setActive', { id: tag });
    const sketch = () => host.doc.rootDefinition.entities.sketch;
    registry.execute('sketch.addCurve', circle([0, 0, 0], 1));
    const pts: [number, number, number][] = [[5, 0, 0], [5 + Math.SQRT1_2, Math.SQRT1_2, 0], [5, 1, 0]];
    registry.execute('sketch.addCurve', { points: pts, closed: false, curve: { kind: 'arc', center: [4, 0, 0], normal: [0, 0, 1], radius: 1, startAngle: 0, endAngle: Math.PI / 2, segments: 2 }, closeTo: [4, 0, 0] });
    expect(sketch().faces.size).toBe(2);
    expect([...sketch().edges.values()].every((e) => e.tagId === tag)).toBe(true);
    expect([...sketch().faces.values()].every((f) => f.tagId === tag)).toBe(true);
    // rectangles: the face goes on the active tag as well
    registry.execute('sketch.rectangle', { a: [10, 0, 0], b: [11, 0, 0], c: [11, 1, 0], d: [10, 1, 0] });
    expect([...sketch().faces.values()].every((f) => f.tagId === tag)).toBe(true);
  });

  it('the piece of a split face that takes over keeps its tag; re-tessellating a curve keeps its tags', () => {
    const { registry, host, state } = setup();
    const a = registry.execute('tag.create', { name: 'A' }) as number;
    const b = registry.execute('tag.create', { name: 'B' }) as number;
    const sketch = () => host.doc.rootDefinition.entities.sketch;
    registry.execute('tag.setActive', { id: a });
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [2, 0, 0], c: [2, 1, 0], d: [0, 1, 0] });
    const res = registry.execute('sketch.addCurve', circle([5, 0, 0], 1)) as { curveId: number };
    registry.execute('tag.setActive', { id: b });
    registry.execute('sketch.addEdge', { a: [1, 0, 0], b: [1, 1, 0] });
    const rectFaces = [...sketch().faces.values()].filter((f) => f.plane.n[2] !== 0 && f.loops[0]!.length === 4);
    expect(rectFaces).toHaveLength(2);
    // one piece takes over the face (and its tag); the other is a new face, on the active tag
    expect(rectFaces.map((f) => f.tagId).sort()).toEqual([a, b].sort());
    registry.execute('tag.setActive', { id: null });
    registry.execute('sketch.setCurveSegments', { curveId: res.curveId, segments: 20 });
    const curveEdges = [...sketch().edges.values()].filter((e) => e.curveId === res.curveId);
    expect(curveEdges).toHaveLength(20);
    expect(curveEdges.every((e) => e.tagId === a)).toBe(true);
    const curveFaces = [...sketch().faces.values()].filter((f) => !rectFaces.some((r) => r.id === f.id));
    expect(curveFaces).toHaveLength(1);
    expect(curveFaces[0]!.tagId).toBe(a);
    expect(state().defaultTagId).not.toBe(a);
  });

  it('addCurveToDraft without a tag (imports and other callers) leaves the default tag', () => {
    const { registry, host, state } = setup();
    const tag = registry.execute('tag.create', { name: 'Trim' }) as number;
    registry.execute('tag.setActive', { id: tag });
    host.edit('Import', (draft) => addCurveToDraft(draft, circle([0, 0, 0], 1) as AddCurveParams));
    const sketch = host.doc.rootDefinition.entities.sketch;
    expect(sketch.faces.size).toBe(1);
    expect([...sketch.edges.values()].every((e) => e.tagId === state().defaultTagId)).toBe(true);
    expect([...sketch.faces.values()].every((f) => f.tagId === state().defaultTagId)).toBe(true);
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
