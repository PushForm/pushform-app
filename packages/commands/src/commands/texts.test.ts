// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Id, Vec3 } from '@pushform/core';
import { freeInference, GROUND_PLANE, type InferenceResult, type PickHit } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { disposeKernels, ISO_CAMERA, setupCommands, TOP_CAMERA } from './transform.fixtures';
import { textCommands } from './texts';
import { contextMenu } from './contextMenu';
import { ToolManager } from '../tools/ToolManager';
import { NO_MODIFIERS, type ToolPointerEvent } from '../tools/Tool';
import { TextTool, autoText } from '../tools/impl/TextTool';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands(ISO_CAMERA);
  s.registry.registerAll(textCommands);
  const edits: unknown[] = [];
  s.registry.register({ id: 'ui.editText', title: 'Edit Text', category: 'internal', params: z.object({ ref: z.unknown() }), undoable: false, run: (_c, p) => void edits.push(p.ref) });
  const text = (ref: EntityRef) => s.root().texts.get(ref.id)!;
  return { ...s, edits, text };
}

describe('text commands', () => {
  it('adds leader text with a pushpin offset and screen text at view fractions, selecting it', () => {
    const { registry, host, text } = setup();
    const leader = registry.execute('text.add', { kind: 'leader', anchor: [1, 2, 0], label: [2, 3, 1], text: '4 m²' }) as EntityRef;
    expect(text(leader)).toMatchObject({ kind: 'leader', position: [1, 2, 0], offset: [1, 1, 1], leader: 'pushpin', arrow: 'closed', text: '4 m²', fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0] });
    expect(host.selection.refs).toEqual([leader]);
    const screen = registry.execute('text.add', { kind: 'screen', screen: [0.25, 0.5], text: 'Title' }) as EntityRef;
    expect(text(screen)).toMatchObject({ kind: 'screen', position: [0.25, 0.5, 0], offset: null, leader: 'none' });
  });

  it('edits the string in one step and erases text edited to nothing', () => {
    const { registry, host, text, root } = setup();
    const ref = registry.execute('text.add', { kind: 'screen', screen: [0, 0], text: 'Enter text' }) as EntityRef;
    const entries = host.undoStack.length;
    registry.execute('text.edit', { ref, text: 'Line 1\nLine 2' });
    expect(text(ref).text).toBe('Line 1\nLine 2');
    expect(host.undoStack.length).toBe(entries + 1);
    expect(registry.execute('text.edit', { ref, text: '  ' })).toEqual({ erased: true });
    expect(root().texts.size).toBe(0);
    expect(root().order).not.toContain(ref.id);
  });

  it('sets arrows, and keeps the label in place on screen when the leader changes', () => {
    const { registry, camera, text } = setup();
    const ref = registry.execute('text.add', { kind: 'leader', anchor: [0, 0, 0], label: [1, 1, 0], text: 'A' }) as EntityRef;
    registry.execute('text.setArrow', { refs: [ref], arrow: 'dot' });
    expect(text(ref).arrow).toBe('dot');
    camera.state = TOP_CAMERA; // looking down, right is +x and up is +y
    registry.execute('text.setLeader', { refs: [ref], leader: 'view' });
    expect(text(ref).leader).toBe('view');
    expect(text(ref).viewOffset![0]).toBeCloseTo(1, 9);
    expect(text(ref).viewOffset![1]).toBeCloseTo(1, 9);
    registry.execute('text.setLeader', { refs: [ref], leader: 'pushpin' });
    expect(text(ref).viewOffset).toBeUndefined();
    text(ref).offset!.forEach((v, i) => expect(v).toBeCloseTo([1, 1, 0][i]!, 9));
    registry.execute('text.setLeader', { refs: [ref], leader: 'none' });
    expect(text(ref).leader).toBe('none');
  });

  it('erases texts with Delete and with text.delete', () => {
    const { registry, host, root } = setup();
    const a = registry.execute('text.add', { kind: 'screen', screen: [0, 0], text: 'A' }) as EntityRef;
    const b = registry.execute('text.add', { kind: 'screen', screen: [0, 0.1], text: 'B' }) as EntityRef;
    host.selection.set([a]);
    registry.execute('edit.delete', {});
    expect([...root().texts.keys()]).toEqual([b.id]);
    expect(registry.execute('text.delete', { refs: [b] })).toBe(1);
    expect(root().texts.size).toBe(0);
  });

  it('offers Edit Text, Arrow and Leader in the context menu with the current choice checked', () => {
    const { registry, host } = setup();
    const leader = registry.execute('text.add', { kind: 'leader', anchor: [0, 0, 0], label: [1, 0, 0], text: 'A' }) as EntityRef;
    const items = contextMenu.itemsFor(host.doc.state, [leader]);
    expect(items.map((i) => i.label)).toEqual(['Edit Text', 'Arrow', 'Leader', 'Erase']);
    expect(items[1]!.children!.find((c) => c.checked)!.label).toBe('Closed Arrow');
    expect(items[2]!.children!.find((c) => c.checked)!.label).toBe('Pushpin');
    const screen = registry.execute('text.add', { kind: 'screen', screen: [0, 0], text: 'B' }) as EntityRef;
    expect(contextMenu.itemsFor(host.doc.state, [screen]).map((i) => i.label)).toEqual(['Edit Text', 'Arrow', 'Erase']);
    expect(contextMenu.itemsFor(host.doc.state, [leader, screen]).map((i) => i.label)).toEqual(['Arrow', 'Leader', 'Erase']);
  });
});

const event = (p: Vec3, hit: PickHit | null, inference?: InferenceResult | null, screen: [number, number] = [200, 150]): ToolPointerEvent => ({
  screen,
  ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
  button: 0,
  buttons: 0,
  modifiers: NO_MODIFIERS,
  inference: inference === undefined ? freeInference(p, GROUND_PLANE, hit) : inference,
  camera: TOP_CAMERA,
});

describe('Text tool', () => {
  it('fills leader text with an edge length, a face area or a point', () => {
    const { host, addRectangle } = setup();
    addRectangle(2, 3);
    const state = host.doc.state;
    const root = host.doc.rootDefinition.entities;
    const face = [...root.sketch.faces.keys()][0]!;
    const edge = [...root.sketch.edges.values()].find((e) => Math.abs(root.sketch.vertices.get(e.a)!.p[1] - root.sketch.vertices.get(e.b)!.p[1]) < 1e-9)!;
    const hit = (ref: EntityRef): PickHit => ({ ref, point: [1, 0, 0], t: 1, screenDist: 0, selectable: ref });
    // the default units are architectural inches and square feet
    expect(autoText(state, freeInference([1, 1, 0], GROUND_PLANE, hit({ kind: 'sketchFace', path: [], id: face })))).toBe('64.58 ft²');
    expect(autoText(state, freeInference([1, 0, 0], GROUND_PLANE, hit({ kind: 'sketchEdge', path: [], id: edge.id })))).toBe('6\' 6 3/4"');
    const free = freeInference([2, 3, 0], GROUND_PLANE, null);
    const point: InferenceResult = { ...free, primary: { ...free.primary, kind: 'endpoint' } };
    expect(autoText(state, point)).toMatch(/, .*, 0"$/);
  });

  it('places leader text with two clicks and screen text with one, opening each for editing', () => {
    const { registry, host, edits, camera, root, addRectangle } = setup();
    camera.state = TOP_CAMERA;
    addRectangle(2, 3);
    const tools = new ToolManager(registry, camera);
    registry.ctx.tools = tools;
    tools.register(new TextTool());
    tools.activate('text');
    const face = [...root().sketch.faces.keys()][0]!;
    const hit: PickHit = { ref: { kind: 'sketchFace', path: [], id: face as Id }, point: [1, 1, 0], t: 10, screenDist: 0 };
    tools.click(event([1, 1, 0], hit));
    expect(tools.status().instructor).toContain('place the text');
    tools.pointerMove(event([2, 2, 0], null));
    tools.click(event([2, 2, 0], null));
    const leader = [...root().texts.values()][0]!;
    expect(leader).toMatchObject({ kind: 'leader', position: [1, 1, 0], leader: 'pushpin' });
    expect(leader.offset![0]).toBeCloseTo(1, 9);
    expect(leader.text).toBe('64.58 ft²');
    expect(edits).toHaveLength(1);
    // empty space: screen text where clicked, as fractions of the 800 × 600 view
    tools.click(event([5, 5, 0], null, null, [200, 150]));
    const screen = [...root().texts.values()][1]!;
    expect(screen).toMatchObject({ kind: 'screen', position: [0.25, 0.25, 0], text: 'Enter text' });
    expect(edits).toHaveLength(2);
    expect(host.selection.refs).toEqual([{ kind: 'text', path: [], id: screen.id }]);
  });

  it('cancels a half-placed text with Escape', () => {
    const { registry, camera, root, addRectangle } = setup();
    addRectangle(1, 1);
    const tools = new ToolManager(registry, camera);
    tools.register(new TextTool());
    tools.activate('text');
    const face = [...root().sketch.faces.keys()][0]!;
    tools.click(event([0.5, 0.5, 0], { ref: { kind: 'sketchFace', path: [], id: face as Id }, point: [0.5, 0.5, 0], t: 10, screenDist: 0 }));
    tools.cancel();
    tools.click(event([5, 5, 0], null, null));
    expect([...root().texts.values()].map((t) => t.kind)).toEqual(['screen']);
  });
});
