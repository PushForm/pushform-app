// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@pushform/core';
import { containerAt, type EntityRef } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { groupCommands, type MakeResult } from './groups';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  const hide = (refs: EntityRef[], hidden = true): number => s.registry.execute('geometry.setHidden', { refs, hidden }) as number;
  return { ...s, hide };
}

describe('geometry.setHidden', () => {
  it('hides and unhides a face of a solid without touching its mesh, as one undo step, and deselects it', () => {
    const { host, registry, addBox, body, hide } = setup();
    const box = addBox();
    const before = body(box);
    const top = [...before.faces.values()].find((f) => f.plane.n[2] === 1)!;
    const face: EntityRef = { kind: 'face', path: [], id: box as Id, faceId: top.id, region: null };
    registry.execute('selection.set', { refs: [face] });
    const entries = host.undoStack.length;
    expect(hide([face])).toBe(1);
    expect(body(box).faces.get(top.id)!.hidden).toBe(true);
    expect(body(box).mesh).toBe(before.mesh);
    expect(body(box).version).toBe(before.version);
    expect(host.selection.isEmpty).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    // hiding what is already hidden changes nothing
    expect(hide([face])).toBe(0);
    expect(hide([face], false)).toBe(1);
    expect(body(box).faces.get(top.id)!.hidden).toBe(false);
    host.undo();
    expect(body(box).faces.get(top.id)!.hidden).toBe(true);
    host.undo();
    expect(body(box).faces.get(top.id)!.hidden).toBe(false);
  });

  it('hides a body edge and sketch edges and faces together', () => {
    const { host, addBox, addRectangle, body, root, hide } = setup();
    const box = addBox([3, 0, 0], [4, 1, 1]);
    addRectangle(2, 2, 0);
    const key = [...body(box).edges.keys()][0]!;
    const sketch = () => root().sketch;
    const refs: EntityRef[] = [
      { kind: 'edge', path: [], id: box as Id, edgeKey: key },
      ...[...sketch().edges.keys()].map((id): EntityRef => ({ kind: 'sketchEdge', path: [], id })),
      ...[...sketch().faces.keys()].map((id): EntityRef => ({ kind: 'sketchFace', path: [], id })),
    ];
    const entries = host.undoStack.length;
    expect(hide(refs)).toBe(refs.length);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(body(box).edges.get(key)!.hidden).toBe(true);
    expect([...sketch().edges.values(), ...sketch().faces.values()].every((e) => e.hidden)).toBe(true);
  });

  it('works on sketch edges inside an open group', () => {
    const { registry, host, addRectangle, root, hide } = setup();
    addRectangle();
    const edges = [...root().sketch.edges.keys()].map((id): EntityRef => ({ kind: 'sketchEdge', path: [], id }));
    registry.execute('selection.set', { refs: edges });
    const made = registry.execute('group.make', {}) as MakeResult;
    const inst = made.instanceId as Id;
    registry.execute('context.enter', { path: [inst] });
    const inner = containerAt(host.doc.state, [inst]).sketch;
    const edge: EntityRef = { kind: 'sketchEdge', path: [inst], id: [...inner.edges.keys()][0]! };
    expect(hide([edge])).toBe(1);
    expect(containerAt(host.doc.state, [inst]).sketch.edges.get(edge.id)!.hidden).toBe(true);
    expect(hide([edge], false)).toBe(1);
    expect(containerAt(host.doc.state, [inst]).sketch.edges.get(edge.id)!.hidden).toBe(false);
  });
});
