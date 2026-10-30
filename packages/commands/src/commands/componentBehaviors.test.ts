// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Mat4 } from '@pushform/core';
import { m4transformDir, m4transformPoint, m4translation, planeDistance } from '@pushform/core';
import { contextMatrix, instanceAt, sketchFaceLoops, type EntityRef } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { guideCommands } from './guides';
import { groupCommands, type MakeResult } from './groups';
import { componentBehaviorCommands, glueAllows, glueFaceAt } from './componentBehaviors';
import { contextMenu } from './contextMenu';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(componentBehaviorCommands);
  s.registry.registerAll(guideCommands);
  const instanceRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'instance', path: path as Id[], id: id as Id });
  const bodyRef = (id: number): EntityRef => ({ kind: 'body', path: [], id: id as Id });
  const state = () => s.host.doc.state;
  /** World positions of every body vertex and sketch vertex inside instance `id`. */
  const worldPoints = (id: number): number[][] => {
    const inst = instanceAt(state(), [id as Id])!;
    const def = state().definitions.get(inst.definitionId)!;
    const m = contextMatrix(state(), [id as Id]);
    const pts: number[][] = [];
    for (const b of def.entities.bodies.values()) for (let i = 0; i < b.mesh.verts.length; i += 3) pts.push(m4transformPoint(m, [b.mesh.verts[i]!, b.mesh.verts[i + 1]!, b.mesh.verts[i + 2]!]));
    for (const v of def.entities.sketch.vertices.values()) pts.push(m4transformPoint(m, v.p));
    for (const g of def.entities.guides.values()) if (g.kind === 'point') pts.push(m4transformPoint(m, g.origin));
    return pts.map((p) => p.map((x) => Math.round(x * 1e6) / 1e6)).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
  };
  const makeComponent = (refs: EntityRef[], params: Record<string, unknown> = {}): MakeResult => {
    s.registry.execute('selection.set', { refs });
    return s.registry.execute('component.make', params) as MakeResult;
  };
  return { ...s, instanceRef, bodyRef, state, worldPoints, makeComponent };
}

const close = (a: readonly number[], b: readonly number[]): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));

describe('component axes', () => {
  it('makes a component with picked axes: the placement is the picked frame and nothing moves', () => {
    const { registry, bodyRef, worldPoints, makeComponent, state } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [2, 1, 1] }) as number;
    const before = (() => {
      const b = state().definitions.get(state().rootDefinitionId)!.entities.bodies.get(box as Id)!;
      const pts: number[][] = [];
      for (let i = 0; i < b.mesh.verts.length; i += 3) pts.push([b.mesh.verts[i]!, b.mesh.verts[i + 1]!, b.mesh.verts[i + 2]!]);
      return pts.map((p) => p.map((x) => Math.round(x * 1e6) / 1e6)).sort((a, c) => a[0]! - c[0]! || a[1]! - c[1]! || a[2]! - c[2]!);
    })();
    // origin at (2, 0, 0), red along +y, green along -x
    const made = makeComponent([bodyRef(box)], { name: 'Turned', axesOrigin: [2, 0, 0], axesX: [0, 1, 0], axesY: [-1, 0, 0] });
    const inst = instanceAt(state(), [made.instanceId as Id])!;
    close(m4transformPoint(inst.transform, [0, 0, 0]), [2, 0, 0]);
    close(m4transformDir(inst.transform, [1, 0, 0]), [0, 1, 0]);
    close(m4transformDir(inst.transform, [0, 0, 1]), [0, 0, 1]);
    expect(worldPoints(made.instanceId!)).toEqual(before);
  });

  it('Change Axes re-expresses the definition, adjusts every placement, keeps the model in place, and undoes in one step', () => {
    const { host, registry, bodyRef, instanceRef, worldPoints, makeComponent, state } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const made = makeComponent([bodyRef(box)], { name: 'Box' });
    registry.execute('context.enter', { path: [made.instanceId!] });
    registry.execute('guides.addPoint', { point: [0.5, 0.5, 1] });
    registry.execute('context.exit', {});
    // a second placement of the same component
    host.doc.transact('copy', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities;
      const src = root.instances.get(made.instanceId as Id)!;
      root.instances.set(900 as Id, { ...src, id: 900 as Id, transform: m4translation([5, 0, 0]) as unknown as Mat4 });
      root.order.push(900 as Id);
    });
    const firstBefore = worldPoints(made.instanceId!), secondBefore = worldPoints(900);
    const entries = host.undoStack.length;

    registry.execute('component.changeAxes', { ref: instanceRef(made.instanceId!), origin: [1, 1, 0], x: [0, 1, 0], y: [-1, 0, 0] });

    expect(worldPoints(made.instanceId!)).toEqual(firstBefore);
    expect(worldPoints(900)).toEqual(secondBefore);
    const def = state().definitions.get(made.definitionId as never)!;
    const body = [...def.entities.bodies.values()][0]!;
    // the picked origin is now the definition's origin: locally the box spans x in [-1, 0] (red is world +y) and y in [0, 1] (green is world -x)
    const xs = [], ys = [];
    for (let i = 0; i < body.mesh.verts.length; i += 3) {
      xs.push(body.mesh.verts[i]!);
      ys.push(body.mesh.verts[i + 1]!);
    }
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([expect.closeTo(-1, 9), expect.closeTo(0, 9)]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([expect.closeTo(0, 9), expect.closeTo(1, 9)]);
    close(m4transformPoint(instanceAt(state(), [made.instanceId as Id])!.transform, [0, 0, 0]), [1, 1, 0]);
    expect(host.undoStack.length).toBe(entries + 1);
    host.undo();
    expect(worldPoints(made.instanceId!)).toEqual(firstBefore);
    close(m4transformPoint(instanceAt(state(), [made.instanceId as Id])!.transform, [0, 0, 0]), [0, 0, 0]);
  });

  it('Change Axes keeps sketch faces, their ids and their planes in place', () => {
    const { registry, instanceRef, worldPoints, makeComponent, state } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [2, 0, 0], c: [2, 1, 0], d: [0, 1, 0] });
    const root = state().definitions.get(state().rootDefinitionId)!.entities;
    const faceId = [...root.sketch.faces.keys()][0]!;
    const made = makeComponent([{ kind: 'sketchFace', path: [], id: faceId }], { name: 'Mat' });
    const before = worldPoints(made.instanceId!);
    const def = () => state().definitions.get(made.definitionId as never)!;
    const ids = [...def().entities.sketch.faces.keys()];
    registry.execute('component.changeAxes', { ref: instanceRef(made.instanceId!), origin: [2, 1, 0], x: [-1, 0, 0], y: [0, -1, 0] });
    expect(worldPoints(made.instanceId!)).toEqual(before);
    expect([...def().entities.sketch.faces.keys()]).toEqual(ids);
    const face = def().entities.sketch.faces.get(ids[0]!)!;
    for (const loop of sketchFaceLoops(def().entities.sketch, face)) for (const p of loop) expect(Math.abs(planeDistance(face.plane, p))).toBeLessThan(1e-9);
  });

  it('refuses groups and locked components', () => {
    const { registry, bodyRef, instanceRef, makeComponent } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    registry.execute('selection.set', { refs: [bodyRef(box)] });
    const group = registry.execute('group.make', {}) as MakeResult;
    expect(() => registry.execute('component.changeAxes', { ref: instanceRef(group.instanceId!), origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] })).toThrow(/components, not groups/);
    const box2 = registry.execute('model.addBox', { min: [3, 0, 0], max: [4, 1, 1] }) as number;
    const made = makeComponent([bodyRef(box2)]);
    registry.execute('instance.setLocked', { refs: [instanceRef(made.instanceId!)], locked: true });
    expect(() => registry.execute('component.changeAxes', { ref: instanceRef(made.instanceId!), origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] })).toThrow(/locked/);
  });
});

describe('glue', () => {
  it('judges face orientations for each Glue To setting', () => {
    expect(glueAllows('none', [0, 0, 1])).toBe(false);
    expect(glueAllows('any', [0.3, 0.2, 0.9])).toBe(true);
    expect(glueAllows('horizontal', [0, 0, -1])).toBe(true);
    expect(glueAllows('horizontal', [0, 1, 0])).toBe(false);
    expect(glueAllows('vertical', [0, 1, 0])).toBe(true);
    expect(glueAllows('vertical', [0, 0.02, 1])).toBe(false);
    expect(glueAllows('sloped', [0, 0.7, 0.7])).toBe(true);
    expect(glueAllows('sloped', [1, 0, 0])).toBe(false);
  });

  it('glues a component made on a floor face, unless the face has the wrong orientation', () => {
    const { registry, state, makeComponent, bodyRef } = setup();
    registry.execute('sketch.rectangle', { a: [-5, -5, 0], b: [5, -5, 0], c: [5, 5, 0], d: [-5, 5, 0] });
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const made = makeComponent([bodyRef(box)], { name: 'Chair', glueTo: 'horizontal' });
    expect(instanceAt(state(), [made.instanceId as Id])!.gluedPlane).toMatchObject({ n: [0, 0, 1] });
    const box2 = registry.execute('model.addBox', { min: [2, 2, 0], max: [3, 3, 1] }) as number;
    const wall = makeComponent([bodyRef(box2)], { name: 'Window', glueTo: 'vertical' });
    expect(instanceAt(state(), [wall.instanceId as Id])!.gluedPlane).toBeUndefined();
  });

  it('finds no glue face when the origin lies outside every face', () => {
    const { registry, state } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const root = state().definitions.get(state().rootDefinitionId)!.entities;
    expect(glueFaceAt(root, 'any', [0.5, 0.5, 0], [0, 0, 1], (n) => n)).not.toBeNull();
    expect(glueFaceAt(root, 'any', [3, 0.5, 0], [0, 0, 1], (n) => n)).toBeNull();
    expect(glueFaceAt(root, 'any', [0.5, 0.5, 0], [1, 0, 0], (n) => n)).toBeNull();
  });

  it('places a component on a wall: origin on the point, blue axis along the normal, red kept level; glued; one undo step', () => {
    const { host, registry, state, makeComponent, bodyRef, instanceRef } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 0.2, 1] }) as number;
    const made = makeComponent([bodyRef(box)], { name: 'Window', glueTo: 'vertical' });
    const entries = host.undoStack.length;
    registry.execute('component.placeOnFace', { ref: instanceRef(made.instanceId!), point: [4, 2, 1.5], normal: [-1, 0, 0] });
    const inst = instanceAt(state(), [made.instanceId as Id])!;
    close(m4transformPoint(inst.transform, [0, 0, 0]), [4, 2, 1.5]);
    close(m4transformDir(inst.transform, [0, 0, 1]), [-1, 0, 0]);
    expect(m4transformDir(inst.transform, [1, 0, 0])[2]).toBeCloseTo(0, 9);
    expect(inst.gluedPlane!.n).toEqual([-1, 0, 0]);
    expect(Math.abs(planeDistance(inst.gluedPlane!, [4, 7, -3]))).toBeLessThan(1e-9);
    expect(host.undoStack.length).toBe(entries + 1);
    host.undo();
    expect(instanceAt(state(), [made.instanceId as Id])!.gluedPlane).toBeUndefined();
  });

  it('copies onto a face with copy set, selecting the copy', () => {
    const { host, registry, state, makeComponent, bodyRef, instanceRef } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const made = makeComponent([bodyRef(box)], { glueTo: 'any' });
    const copy = registry.execute('component.placeOnFace', { ref: instanceRef(made.instanceId!), point: [0, 0, 3], normal: [0, 0, 1], copy: true }) as EntityRef;
    expect(copy.id).not.toBe(made.instanceId);
    expect(state().definitions.get(state().rootDefinitionId)!.entities.instances.size).toBe(2);
    expect(instanceAt(state(), [made.instanceId as Id])!.gluedPlane).toBeUndefined();
    expect(host.selection.refs).toEqual([copy]);
  });

  it('carries the glue plane with a transform and frees placements with Unglue', async () => {
    const { registry, state, makeComponent, bodyRef, instanceRef, apply } = setup();
    const box = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const made = makeComponent([bodyRef(box)], { glueTo: 'any' });
    registry.execute('component.placeOnFace', { ref: instanceRef(made.instanceId!), point: [0, 0, 2], normal: [0, 0, 1] });
    await apply({ refs: [instanceRef(made.instanceId!)], matrix: m4translation([0, 0, 1]), copy: false, label: 'Move' });
    expect(planeDistance(instanceAt(state(), [made.instanceId as Id])!.gluedPlane!, [0, 0, 3])).toBeCloseTo(0, 9);
    const menu = contextMenu.itemsFor(state(), [instanceRef(made.instanceId!)]).map((i) => i.label);
    expect(menu).toContain('Unglue');
    expect(menu).toContain('Change Axes');
    registry.execute('component.unglue', { refs: [instanceRef(made.instanceId!)] });
    expect(instanceAt(state(), [made.instanceId as Id])!.gluedPlane).toBeUndefined();
    expect(contextMenu.itemsFor(state(), [instanceRef(made.instanceId!)]).map((i) => i.label)).not.toContain('Unglue');
    expect(() => registry.execute('component.unglue', { refs: [instanceRef(made.instanceId!)] })).toThrow(/glued/);
  });
});

