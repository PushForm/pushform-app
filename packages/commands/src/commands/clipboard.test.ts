// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { DefId, Id, Mat4, MaterialId, Vec3 } from '@pushform/core';
import { m4translation, meshBounds } from '@pushform/core';
import { containerAt, type Body, type EntityRef } from '@pushform/model';
import { z } from 'zod';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { groupCommands, type MakeResult } from './groups';
import { clipboardCommands, clipboardExtentPoints, modelClipboard, type CopyResult } from './clipboard';
import { PasteTool } from '../tools/impl/Paste';
import type { ToolContext, ToolPointerEvent } from '../tools/Tool';
import { NO_MODIFIERS } from '../tools/Tool';

afterEach(() => {
  modelClipboard.set(null);
  disposeKernels();
});

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(clipboardCommands);
  const select = (refs: EntityRef[]): void => {
    s.registry.execute('selection.set', { refs });
  };
  const bodyRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'body', path: path as Id[], id: id as Id });
  const instanceRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'instance', path: path as Id[], id: id as Id });
  return { ...s, select, bodyRef, instanceRef };
}

const minOf = (b: Body): Vec3 => {
  const { min } = meshBounds(b.mesh);
  return [min[0], min[1], min[2]];
};

describe('edit.copy / edit.paste', () => {
  it('copies without changing the document and pastes in place as one undoable step', () => {
    const a = setup();
    const box = a.addBox([1, 2, 0], [2, 3, 1]);
    a.select([a.bodyRef(box)]);
    const entries = a.host.undoStack.length;
    expect((a.registry.execute('edit.copy') as CopyResult).skipped).toBe(0);
    expect(a.host.undoStack.length).toBe(entries);
    expect(modelClipboard.current?.insertionPoint).toEqual([1, 2, 0]);

    const refs = a.registry.execute('edit.pasteInPlace') as EntityRef[];
    expect(refs).toHaveLength(1);
    expect(a.bodies()).toHaveLength(2);
    const pasted = a.body(refs[0]!.id);
    expect(pasted.id).not.toBe(box);
    expect(minOf(pasted)).toEqual([1, 2, 0]);
    expect(a.host.selection.refs).toEqual(refs);
    expect(a.host.undoStack.length).toBe(entries + 1);
    a.host.undo();
    expect(a.bodies()).toHaveLength(1);
  });

  it('pastes with the bounding-box corner on the clicked point', () => {
    const a = setup();
    const box = a.addBox([1, 2, 0], [2, 3, 1]);
    a.select([a.bodyRef(box)]);
    a.registry.execute('edit.copy');
    const refs = a.registry.execute('edit.pasteAt', { point: [5, 5, 0] }) as EntityRef[];
    expect(minOf(a.body(refs[0]!.id))).toEqual([5, 5, 0]);
  });

  it('pastes into another model, reusing the pasted definition on a second paste', () => {
    const a = setup(), b = setup();
    const box = a.addBox([0, 0, 0], [1, 1, 1]);
    a.select([a.bodyRef(box)]);
    const made = a.registry.execute('group.make', {}) as MakeResult;
    a.select([a.instanceRef(made.instanceId!)]);
    a.registry.execute('edit.copy');
    // a lone group is held at its origin
    expect(modelClipboard.current?.insertionPoint).toEqual([0, 0, 0]);

    const defsBefore = b.host.doc.state.definitions.size;
    b.registry.execute('edit.pasteAt', { point: [3, 0, 0] });
    b.registry.execute('edit.pasteAt', { point: [6, 0, 0] });
    const insts = [...b.root().instances.values()];
    expect(insts).toHaveLength(2);
    expect(insts[0]!.definitionId).toBe(insts[1]!.definitionId);
    expect(b.host.doc.state.definitions.size).toBe(defsBefore + 1);
    const def = b.host.doc.state.definitions.get(insts[0]!.definitionId)!;
    expect(def.guid).toBe(a.host.doc.state.definitions.get(made.definitionId as DefId)!.guid);
    expect(def.entities.bodies.size).toBe(1);
    expect(insts[1]!.transform[12]).toBe(6);

    // within the source model a pasted group is another instance of its definition
    a.registry.execute('edit.pasteInPlace');
    expect([...a.root().instances.values()].map((i) => i.definitionId)).toEqual([made.definitionId, made.definitionId]);
  });

  it('matches materials by name and properties, renaming a different one', () => {
    const a = setup(), b = setup();
    const box = a.addBox();
    const red = 900 as MaterialId, other = 901 as MaterialId;
    a.host.doc.transact('material', (draft) => {
      draft.materials.set(red, { id: red, name: 'Red', color: [1, 0, 0], alpha: 1, texture: null });
      draft.meta.nextId = 1000;
      containerAt(draft as never, []).bodies.get(box as Id)!.materialId = red;
    });
    b.host.doc.transact('material', (draft) => {
      draft.materials.set(other, { id: other, name: 'Red', color: [0.9, 0, 0], alpha: 1, texture: null });
      draft.meta.nextId = 1000;
    });
    a.select([a.bodyRef(box)]);
    a.registry.execute('edit.copy');
    const [ref] = b.registry.execute('edit.pasteInPlace') as EntityRef[];
    const pasted = b.body(ref!.id);
    const material = b.host.doc.state.materials.get(pasted.materialId!)!;
    expect(material.name).toBe('Red#1');
    expect(material.color).toEqual([1, 0, 0]);
    // the same material pasted again is reused
    const [again] = b.registry.execute('edit.pasteInPlace') as EntityRef[];
    expect(b.body(again!.id).materialId).toBe(pasted.materialId);
    expect([...b.host.doc.state.materials.values()].filter((m) => m.name.startsWith('Red'))).toHaveLength(2);
  });

  it('copies a face of a solid as a sheet face with its edges', () => {
    const a = setup();
    const box = a.addBox([0, 0, 0], [1, 1, 1]);
    const top = [...a.body(box).faces.values()].find((f) => f.plane.n[2] === 1)!;
    a.select([{ kind: 'face', path: [], id: box as Id, faceId: top.id, region: null }]);
    a.registry.execute('edit.copy');
    const refs = a.registry.execute('edit.pasteAt', { point: [3, 0, 0] }) as EntityRef[];
    expect(refs.filter((r) => r.kind === 'sketchEdge')).toHaveLength(4);
    expect(refs.filter((r) => r.kind === 'sketchFace')).toHaveLength(1);
    const sketch = a.root().sketch;
    const zs = [...sketch.vertices.values()].map((v) => v.p[2]);
    // held at its lowest corner, the face lands on the clicked point
    expect(zs.every((z) => z === 0)).toBe(true);
    expect(Math.min(...[...sketch.vertices.values()].map((v) => v.p[0]))).toBe(3);
    expect(a.bodies()).toHaveLength(1);
  });

  it('cut copies and erases as one undoable step; paste in place restores the position', () => {
    const a = setup();
    const box = a.addBox([1, 1, 0], [2, 2, 1]);
    a.select([a.bodyRef(box)]);
    const entries = a.host.undoStack.length;
    a.registry.execute('edit.cut');
    expect(a.bodies()).toHaveLength(0);
    expect(a.host.undoStack.length).toBe(entries + 1);
    a.registry.execute('edit.pasteInPlace');
    expect(minOf(a.bodies()[0]!)).toEqual([1, 1, 0]);
    a.host.undo();
    a.host.undo();
    expect(a.bodies().map((b) => b.id)).toEqual([box]);
  });

  it('copies in world coordinates from inside a moved group and pastes in place in another context', () => {
    const a = setup();
    const box = a.addBox([0, 0, 0], [1, 1, 1]);
    a.select([a.bodyRef(box)]);
    const made = a.registry.execute('group.make', {}) as MakeResult;
    a.host.doc.transact('move', (draft) => {
      containerAt(draft as never, []).instances.get(made.instanceId as Id)!.transform = m4translation([10, 0, 0]) as unknown as Mat4;
    });
    a.registry.execute('context.enter', { path: [made.instanceId] });
    const inner = [...a.host.doc.state.definitions.get(made.definitionId as DefId)!.entities.bodies.keys()][0]!;
    a.select([a.bodyRef(inner, [made.instanceId!])]);
    a.registry.execute('edit.copy');
    expect(modelClipboard.current?.bounds.min).toEqual([10, 0, 0]);
    // pasting in place inside the group keeps the world position
    const [inside] = a.registry.execute('edit.pasteInPlace') as EntityRef[];
    expect(minOf(containerAt(a.host.doc.state, [made.instanceId as Id]).bodies.get(inside!.id)!)).toEqual([0, 0, 0]);
    a.registry.execute('context.exit');
    const [outside] = a.registry.execute('edit.pasteInPlace') as EntityRef[];
    expect(minOf(a.body(outside!.id))).toEqual([10, 0, 0]);
  });

  it('refuses to paste a group inside itself', () => {
    const a = setup();
    const box = a.addBox();
    a.select([a.bodyRef(box)]);
    const made = a.registry.execute('group.make', {}) as MakeResult;
    a.select([a.instanceRef(made.instanceId!)]);
    a.registry.execute('edit.copy');
    a.registry.execute('context.enter', { path: [made.instanceId] });
    const entries = a.host.undoStack.length;
    expect(() => a.registry.execute('edit.pasteInPlace')).toThrow(/inside itself/);
    expect(a.host.undoStack.length).toBe(entries);
  });

  it('frames the copy by the bounding-box corners of what it holds', () => {
    const a = setup();
    const box = a.addBox([0, 0, 0], [1, 2, 3]);
    a.select([a.bodyRef(box)]);
    a.registry.execute('edit.copy');
    const points = clipboardExtentPoints(modelClipboard.current!);
    expect(points).toHaveLength(8);
    expect(points).toContainEqual([1, 2, 3]);
  });

  it('commands are disabled with nothing selected or nothing copied', () => {
    const a = setup();
    expect(a.registry.isEnabled('edit.copy')).toBe(false);
    expect(a.registry.isEnabled('edit.paste')).toBe(false);
    expect(a.registry.isEnabled('edit.pasteInPlace')).toBe(false);
  });
});

describe('PasteTool', () => {
  it('previews the copy at the cursor and places it with a click, then returns to Select', () => {
    const a = setup();
    let selected = false;
    a.registry.register({ id: 'tool.select', title: 'Select', category: 'tool', params: z.object({}), undoable: false, run: () => { selected = true; } });
    const box = a.addBox([0, 0, 0], [1, 1, 1]);
    a.select([a.bodyRef(box)]);
    a.registry.execute('edit.copy');
    const tool = new PasteTool();
    const ctx: ToolContext = { commands: a.registry, camera: a.camera, requestRender: () => {}, statusChanged: () => {} };
    tool.activate(ctx);
    const event = (point: Vec3, button: number): ToolPointerEvent => ({
      screen: [0, 0], ray: { origin: [0, 0, 10], dir: [0, 0, -1] }, button, buttons: 0, modifiers: NO_MODIFIERS,
      inference: { point, primary: { kind: 'none', point }, lines: [], hit: null } as never, camera: a.camera.getState(),
    });
    tool.onPointerMove(event([4, 0, 0], -1));
    expect(tool.overlay().length).toBeGreaterThan(0);
    expect(a.bodies()).toHaveLength(1);
    tool.onPointerDown(event([4, 0, 0], 0));
    expect(a.bodies()).toHaveLength(2);
    expect(selected).toBe(true);
    expect(minOf(a.body(a.host.selection.refs[0]!.id))).toEqual([4, 0, 0]);
  });
});
