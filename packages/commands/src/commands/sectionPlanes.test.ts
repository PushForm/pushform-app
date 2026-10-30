// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Mat4 } from '@pushform/core';
import { m4translation } from '@pushform/core';
import { containerAt, type EntityRef } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { groupCommands, type MakeResult } from './groups';
import { contextMenu } from './contextMenu';
import { nextSectionPlaneName, sectionPlaneCommands } from './sectionPlanes';
import { SectionPlaneTool } from '../tools/impl/SectionPlane';
import { NO_MODIFIERS, type ToolContext, type ToolPointerEvent } from '../tools/Tool';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(sectionPlaneCommands);
  const add = (point: [number, number, number], normal: [number, number, number] = [0, 0, -1]): number =>
    s.registry.execute('sectionPlane.add', { point, normal }) as number;
  const plane = (id: number, path: number[] = []) => containerAt(s.host.doc.state, path as Id[]).sectionPlanes.get(id as Id)!;
  const active = (path: number[] = []) => containerAt(s.host.doc.state, path as Id[]).activeSectionPlaneId;
  const ref = (id: number, path: number[] = []): EntityRef => ({ kind: 'sectionPlane', path: path as Id[], id: id as Id });
  return { ...s, add, plane, active, ref };
}

describe('section plane commands', () => {
  it('places numbered planes as the active cut and selects them', () => {
    const { add, plane, active, host, ref } = setup();
    const a = add([0, 0, 1]);
    expect(plane(a)).toMatchObject({ name: 'Section 1', symbol: '1', plane: { n: [0, 0, -1], d: 1 } });
    expect(active()).toBe(a);
    expect(host.selection.refs).toEqual([ref(a)]);
    const b = add([0, 0, 2]);
    expect(plane(b)).toMatchObject({ name: 'Section 2', symbol: '2' });
    expect(active()).toBe(b);
  });

  it('places a plane inside an open group in the group\'s coordinates', () => {
    const { registry, host, addBox, bodies, add, plane, active } = setup();
    addBox();
    registry.execute('selection.set', { refs: [{ kind: 'body', path: [], id: bodies()[0]!.id }] });
    const made = registry.execute('group.make', {}) as MakeResult;
    const inst = made.instanceId as Id;
    host.doc.transact('move', (d) => { containerAt(d as never, []).instances.get(inst)!.transform = m4translation([10, 0, 0]) as unknown as Mat4; });
    registry.execute('context.enter', { path: [inst] });
    const id = add([10.5, 0.5, 0.5], [1, 0, 0]);
    expect(plane(id, [inst]).origin).toEqual([0.5, 0.5, 0.5]);
    expect(active([inst])).toBe(id);
    expect(active()).toBeNull();
  });

  it('toggles the active cut, reverses, hides, renames, and erases with one undo step each', () => {
    const { registry, host, add, plane, active, ref } = setup();
    const a = add([0, 0, 1]);
    const steps = host.undoStack.length;
    registry.execute('sectionPlane.setActive', { path: [], id: a, active: false });
    expect(active()).toBeNull();
    registry.execute('sectionPlane.setActive', { path: [], id: a, active: true });
    registry.execute('sectionPlane.reverse', { refs: [{ path: [], id: a }] });
    expect(plane(a).plane).toEqual({ n: [0, 0, 1], d: -1 });
    registry.execute('sectionPlane.setHidden', { refs: [{ path: [], id: a }], hidden: true });
    expect(plane(a).hidden).toBe(true);
    expect(host.selection.isEmpty).toBe(true);
    registry.execute('sectionPlane.rename', { path: [], id: a, name: 'Long section', symbol: 'A' });
    expect(plane(a)).toMatchObject({ name: 'Long section', symbol: 'A' });
    expect(host.undoStack.length).toBe(steps + 5);
    registry.execute('selection.set', { refs: [ref(a)] });
    registry.execute('edit.delete');
    expect(containerAt(host.doc.state, []).sectionPlanes.size).toBe(0);
    expect(active()).toBeNull();
    host.undo();
    expect(plane(a).name).toBe('Long section');
    expect(active()).toBe(a);
  });

  it('moves with Move and copies as an inactive plane', async () => {
    const { add, plane, active, apply, root, ref } = setup();
    const a = add([0, 0, 1]);
    await apply({ refs: [ref(a)], matrix: m4translation([0, 0, 2]), copy: false });
    expect(plane(a).plane.d).toBeCloseTo(3, 9);
    expect(plane(a).plane.n).toEqual([0, 0, -1]);
    await apply({ refs: [ref(a)], matrix: m4translation([0, 0, 1]), copy: true });
    const ids = [...root().sectionPlanes.keys()];
    expect(ids).toHaveLength(2);
    expect(active()).toBe(a);
  });

  it('names a new plane after the lowest unused number', () => {
    const { add, host } = setup();
    add([0, 0, 1]);
    const b = add([0, 0, 2]);
    host.doc.transact('rename', (d) => { containerAt(d as never, []).sectionPlanes.get(b as Id)!.symbol = 'B'; });
    expect(nextSectionPlaneName(host.doc.state)).toEqual({ name: 'Section 3', symbol: '3' });
  });

  it('offers Erase, Hide, Reverse, Active Cut and Align View in the context menu', () => {
    const { add, host, ref } = setup();
    const a = add([0, 0, 1]);
    const items = contextMenu.itemsFor(host.doc.state, [ref(a)]);
    expect(items.map((i) => i.label)).toEqual(['Entity Info', 'Erase', 'Hide', 'Reverse', 'Active Cut', 'Align View']);
    expect(items[4]).toMatchObject({ command: 'sectionPlane.setActive', params: { path: [], id: a, active: false }, checked: true });
    const b = add([0, 0, 2]);
    expect(contextMenu.itemsFor(host.doc.state, [ref(a)])[4]).toMatchObject({ params: { active: true }, checked: false });
    expect(contextMenu.itemsFor(host.doc.state, [ref(a), ref(b)]).map((i) => i.label)).toEqual(['Entity Info', 'Erase', 'Hide', 'Reverse']);
  });

  it('aligns the view to look at the plane from the side it cuts away', () => {
    const { add, registry, camera } = setup();
    const a = add([0, 0, 1], [0, 0, -1]);
    registry.execute('sectionPlane.alignView', { path: [], id: a });
    const s = camera.getState();
    expect(s.target[2]).toBeCloseTo(1, 9);
    expect(s.eye[2]).toBeGreaterThan(1);
  });

  it('the tool places a plane in the face under the cursor, pointing into it, or along a held axis', () => {
    const { registry, camera, plane, active } = setup();
    const tool = new SectionPlaneTool();
    const ctx: ToolContext = { commands: registry, camera, requestRender: () => {}, statusChanged: () => {} };
    tool.activate(ctx);
    const event = (normal: [number, number, number] | null, button = 0): ToolPointerEvent => ({
      screen: [0, 0], ray: { origin: [0, 0, 10], dir: [0, 0, -1] }, button, buttons: 0, modifiers: NO_MODIFIERS, camera: camera.getState(),
      inference: { point: [1, 1, 1], primary: { kind: 'onFace', point: [1, 1, 1] }, lines: [], hit: normal ? { normal } : null } as never,
    });
    tool.onPointerMove(event([0, 0, 1], -1));
    expect(tool.overlay().length).toBeGreaterThan(0);
    tool.onPointerDown(event([0, 0, 1]));
    const id = active()!;
    expect(plane(id).plane.n).toEqual([0, 0, -1]);
    // Up holds the blue axis whatever lies under the cursor
    tool.onKeyDown({ key: 'ArrowUp', code: 'ArrowUp', modifiers: NO_MODIFIERS, repeat: false });
    tool.onPointerDown(event([1, 0, 0]));
    expect(Math.abs(plane(active()!).plane.n[2])).toBeCloseTo(1, 9);
  });
});
