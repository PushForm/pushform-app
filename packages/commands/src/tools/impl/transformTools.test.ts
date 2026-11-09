// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Id, Vec2, Vec3 } from '@pushform/core';
import { meshBounds, v3dist } from '@pushform/core';
import { meshTopologyProblems } from '@pushform/kernel';
import { freeInference, GROUND_PLANE, SNAP_COLORS, type InferenceResult, type PickHit } from '@pushform/inference';
import type { Body, EntityRef } from '@pushform/model';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS, type Modifiers, type ToolPointerEvent } from '../Tool';
import { transformTools } from '../transformTools';
import type { CameraState } from '../../camera/CameraHost';
import { disposeKernels, installPolyMeshStub, ISO_CAMERA, setupCommands, TOP_CAMERA } from '../../commands/transform.fixtures';
import type { MoveTool } from './Move';
import type { RotateTool } from './Rotate';
import { pickGrip, type ScaleTool } from './Scale';
import { groupCommands, type MakeResult } from '../../commands/groups';
import { sectionPlaneCommands } from '../../commands/sectionPlanes';
import { guideCommands } from '../../commands/guides';
import { textCommands } from '../../commands/texts';
import { modelInfoCommands } from '../../commands/modelInfo';
import { containerAt, SketchGraph } from '@pushform/model';
import { TransformToolBase, worldToScreen, type TransformRotation } from './transformShared';
import { m4rotationAbout, m4scaleAbout, transformBodyAffineInPlace } from '../../commands/transform';
import { revolveCommands } from '../../commands/revolve';
import { curveCommands } from '../../commands/curves';
import { arcFrom3Points } from '@pushform/geom';
import { InferenceEngineImpl } from '@pushform/inference';

beforeAll(installPolyMeshStub);
afterEach(disposeKernels);

const VIEWPORT = { width: 800, height: 600 };
const CTRL: Modifiers = { ...NO_MODIFIERS, ctrl: true };
const SHIFT: Modifiers = { ...NO_MODIFIERS, shift: true };
const ALT: Modifiers = { ...NO_MODIFIERS, alt: true };

function setup(cameraState: CameraState = TOP_CAMERA) {
  const s = setupCommands(cameraState);
  const tools = new ToolManager(s.registry, s.camera);
  s.registry.ctx.tools = tools;
  for (const t of transformTools()) tools.register(t);
  return { ...s, tools };
}

/** Pointer event whose inference resolves to world point `p`; screen from the camera projection. */
function at(
  cameraState: CameraState,
  p: Vec3,
  opts: { button?: number; buttons?: number; modifiers?: Modifiers; hit?: PickHit | null; screen?: Vec2; inference?: InferenceResult | null } = {},
): ToolPointerEvent {
  const button = opts.button ?? 0;
  const screen = opts.screen ?? worldToScreen(cameraState, VIEWPORT, p) ?? [400, 300];
  return {
    screen,
    ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
    button,
    buttons: opts.buttons ?? (button === 0 ? 1 : 0),
    modifiers: opts.modifiers ?? NO_MODIFIERS,
    inference: opts.inference === undefined ? freeInference(p, GROUND_PLANE, opts.hit ?? null) : opts.inference,
    camera: cameraState,
  };
}

const key = (k: string, modifiers: Modifiers = NO_MODIFIERS) => ({ key: k, code: k, modifiers, repeat: false });
const bodyRef = (id: number): EntityRef => ({ kind: 'body', path: [], id: id as never });
const near = (a: Vec3, b: Vec3, tol = 1e-6): boolean => v3dist(a, b) <= tol;
const bodyHit = (body: Body, p: Vec3): PickHit => {
  const top = [...body.faces.values()].find((f) => f.plane.n[2] > 0.5)!;
  return { ref: { kind: 'face', path: [], id: body.id, faceId: top.id, region: null }, point: p, t: 1, normal: top.plane.n, screenDist: 0 };
};

// ---------------------------------------------------------------------------------------------

describe('MoveTool', () => {
  it('picks up a hovered section plane and moves it along its normal, drawing its outline', async () => {
    const { registry, host, tools } = setup();
    registry.registerAll(sectionPlaneCommands);
    const id = registry.execute('sectionPlane.add', { point: [0, 0, 1], normal: [0, 0, -1] }) as number;
    host.selection.set([]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    // section planes are picked while hovering
    expect(tool.inferenceOptions().annotations).toBe(true);
    const ref: EntityRef = { kind: 'sectionPlane', path: [], id: id as Id };
    const hit: PickHit = { ref, point: [2, 0, 1], t: 1, screenDist: 0 };
    // the snapped point lies elsewhere; the move starts from the point on the outline
    const onOutline = at(TOP_CAMERA, [2, 0, 1], { inference: { ...freeInference([2, 0.5, 0], GROUND_PLANE, hit) } });
    tools.pointerMove(onOutline);
    tools.pointerDown(onOutline);
    tools.pointerUp(onOutline);
    expect(host.selection.refs).toEqual([ref]);
    expect(tool.inferenceOptions().lockSnap?.dir).toEqual([0, 0, -1]);
    // off the normal: only the part along it counts
    tools.pointerMove(at(TOP_CAMERA, [3, 1, 3]));
    // the plane is previewed, with its cut, where the move would put it; the document is unchanged
    const preview = tool.sectionPreview;
    expect(preview?.moved).toEqual([{ path: [], id, normal: [0, 0, -1], d: 3 }]);
    expect(tool.sectionPreview).toBe(preview);
    expect(containerAt(host.doc.state, []).sectionPlanes.get(id as Id)!.plane.d).toBe(1);
    tools.pointerDown(at(TOP_CAMERA, [3, 1, 3]));
    tools.pointerUp(at(TOP_CAMERA, [3, 1, 3]));
    await tool.settled;
    expect(tool.sectionPreview).toBeNull();
    const sp = containerAt(host.doc.state, []).sectionPlanes.get(id as Id)!;
    expect(sp.plane.n).toEqual([0, 0, -1]);
    expect(sp.plane.d).toBeCloseTo(3, 9);
    expect(sp.origin[0]).toBeCloseTo(0, 9);
    // an arrow-key lock replaces the hold
    tools.pointerDown(at(TOP_CAMERA, [2, 0, 3], { hit: { ...hit, point: [2, 0, 3] } }));
    tools.keyDown(key('ArrowRight'));
    expect(tool.inferenceOptions().lockSnap ?? null).toBeNull();
  });

  it('drags a selected body 1 m in x: moved outline while dragging, one undo entry, undo restores', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    expect(tools.status().instructor).toContain('base point');

    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [1, 0, 0]));
    expect(tool.dragDelta).toEqual([1, 0, 0]);
    expect(tools.status()).toMatchObject({ vcbLabel: 'Length' });
    expect(tools.overlay().filter((o) => o.kind === 'polyline').length).toBeGreaterThan(12); // 12 moved edges + rubber band
    tools.pointerUp(at(TOP_CAMERA, [1, 0, 0]));
    expect(tool.dragDelta).toBeNull();
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [1, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Move');
    expect(meshTopologyProblems(body(id).mesh)).toEqual([]);
    expect(host.undo()).toBe(true);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
  });

  it('previews nested groups while dragging without changing the document until release', async () => {
    const { host, tools, registry, addBox } = setup();
    registry.registerAll(groupCommands);
    host.selection.set([bodyRef(addBox([4, 5, 0], [5, 6, 1]))]);
    registry.execute('component.make', {});
    registry.execute('group.make', {});
    const outer = registry.execute('group.make', {}) as MakeResult;
    const before = host.doc.state;
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [3, 2, 0]));
    const outlines = tools.overlay().filter((o) => o.kind === 'polyline' && o.width === 1);
    expect(outlines).toHaveLength(12);
    const points = outlines.flatMap((o) => o.kind === 'polyline' ? o.points : []);
    expect(Math.min(...points.map((p) => p[0]))).toBeCloseTo(7);
    expect(Math.min(...points.map((p) => p[1]))).toBeCloseTo(7);
    expect(host.doc.state).toBe(before);
    expect(host.undoStack.length).toBe(entries);
    tools.pointerUp(at(TOP_CAMERA, [3, 2, 0]));
    await tool.settled;
    expect(host.undoStack.length).toBe(entries + 1);
    const instance = host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!.entities.instances.get(outer.instanceId as Id)!;
    expect(instance.transform[12]).toBeCloseTo(before.definitions.get(before.rootDefinitionId)!.entities.instances.get(outer.instanceId as Id)!.transform[12]! + 3);
    expect(instance.transform[13]).toBeCloseTo(before.definitions.get(before.rootDefinitionId)!.entities.instances.get(outer.instanceId as Id)!.transform[13]! + 2);
    expect(host.undo()).toBe(true);
    expect(host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!.entities.instances.get(outer.instanceId as Id)!.transform).toEqual(
      before.definitions.get(before.rootDefinitionId)!.entities.instances.get(outer.instanceId as Id)!.transform,
    );
  });

  it('Down arrow locks the move perpendicular to the last inferred edge, and a typed length moves along it', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1]));
    tools.pointerUp(at(TOP_CAMERA, [0.5, 0.5, 1]));
    // On Edge over the line x = 3 (at the base's height), then head along +x.
    const onEdge: InferenceResult = { ...freeInference([3, 1, 1], GROUND_PLANE),
      primary: { kind: 'onEdge', point: [3, 1, 1], dir: [0, 1, 0], color: SNAP_COLORS.onEdge, label: 'On Edge' } };
    tools.pointerMove(at(TOP_CAMERA, [3, 1, 1], { inference: onEdge }));
    tools.pointerMove(at(TOP_CAMERA, [1.5, 0.6, 1]));
    expect(tools.keyDown(key('ArrowDown'))).toBe(true);
    expect(tool.inferenceOptions().lockSnap).toMatchObject({ kind: 'perpendicular', point: [0.5, 0.5, 1], dir: [1, 0, 0] });
    expect(tool.dragDelta).toEqual([1, 0, 0]);
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [2, 0, 0])).toBe(true);
    expect(tool.inferenceOptions().lockSnap).toBeNull();
  });

  it('click-move-click with an axis lock and a typed length; a length typed afterwards re-edits the move', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1]));
    tools.pointerUp(at(TOP_CAMERA, [0.5, 0.5, 1]));
    expect(tool.dragDelta).not.toBeNull();
    expect(tools.keyDown(key('ArrowRight'))).toBe(true);
    expect(tool.axisLock).toBe('x');
    tools.pointerMove(at(TOP_CAMERA, [1.5, 0.8, 1]));
    expect(tool.dragDelta).toEqual([1, 0, 0]); // y ignored under the red-axis lock
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [2, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);

    tools.onVcb({ kind: 'length', meters: 3, raw: 3, unit: 'm' });
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [3, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('Copy in the bar, just after a move, redoes it as a copy and back, as one undo step', async () => {
    const { host, tools, addBox, body, bodies } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1]));
    tools.pointerUp(at(TOP_CAMERA, [0.5, 0.5, 1]));
    tools.keyDown(key('ArrowRight'));
    tools.pointerMove(at(TOP_CAMERA, [1.5, 0.5, 1]));
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    expect(tools.status().applied).toBe(true);
    expect(bodies()).toHaveLength(1);
    tools.setting('copy', true);
    await tool.settled;
    expect(host.undoStack.length).toBe(entries + 1);
    expect(bodies()).toHaveLength(2);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
    expect(tools.status().applied).toBe(true);
    tools.setting('copy', false);
    await tool.settled;
    expect(host.undoStack.length).toBe(entries + 1);
    expect(bodies()).toHaveLength(1);
    expect(near(meshBounds(body(id).mesh).min, [2, 0, 0])).toBe(true);
  });

  it('a Ctrl tap just after a move redoes it as a copy and back, as the bar control does', async () => {
    const { host, tools, addBox, body, bodies } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [2, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [2, 0, 0]));
    await tool.settled;
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control'));
    await tool.settled;
    expect(tool.copyMode).toBe(true);
    expect(bodies()).toHaveLength(2);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control'));
    await tool.settled;
    expect(tool.copyMode).toBe(false);
    expect(bodies()).toHaveLength(1);
    expect(near(meshBounds(body(id).mesh).min, [2, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('Ctrl tap copies; `3x` turns the copy into an array of 4 evenly spaced bodies (one undo entry)', async () => {
    const { host, tools, addBox, bodies } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.keyDown(key('Control', CTRL));
    expect(tools.keyUp(key('Control', CTRL))).toBe(true);
    expect(tool.copyMode).toBe(true);
    expect(tool.cursor).toBe('copy');
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0, 1.5, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 1.5, 0]));
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    expect(host.selection.size).toBe(1);
    expect(host.selection.refs[0]!.id).not.toBe(id);

    tools.onVcb({ kind: 'array', mode: 'external', count: 3 });
    await tool.settled;
    const ys = bodies()
      .map((b) => +meshBounds(b.mesh).min[1].toFixed(6))
      .sort((a, b) => a - b);
    expect(ys).toEqual([0, 1.5, 3, 4.5]);
    expect(host.undoStack.length).toBe(entries + 1);

    tools.onVcb({ kind: 'array', mode: 'internal', count: 3 });
    await tool.settled;
    const ys2 = bodies()
      .map((b) => +meshBounds(b.mesh).min[1].toFixed(6))
      .sort((a, b) => a - b);
    expect(ys2).toEqual([0, 0.5, 1, 1.5]);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('a length typed after an array keeps its count and changes its spacing; the bar shows the array as applied', async () => {
    const { host, tools, addBox, bodies } = setup();
    host.selection.set([bodyRef(addBox())]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control', CTRL));
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0, 1.5, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 1.5, 0]));
    await tool.settled;
    tools.onVcb({ kind: 'array', mode: 'external', count: 3 });
    await tool.settled;
    expect(tools.status().applied).toBe(true);
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    const ys = (): number[] => bodies().map((b) => +meshBounds(b.mesh).min[1].toFixed(6)).sort((a, b) => a - b);
    expect(ys()).toEqual([0, 2, 4, 6]);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.selection.size).toBe(3);
    // `/N` keeps its count too: the length is where the last copy goes
    tools.onVcb({ kind: 'array', mode: 'internal', count: 4 });
    await tool.settled;
    tools.onVcb({ kind: 'length', meters: 4, raw: 4, unit: 'm' });
    await tool.settled;
    expect(ys()).toEqual([0, 1, 2, 3, 4]);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('a failed array or re-edit leaves the last move as it was, and the field shows only applied values', async () => {
    const { host, registry, tools, addBox, bodies } = setup();
    host.selection.set([bodyRef(addBox())]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control', CTRL));
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0, 1.5, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 1.5, 0]));
    await tool.settled;
    tools.onVcb({ kind: 'array', mode: 'external', count: 2 });
    await tool.settled;
    const entry = host.undoStack.peek();
    const ys = (): number[] => bodies().map((b) => +meshBounds(b.mesh).min[1].toFixed(6)).sort((a, b) => a - b);
    expect(ys()).toEqual([0, 1.5, 3]);
    const execute = registry.execute.bind(registry);
    const spy = vi.spyOn(registry, 'execute').mockImplementation((id: string, params?: unknown) => {
      if (id === 'transform.array' || id === 'transform.apply') return Promise.reject(new Error('Would create an invalid solid'));
      return execute(id, params);
    });
    tools.onVcb({ kind: 'array', mode: 'external', count: 5 });
    await tool.settled;
    expect(ys()).toEqual([0, 1.5, 3]);
    expect(host.undoStack.peek()).toBe(entry);
    expect(tools.status().instructor).toContain('invalid solid');
    const shown = tools.status().vcbValue;
    tools.onVcb({ kind: 'length', meters: 4, raw: 4, unit: 'm' });
    expect(tools.status().vcbValue).toBe(shown);
    await tool.settled;
    expect(ys()).toEqual([0, 1.5, 3]);
    expect(tools.status().vcbValue).toBe(shown);
    spy.mockRestore();
    // the copies are still the last change and can be re-edited
    tools.onVcb({ kind: 'length', meters: 1, raw: 1, unit: 'm' });
    await tool.settled;
    expect(ys()).toEqual([0, 1, 2]);
  });

  it('with nothing selected, the hovered entity is picked up on press', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerMove(at(TOP_CAMERA, [0.5, 0.5, 1], { hit: bodyHit(body(id), [0.5, 0.5, 1]) }));
    expect(tools.overlay().some((o) => o.kind === 'polygon')).toBe(true); // hover highlight
    tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1], { hit: bodyHit(body(id), [0.5, 0.5, 1]) }));
    expect(host.selection.size).toBe(1);
    // (a pure z move does not change the top-down screen position: give the drag some pixels)
    tools.pointerMove(at(TOP_CAMERA, [0.5, 0.5, 1.5], { screen: [450, 200] }));
    tools.pointerUp(at(TOP_CAMERA, [0.5, 0.5, 1.5], { screen: [450, 200] }));
    await tool.settled;
    // the hovered face was picked: moving it along its normal is a push/pull
    expect(body(id).props.volume).toBeCloseTo(1.5, 6);
    expect(host.undoStack.peek()?.label).toBe('Move');
  });

  it('moves a sketch vertex with the connected edges stretching in the overlay; Esc cancels a move', async () => {
    const { host, tools, root, addRectangle } = setup();
    addRectangle(2, 1);
    const v = [...root().sketch.vertices.values()].find((x) => near(x.p, [2, 1, 0]))!;
    host.selection.set([{ kind: 'sketchVertex', path: [], id: v.id }]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [2, 1, 0]));
    tools.pointerMove(at(TOP_CAMERA, [3, 1, 0]));
    const stretched = tools.overlay().filter((o) => o.kind === 'polyline');
    expect(stretched.length).toBe(3); // two connected edges + rubber band
    expect(tools.keyDown(key('Escape'))).toBe(true);
    expect(tool.dragDelta).toBeNull();
    expect(near(root().sketch.vertices.get(v.id)!.p, [2, 1, 0])).toBe(true);

    tools.pointerDown(at(TOP_CAMERA, [2, 1, 0]));
    tools.pointerMove(at(TOP_CAMERA, [3, 1, 0]));
    tools.pointerUp(at(TOP_CAMERA, [3, 1, 0]));
    await tool.settled;
    expect(near(root().sketch.vertices.get(v.id)!.p, [3, 1, 0])).toBe(true);
    expect(root().sketch.faces.size).toBe(1);
    expect(root().sketch.edges.size).toBe(4);
  });
});

describe('MoveTool: typed values and locks', () => {
  const len = (m: number) => ({ kind: 'length' as const, meters: m, raw: m, unit: 'm' as const });

  it('a length typed before the pointer moves applies only with an axis lock; otherwise the status says what to do', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 0, 0]));
    tools.onVcb(len(2));
    await tool.settled;
    expect(tool.dragDelta).toEqual([0, 0, 0]);
    expect(tools.status().instructor).toContain('lock an axis');
    tools.keyDown(key('ArrowUp'));
    tools.onVcb(len(2));
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 2])).toBe(true);
  });

  it('[x,y,z] typed just after a move puts its base point there', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [1, 1, 0]));
    tools.pointerMove(at(TOP_CAMERA, [2, 1, 0]));
    tools.pointerUp(at(TOP_CAMERA, [2, 1, 0]));
    await tool.settled;
    tools.onVcb({ kind: 'absolute', coords: [4, null, 3] });
    await tool.settled;
    // the base point (1,1,0) goes to (4,1,3): the box moves by (3,0,3)
    expect(near(meshBounds(body(id).mesh).min, [3, 0, 3])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('Esc during a move clears the arrow and Shift locks, as a commit does', () => {
    const { host, tools, addBox } = setup();
    host.selection.set([bodyRef(addBox())]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.keyDown(key('ArrowRight'));
    tools.pointerMove(at(TOP_CAMERA, [1, 1, 0]));
    tools.keyDown(key('Shift', SHIFT));
    expect(tool.axisLock).toBe('x');
    tools.keyDown(key('Escape'));
    expect(tool.axisLock).toBeNull();
    expect(tools.status().held ?? []).toEqual([]);
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [1, 1, 0]));
    expect(tool.dragDelta).toEqual([1, 1, 0]);
  });

  it('a move of zero length leaves no earlier move to redo', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [1, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [1, 0, 0]));
    await tool.settled;
    // a drag that ends where it started
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0.5, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 0, 0], { screen: [430, 300] }));
    await tool.settled;
    tools.onVcb(len(3));
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [1, 0, 0])).toBe(true);
  });
});

describe('transform tools: what a press picks up', () => {
  /** A box made into a group, and a hit on its top face as seen from the model: the group is what Select would select. */
  const groupedBox = (s: ReturnType<typeof setup>) => {
    s.registry.registerAll(groupCommands);
    const id = s.addBox();
    s.host.selection.set([bodyRef(id)]);
    const made = s.registry.execute('group.make', {}) as MakeResult;
    s.host.selection.set([]);
    const instance: EntityRef = { kind: 'instance', path: [], id: made.instanceId as Id };
    const def = s.host.doc.state.definitions.get(s.root().instances.get(made.instanceId as Id)!.definitionId)!;
    const inner = [...def.entities.bodies.values()][0]!;
    const face = bodyHit(inner, [0.5, 0.5, 1]);
    const hit: PickHit = { ...face, ref: { ...face.ref, path: [made.instanceId as Id] }, selectable: instance, inContext: false };
    return { instance, hit };
  };

  it('Move picks up the group a Select click would select, and Esc restores the empty selection', async () => {
    const s = setup();
    const { instance, hit } = groupedBox(s);
    s.tools.activate('move');
    const tool = s.tools.activeTool as MoveTool;
    s.tools.pointerMove(at(TOP_CAMERA, [0.5, 0.5, 1], { hit }));
    s.tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1], { hit }));
    expect(s.host.selection.refs).toEqual([instance]);
    s.tools.pointerMove(at(TOP_CAMERA, [1.5, 0.5, 1]));
    expect(tool.dragDelta).toEqual([1, 0, 0]);
    s.tools.keyDown(key('Escape'));
    expect(tool.dragDelta).toBeNull();
    expect(s.host.selection.isEmpty).toBe(true);
    // the move itself keeps what it picked up selected
    s.tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1], { hit }));
    s.tools.pointerMove(at(TOP_CAMERA, [1.5, 0.5, 1]));
    s.tools.pointerUp(at(TOP_CAMERA, [1.5, 0.5, 1]));
    await tool.settled;
    expect(s.root().instances.get(instance.id)!.transform[12]).toBeCloseTo(1, 9);
    expect(s.host.selection.refs).toEqual([instance]);
  });

  it('refuses a locked group as the move starts: a message, nothing picked up and nothing previewed', () => {
    const s = setup();
    const { instance, hit } = groupedBox(s);
    s.registry.execute('instance.setLocked', { refs: [instance], locked: true });
    s.tools.activate('move');
    const tool = s.tools.activeTool as MoveTool;
    s.tools.pointerMove(at(TOP_CAMERA, [0.5, 0.5, 1], { hit }));
    s.tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1], { hit }));
    expect(tool.dragDelta).toBeNull();
    expect(s.host.selection.isEmpty).toBe(true);
    expect(s.tools.status().instructor).toContain('A locked group or component cannot be moved');
    // selected first, it is refused the same way; with Copy on it may be copied
    s.host.selection.set([instance]);
    s.tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1]));
    expect(tool.dragDelta).toBeNull();
    s.tools.keyDown(key('Control', CTRL));
    s.tools.keyUp(key('Control'));
    s.tools.pointerDown(at(TOP_CAMERA, [0.5, 0.5, 1]));
    expect(tool.dragDelta).toEqual([0, 0, 0]);
    // switching Copy off during the move would make it a refused move: Copy stays on and the status says why
    s.tools.keyDown(key('Control', CTRL));
    s.tools.keyUp(key('Control'));
    expect(tool.copyMode).toBe(true);
    expect(s.tools.status().instructor).toContain('cannot be moved');
  });

  it('Rotate and Scale pick up the group too and refuse it when locked, naming the operation', () => {
    const s = setup(ISO_CAMERA);
    const { instance, hit } = groupedBox(s);
    s.tools.activate('rotate');
    s.tools.pointerMove(at(ISO_CAMERA, [0.5, 0.5, 1], { hit }));
    s.tools.pointerDown(at(ISO_CAMERA, [0.5, 0.5, 1], { hit }));
    expect(s.host.selection.refs).toEqual([instance]);
    s.tools.keyDown(key('Escape'));
    expect(s.host.selection.isEmpty).toBe(true);
    s.registry.execute('instance.setLocked', { refs: [instance], locked: true });
    s.tools.pointerDown(at(ISO_CAMERA, [0.5, 0.5, 1], { hit }));
    expect(s.host.selection.isEmpty).toBe(true);
    expect(s.tools.status().instructor).toContain('cannot be rotated');

    s.tools.activate('scale');
    const scale = s.tools.activeTool as ScaleTool;
    s.host.selection.set([instance]);
    s.tools.pointerMove(at(ISO_CAMERA, [0.5, 0.5, 1]));
    const grip = scale.scaleBox!.grips[0]!;
    const screen = worldToScreen(ISO_CAMERA, VIEWPORT, grip.pos)!;
    s.tools.pointerDown(at(ISO_CAMERA, grip.pos, { screen }));
    expect(scale.dragFactors).toBeNull();
    expect(s.tools.status().instructor).toContain('cannot be scaled');
  });
});

describe('MoveTool: sketch moves', () => {
  it('says so when a face with holes is replaced by its edges', async () => {
    const { host, tools, root } = setup();
    host.edit('Frame', (draft) => {
      const g = SketchGraph.for(draft);
      for (const [a, b] of [[0, 3], [1, 2]] as const) {
        g.addEdge([a, a, 0], [b, a, 0]);
        g.addEdge([b, a, 0], [b, b, 0]);
        g.addEdge([b, b, 0], [a, b, 0]);
        g.addEdge([a, b, 0], [a, a, 0]);
      }
    });
    const corner = [...root().sketch.vertices.values()].find((v) => near(v.p, [3, 3, 0]))!;
    host.selection.set([{ kind: 'sketchVertex', path: [], id: corner.id }]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [3, 3, 0]));
    tools.pointerUp(at(TOP_CAMERA, [3, 3, 0]));
    tools.keyDown(key('ArrowUp'));
    tools.onVcb({ kind: 'length', meters: 1, raw: 1, unit: 'm' });
    await tool.settled;
    expect(tools.status().instructor).toContain('replaced by its edges');
  });
});

describe('MoveTool: copies', () => {
  it('previews a copy of sketch edges as the copies alone, leaving the originals unstretched', () => {
    const { host, tools, root, addRectangle } = setup();
    addRectangle(2, 1);
    const s = root().sketch;
    const top = [...s.edges.values()].find((e) => s.vertices.get(e.a)!.p[1] > 0.5 && s.vertices.get(e.b)!.p[1] > 0.5)!;
    const lone = [...s.vertices.values()].find((v) => near(v.p, [0, 0, 0]))!;
    host.selection.set([{ kind: 'sketchEdge', path: [], id: top.id }, { kind: 'sketchVertex', path: [], id: lone.id }]);
    tools.activate('move');
    tools.pointerDown(at(TOP_CAMERA, [0, 1, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0, 2, 0]));
    // a move stretches the two side edges and drags the top one (plus the rubber band)
    expect(tools.overlay().filter((o) => o.kind === 'polyline')).toHaveLength(4 + 1);
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control'));
    const lines = tools.overlay().filter((o) => o.kind === 'polyline');
    expect(lines).toHaveLength(1 + 1);
    expect(lines[0]!.kind === 'polyline' && lines[0]!.points.every((p) => near([0, p[1], 0], [0, 2, 0]))).toBe(true);
  });
});

describe('MoveTool: guides and text', () => {
  it('previews and moves guides and leader text with the selection', async () => {
    const { host, registry, tools, root } = setup();
    registry.registerAll(guideCommands);
    registry.registerAll(textCommands);
    const line = registry.execute('guides.addLine', { point: [0, 0, 0], dir: [1, 0, 0] }) as number;
    const point = (registry.execute('guides.addPoint', { point: [1, 1, 0] }) as { id: number }).id;
    const text = registry.execute('text.add', { kind: 'leader', anchor: [0, 1, 0], label: [1, 2, 0], text: 'Drawer' }) as EntityRef;
    host.selection.set([{ kind: 'guide', path: [], id: line as Id }, { kind: 'guide', path: [], id: point as Id }, text]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0, 1, 0]));
    const overlay = tools.overlay();
    const guideLine = overlay.find((o) => o.kind === 'polyline' && o.dashed);
    expect(guideLine?.kind === 'polyline' && guideLine.points.every((p) => near([0, p[1], p[2]], [0, 1, 0]))).toBe(true);
    expect(overlay.some((o) => o.kind === 'point' && o.shape === 'cross' && near(o.position, [1, 2, 0]))).toBe(true);
    expect(overlay.some((o) => o.kind === 'label' && o.text === 'Drawer' && near(o.position, [1, 3, 0]))).toBe(true);
    tools.pointerUp(at(TOP_CAMERA, [0, 1, 0]));
    await tool.settled;
    expect(tools.status().instructor).not.toContain('failed');
    expect(near(root().guides.get(line as Id)!.origin, [0, 1, 0])).toBe(true);
    expect(near(root().guides.get(point as Id)!.origin, [1, 2, 0])).toBe(true);
    expect(near(root().texts.get(text.id)!.position, [0, 2, 0])).toBe(true);
  });
});

describe('MoveTool: tool options bar', () => {
  it('offers Copy, offset fields and a constraint indicator; an Alt tap changes nothing', () => {
    const { tools } = setup();
    tools.activate('move');
    expect(tools.status().settings?.map((s) => s.id)).toEqual(['copy', 'constraint']);
    tools.keyDown(key('Alt', ALT));
    tools.keyUp(key('Alt', ALT));
    expect(tools.status().settings).toEqual([expect.objectContaining({ id: 'copy', on: false }), expect.objectContaining({ id: 'constraint', text: 'Free' })]);
    expect((tools.activeTool as MoveTool).copyMode).toBe(false);
  });
});

describe('RotateTool', () => {
  it('picks up a hovered section plane and rotates it, previewing the plane and its cut', async () => {
    const { registry, host, tools } = setup();
    registry.registerAll(sectionPlaneCommands);
    // a vertical plane through x = 1, keeping x >= 1
    const id = registry.execute('sectionPlane.add', { point: [1, 0, 0], normal: [1, 0, 0] }) as number;
    host.selection.set([]);
    tools.activate('rotate');
    const tool = tools.activeTool as RotateTool;
    expect(tool.inferenceOptions().annotations).toBe(true);
    const ref: EntityRef = { kind: 'sectionPlane', path: [], id: id as Id };
    const hit: PickHit = { ref, point: [1, 0, 0], t: 1, screenDist: 0 };
    tools.pointerMove(at(TOP_CAMERA, [1, 0, 0], { hit }));
    // the hovered plane is highlighted by its outline
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.closed === true && o.points.length === 4)).toBe(true);
    // centre at the origin, baseline along x, 90° about z
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0], { hit }));
    tools.pointerUp(at(TOP_CAMERA, [0, 0, 0], { hit }));
    expect(host.selection.refs).toEqual([ref]);
    tools.pointerDown(at(TOP_CAMERA, [1, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [1, 0, 0]));
    tools.pointerMove(at(TOP_CAMERA, [0.01, 1, 0]));
    expect(tool.dragAngleDeg).toBeCloseTo(90, 9);
    const preview = tool.sectionPreview;
    expect(preview?.moved).toHaveLength(1);
    expect(preview!.moved[0]!.normal[1]).toBeCloseTo(1, 9);
    expect(preview!.moved[0]!.d).toBeCloseTo(-1, 9);
    expect(tool.sectionPreview).toBe(preview);
    tools.pointerDown(at(TOP_CAMERA, [0.01, 1, 0]));
    await tool.settled;
    const sp = containerAt(host.doc.state, []).sectionPlanes.get(id as Id)!;
    expect(sp.plane.n[1]).toBeCloseTo(1, 9);
    expect(sp.plane.d).toBeCloseTo(-1, 9);
    expect(tool.sectionPreview).toBeNull();
  });

  it('centre, baseline, 90° about Z (snapped) → the body extents swap; protractor overlay present', async () => {
    const { host, tools, addBox, body } = setup();
    const id = addBox([0, 0, 0], [2, 1, 1]);
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('rotate');
    const tool = tools.activeTool as RotateTool;
    tools.pointerMove(at(TOP_CAMERA, [1, 0.5, 1]));
    expect(tools.overlay().filter((o) => o.kind === 'polyline').length).toBeGreaterThanOrEqual(25); // ring + 24 ticks
    expect(tool.protractorNormal).toEqual([0, 0, 1]);
    tools.pointerDown(at(TOP_CAMERA, [1, 0.5, 1]));
    tools.pointerUp(at(TOP_CAMERA, [1, 0.5, 1]));
    expect(tools.status().instructor).toContain('starting direction');
    tools.pointerDown(at(TOP_CAMERA, [2, 0.5, 1]));
    tools.pointerUp(at(TOP_CAMERA, [2, 0.5, 1]));
    tools.pointerMove(at(TOP_CAMERA, [1.01, 1.5, 1])); // ~89.4°, within the 15° tick tolerance near the ring
    expect(tool.dragAngleDeg).toBeCloseTo(90, 9);
    expect(tools.status().vcbLabel).toBe('Angle');
    tools.pointerDown(at(TOP_CAMERA, [1.01, 1.5, 1]));
    await tool.settled;
    const mb = meshBounds(body(id).mesh);
    expect(near(mb.min, [0.5, -0.5, 0])).toBe(true);
    expect(near(mb.max, [1.5, 1.5, 1])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Rotate');
    expect(meshTopologyProblems(body(id).mesh)).toEqual([]);
  });

  it('typed angle commits; Ctrl copy + `3x` makes a radial array; arrow keys pick the axis', async () => {
    const { host, tools, addBox, bodies, body } = setup();
    const id = addBox([1, 0, 0], [2, 1, 1]);
    host.selection.set([bodyRef(id)]);
    tools.activate('rotate');
    const tool = tools.activeTool as RotateTool;
    tools.keyDown(key('ArrowRight'));
    expect(tool.protractorNormal).toEqual([1, 0, 0]);
    tools.keyDown(key('ArrowRight')); // toggle off
    expect(tool.protractorNormal).toEqual([0, 0, 1]);
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control', CTRL));
    expect(tool.copyMode).toBe(true);

    tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [0, 0, 0]));
    tools.pointerDown(at(TOP_CAMERA, [1, 0, 0]));
    tools.pointerUp(at(TOP_CAMERA, [1, 0, 0]));
    tools.onVcb({ kind: 'angle', degrees: 90 });
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    const copy = bodies().find((b) => b.id !== id)!;
    expect(near(meshBounds(copy.mesh).min, [-1, 1, 0])).toBe(true);
    expect(near(meshBounds(body(id).mesh).min, [1, 0, 0])).toBe(true);

    tools.onVcb({ kind: 'array', mode: 'external', count: 3 });
    await tool.settled;
    expect(bodies()).toHaveLength(4);
    const mins = bodies().map((b) => meshBounds(b.mesh).min.map((x) => +x.toFixed(6)) as unknown as Vec3);
    expect(mins.some((m) => near(m, [-2, -1, 0]))).toBe(true); // 180°
    expect(mins.some((m) => near(m, [0, -2, 0]))).toBe(true); // 270°
    expect(host.undoStack.peek()?.label).toBe('Rotate');

    // an angle typed after the array keeps its three copies, now 45° apart
    const entries = host.undoStack.length;
    tools.onVcb({ kind: 'angle', degrees: 45 });
    await tool.settled;
    expect(bodies()).toHaveLength(4);
    expect(host.undoStack.length).toBe(entries);
    const turned = bodies().map((b) => meshBounds(b.mesh).min.map((x) => +x.toFixed(6)) as unknown as Vec3);
    expect(turned.some((m) => near(m, [-1, 1, 0]))).toBe(true); // 90°
  });
});

describe('RotateTool: typed angles, snapping, locks and arrays', () => {
  /** Rotate tool with a 2×1×1 box selected at x 1..2 and the center at the origin, starting along x. */
  function started(opts: { angleSnap?: number | null } = {}) {
    const s = setup();
    if (opts.angleSnap !== undefined) {
      s.registry.registerAll(modelInfoCommands);
      s.registry.execute('model.setUnits', { patch: { angleSnap: opts.angleSnap } });
    }
    const id = s.addBox([1, 0, 0], [2, 1, 1]);
    s.host.selection.set([bodyRef(id)]);
    s.tools.activate('rotate');
    const tool = s.tools.activeTool as RotateTool;
    const click = (p: Vec3): void => {
      s.tools.pointerDown(at(TOP_CAMERA, p));
      s.tools.pointerUp(at(TOP_CAMERA, p));
    };
    return { ...s, id, tool, click };
  }
  const min = (b: Body): Vec3 => meshBounds(b.mesh).min.map((x) => +x.toFixed(6) + 0) as unknown as Vec3;

  it('a bare number is degrees, counterclockwise about the normal before the pointer has turned', async () => {
    const { tools, tool, click, body, id, host } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'length', meters: 90 * 0.0254, raw: 90, unit: null });
    await tool.settled;
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true);
    expect(host.undoStack.peek()?.label).toBe('Rotate');
  });

  it('a typed angle turns the way the preview turns, and a negative one the other way', async () => {
    const { tools, tool, click, body, id, host } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.pointerMove(at(TOP_CAMERA, [1, -0.3, 0])); // turning clockwise
    expect(tool.dragAngleDeg!).toBeLessThan(0);
    tools.onVcb({ kind: 'length', meters: 0, raw: 90, unit: null });
    await tool.settled;
    expect(near(min(body(id)), [0, -2, 0])).toBe(true); // 90° clockwise
    host.undo();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.pointerMove(at(TOP_CAMERA, [1, -0.3, 0]));
    tools.onVcb({ kind: 'angle', degrees: -90 });
    await tool.settled;
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true); // the other way: counterclockwise
  });

  it('an angle typed before the starting direction changes nothing and asks for it, even after a rotation', async () => {
    const { tools, tool, click, body, id, host } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 90 });
    await tool.settled;
    const entries = host.undoStack.length;
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true);
    click([0, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 45 });
    await tool.settled;
    expect(tools.status().instructor).toContain('starting direction first');
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries);
    // the next step clears the message
    click([1, 0, 0]);
    expect(tools.status().instructor).not.toContain('starting direction first');
  });

  it('an angle typed just after a rotation redoes it the way it turned, as one step', async () => {
    const { tools, tool, click, body, id, host } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.pointerMove(at(TOP_CAMERA, [1, -0.3, 0]));
    tools.onVcb({ kind: 'angle', degrees: 45 });
    await tool.settled;
    const entries = host.undoStack.length;
    tools.onVcb({ kind: 'length', meters: 0, raw: 90, unit: null });
    await tool.settled;
    expect(near(min(body(id)), [0, -2, 0])).toBe(true); // still clockwise
    expect(host.undoStack.length).toBe(entries);
    expect(tools.status().vcbValue).toContain('-90');
  });

  it('the last rotation does not survive a tool switch or another change', async () => {
    const { tools, tool, click, body, id, host, addBox } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 90 });
    await tool.settled;
    expect(tools.status().vcbValue).toContain('90');
    tools.activate('move');
    tools.activate('rotate');
    expect(tools.status().vcbValue).toBeUndefined();
    tools.onVcb({ kind: 'angle', degrees: 45 });
    await tool.settled;
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true);

    // another change on top: the redo is skipped and the old angle is not kept
    host.selection.set([bodyRef(id)]);
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 90 });
    await tool.settled;
    expect(near(min(body(id)), [-2, -1, 0])).toBe(true);
    addBox([5, 5, 0], [6, 6, 1]);
    expect(tools.status().vcbValue).toBeUndefined();
    tools.onVcb({ kind: 'angle', degrees: 45 });
    await tool.settled;
    expect(near(min(body(id)), [-2, -1, 0])).toBe(true);
  });

  it('snaps to the snap angle within 2 px at any distance, draws ticks at it, and not at all when snapping is off', async () => {
    const ticks = (snap: number | null): number => {
      const { tools } = started({ angleSnap: snap });
      tools.pointerMove(at(TOP_CAMERA, [0, 0, 0]));
      return tools.overlay().filter((o) => o.kind === 'polyline' && o.points.length === 2 && o.width === 1).length;
    };
    const off = ticks(null);
    expect(ticks(30) - off).toBe(12 - 4);
    expect(ticks(15) - off).toBe(24 - 4);
    expect(ticks(1) - off).toBe(72 - 4); // finer snaps are drawn every 5°

    const far = started({ angleSnap: 15 });
    far.click([0, 0, 0]);
    far.click([1, 0, 0]);
    far.tools.pointerMove(at(TOP_CAMERA, [0.01, 5, 0])); // 1 px off 90°, 500 px out
    expect(far.tool.dragAngleDeg).toBeCloseTo(90, 9);
    far.tools.pointerMove(at(TOP_CAMERA, [0.05, 5, 0])); // 5 px off
    expect(far.tool.dragAngleDeg).not.toBeCloseTo(90, 3);

    const free = started({ angleSnap: null });
    free.click([0, 0, 0]);
    free.click([1, 0, 0]);
    free.tools.pointerMove(at(TOP_CAMERA, [0.01, 1, 0])); // near the ring
    expect(free.tool.dragAngleDeg).not.toBeCloseTo(90, 3);
  });

  it('once the center is set the arrow keys do nothing and no lock tag is shown', () => {
    const { tools, tool, click } = started();
    tools.keyDown(key('ArrowRight'));
    expect(tools.status().held?.length).toBe(1);
    tools.keyDown(key('ArrowRight'));
    click([0, 0, 0]);
    expect(tool.protractorNormal).toEqual([0, 0, 1]);
    expect(tools.keyDown(key('ArrowUp'))).toBe(true);
    expect(tools.keyDown(key('ArrowRight'))).toBe(true);
    expect(tool.protractorNormal).toEqual([0, 0, 1]);
    expect(tools.status().held ?? []).toEqual([]);
    tools.keyDown(key('Escape'));
    // a lock set before the center stays on its axis but its tag goes once the center is set
    tools.keyDown(key('ArrowRight'));
    click([0, 0, 0]);
    expect(tool.protractorNormal).toEqual([1, 0, 0]);
    expect(tools.status().held ?? []).toEqual([]);
    tools.keyDown(key('ArrowLeft'));
    expect(tool.protractorNormal).toEqual([1, 0, 0]);
  });

  it('/N spreads the copies over a turn past 180°, the way it turned', async () => {
    const { tools, tool, click, bodies, host } = started();
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control', CTRL));
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 270 });
    await tool.settled;
    expect(bodies().map(min)).toContainEqual([0, -2, 0]);
    const entries = host.undoStack.length;
    tools.onVcb({ kind: 'array', mode: 'internal', count: 3 });
    await tool.settled;
    const mins = bodies().map(min);
    expect(mins).toHaveLength(4);
    expect(mins).toContainEqual([-1, 1, 0]); // 90°
    expect(mins).toContainEqual([-2, -1, 0]); // 180°
    expect(mins).toContainEqual([0, -2, 0]); // 270°
    expect(host.undoStack.length).toBe(entries);
    expect(host.undoStack.peek()?.label).toBe('Rotate');
  });

  it('a copy turned all the way round, then /N, makes N evenly round the circle, the original counted', async () => {
    const { tools, tool, click, bodies } = started();
    tools.keyDown(key('Control', CTRL));
    tools.keyUp(key('Control', CTRL));
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.pointerMove(at(TOP_CAMERA, [1, -0.3, 0])); // clockwise
    tools.onVcb({ kind: 'angle', degrees: 360 });
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    tools.onVcb({ kind: 'array', mode: 'internal', count: 4 });
    await tool.settled;
    // the original counts as one of the four: three copies, none on top of it
    const mins = bodies().map(min);
    expect(mins).toHaveLength(4);
    expect(mins).toContainEqual([0, -2, 0]); // 90° clockwise first
    expect(mins).toContainEqual([-2, -1, 0]);
    expect(mins).toContainEqual([-1, 1, 0]);
    expect(mins.filter((m) => near(m, [1, 0, 0]))).toHaveLength(1);
  });

  it('switching Copy in the bar just after a rotation redoes it as a copy and back, as one step', async () => {
    const { tools, tool, click, bodies, host, id, body } = started();
    click([0, 0, 0]);
    click([1, 0, 0]);
    tools.onVcb({ kind: 'angle', degrees: 90 });
    await tool.settled;
    const entries = host.undoStack.length;
    tools.setting('copy', true);
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    expect(near(min(body(id)), [1, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries);
    expect(tool.adjustLast('copy', false)).toBe(true);
    await tool.settled;
    expect(bodies()).toHaveLength(1);
    expect(near(min(body(id)), [-1, 1, 0])).toBe(true);
    expect(tool.copyMode).toBe(false);
  });
});

describe('ScaleTool', () => {
  it('shows 26 grips for a solid; dragging a corner grip scales uniformly about the opposite corner (volume ×8)', async () => {
    const { host, tools, addBox, body } = setup(ISO_CAMERA);
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('scale');
    const tool = tools.activeTool as ScaleTool;
    const box = tool.scaleBox!;
    expect(box.grips).toHaveLength(26);
    expect(box.grips.filter((g) => g.kind === 'corner')).toHaveLength(8);
    expect(box.grips.filter((g) => g.kind === 'edge')).toHaveLength(12);
    expect(box.grips.filter((g) => g.kind === 'face')).toHaveLength(6);
    expect(tools.overlay().filter((o) => o.kind === 'point')).toHaveLength(26);

    const corner = box.grips.find((g) => near(g.pos, [1, 1, 1]))!;
    const screen = worldToScreen(ISO_CAMERA, VIEWPORT, corner.pos)!;
    tools.pointerMove(at(ISO_CAMERA, [1, 1, 1], { screen: [screen[0] + 3, screen[1] - 2] }));
    expect(tool.hoveredGrip?.index).toBe(corner.index);
    tools.pointerDown(at(ISO_CAMERA, [1, 1, 1], { screen: [screen[0] + 3, screen[1] - 2] }));
    tools.pointerMove(at(ISO_CAMERA, [2, 2, 2]));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 2, 2]);
    expect(tools.status()).toMatchObject({ vcbLabel: 'Scale', vcbValue: '2.00' });
    expect(tools.status().instructor).toContain('hold Shift to scale freely');
    tools.pointerUp(at(ISO_CAMERA, [2, 2, 2]));
    await tool.settled;
    expect(body(id).props.volume).toBeCloseTo(8, 6);
    expect(near(meshBounds(body(id).mesh).max, [2, 2, 2])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Scale');

    // typed `2,1,1` re-edits the commit (still one entry), `-1` mirrors with a positive volume
    tools.onVcb({
      kind: 'list',
      values: [
        { kind: 'length', meters: 2, raw: 2, unit: null },
        { kind: 'length', meters: 1, raw: 1, unit: null },
        { kind: 'length', meters: 1, raw: 1, unit: null },
      ],
    });
    await tool.settled;
    expect(body(id).props.volume).toBeCloseTo(2, 6);
    expect(host.undoStack.length).toBe(entries + 1);
    tools.onVcb({ kind: 'length', meters: -1, raw: -1, unit: null });
    await tool.settled;
    expect(body(id).props.volume).toBeCloseTo(1, 6);
    expect(near(meshBounds(body(id).mesh).min, [-1, -1, -1])).toBe(true);
    expect(meshTopologyProblems(body(id).mesh)).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('a face grip scales one axis; Ctrl scales about the centre; a length with a unit sets the size', async () => {
    const { host, tools, addBox, body } = setup(ISO_CAMERA);
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('scale');
    const tool = tools.activeTool as ScaleTool;
    const top = tool.scaleBox!.grips.find((g) => near(g.pos, [0.5, 0.5, 1]))!;
    expect(top.kind).toBe('face');
    expect(top.axes).toEqual([2]);
    const screen = worldToScreen(ISO_CAMERA, VIEWPORT, top.pos)!;
    tools.pointerDown(at(ISO_CAMERA, top.pos, { screen }));
    tools.pointerMove(at(ISO_CAMERA, [0.5, 0.5, 1.5]));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([1, 1, 1.5]);
    tools.pointerUp(at(ISO_CAMERA, [0.5, 0.5, 1.5]));
    await tool.settled;
    expect(body(id).props.volume).toBeCloseTo(1.5, 6);
    expect(near(meshBounds(body(id).mesh).max, [1, 1, 1.5])).toBe(true);

    // absolute height: 3 m along the grip's axis (relative to the size at the last commit)
    tools.onVcb({ kind: 'length', meters: 3, raw: 3, unit: 'm' });
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).max, [1, 1, 3])).toBe(true);

    // Ctrl: about the centre
    const box2 = tool.scaleBox!;
    const px = box2.grips.find((g) => near(g.pos, [1, 0.5, 1.5]))!;
    const s2 = worldToScreen(ISO_CAMERA, VIEWPORT, px.pos)!;
    tools.pointerDown(at(ISO_CAMERA, px.pos, { screen: s2, modifiers: CTRL }));
    tools.pointerMove(at(ISO_CAMERA, [1.5, 0.5, 1.5], { modifiers: CTRL }));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 1, 1]);
    tools.pointerUp(at(ISO_CAMERA, [1.5, 0.5, 1.5], { modifiers: CTRL }));
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [-0.5, 0, 0])).toBe(true);
    expect(near(meshBounds(body(id).mesh).max, [1.5, 1, 3])).toBe(true);
  });

  it('Alt scales about the centre, like Ctrl', async () => {
    const { host, tools, addBox, body } = setup(ISO_CAMERA);
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('scale');
    const tool = tools.activeTool as ScaleTool;
    const px = tool.scaleBox!.grips.find((g) => near(g.pos, [1, 0.5, 0.5]))!;
    const screen = worldToScreen(ISO_CAMERA, VIEWPORT, px.pos)!;
    tools.pointerDown(at(ISO_CAMERA, px.pos, { screen, modifiers: ALT }));
    expect(tools.status().instructor).toContain('Alt (or Ctrl) to keep the centre');
    tools.pointerMove(at(ISO_CAMERA, [1.5, 0.5, 0.5], { modifiers: ALT }));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 1, 1]);
    tools.pointerUp(at(ISO_CAMERA, [1.5, 0.5, 0.5], { modifiers: ALT }));
    await tool.settled;
    expect(near(meshBounds(body(id).mesh).min, [-0.5, 0, 0])).toBe(true);
    expect(near(meshBounds(body(id).mesh).max, [1.5, 1, 1])).toBe(true);
  });

  it('Shift toggles uniform on an edge grip; a planar selection gets 8 flat grips', async () => {
    const { host, tools, addBox, body, root, addRectangle } = setup(ISO_CAMERA);
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    tools.activate('scale');
    const tool = tools.activeTool as ScaleTool;
    const edge = tool.scaleBox!.grips.find((g) => near(g.pos, [1, 1, 0.5]))!;
    expect(edge.kind).toBe('edge');
    expect(tools.status().instructor).toContain('Hold Shift to maintain aspect ratio');
    const screen = worldToScreen(ISO_CAMERA, VIEWPORT, edge.pos)!;
    tools.pointerDown(at(ISO_CAMERA, edge.pos, { screen }));
    expect(tools.status().instructor).toContain('Hold Shift to maintain aspect ratio');
    tools.pointerMove(at(ISO_CAMERA, [2, 2, 0.5], { modifiers: SHIFT }));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 2, 2]);
    tools.pointerMove(at(ISO_CAMERA, [2, 1.5, 0.5]));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 1.5, 1]);
    tools.keyDown(key('Escape'));
    expect(tool.dragFactors).toBeNull();
    expect(body(id).props.volume).toBeCloseTo(1, 9);

    addRectangle(2, 1);
    const face = [...root().sketch.faces.values()][0]!;
    host.selection.set([{ kind: 'sketchFace', path: [], id: face.id }]);
    tools.pointerMove(at(ISO_CAMERA, [0, 0, 0]));
    const flat = tool.scaleBox!;
    expect(flat.dims).toEqual([0, 1]);
    expect(flat.grips).toHaveLength(8);
    expect(flat.grips.filter((g) => g.kind === 'corner')).toHaveLength(4);
    const c = flat.grips.find((g) => near(g.pos, [2, 1, 0]))!;
    tools.pointerDown(at(ISO_CAMERA, c.pos, { screen: worldToScreen(ISO_CAMERA, VIEWPORT, c.pos)! }));
    tools.pointerMove(at(ISO_CAMERA, [4, 2, 0]));
    tools.pointerUp(at(ISO_CAMERA, [4, 2, 0]));
    await tool.settled;
    const xs = [...root().sketch.vertices.values()].map((v) => v.p[0]);
    expect(Math.max(...xs)).toBeCloseTo(4, 9);
    expect(root().sketch.faces.size).toBe(1);
    expect(host.undoStack.peek()?.label).toBe('Scale');
  });

  it('hover-selects an entity when nothing is selected', () => {
    const { host, tools, addBox, body } = setup(ISO_CAMERA);
    const id = addBox();
    tools.activate('scale');
    const tool = tools.activeTool as ScaleTool;
    expect(tool.scaleBox).toBeNull();
    expect(tools.status().instructor).toContain('Select');
    tools.pointerMove(at(ISO_CAMERA, [0.5, 0.5, 1], { hit: bodyHit(body(id), [0.5, 0.5, 1]) }));
    tools.pointerDown(at(ISO_CAMERA, [0.5, 0.5, 1], { hit: bodyHit(body(id), [0.5, 0.5, 1]) }));
    expect(host.selection.size).toBe(1);
    expect(tool.scaleBox?.grips.length).toBeGreaterThan(0);
  });
});

describe('ScaleTool: Shift, typed sizes, overlapping grips and redos', () => {
  /** Scale tool with a box selected; `grab` presses the grip at `pos`. */
  function scaling(max: Vec3 = [1, 1, 1], cam: CameraState = ISO_CAMERA) {
    const s = setup(cam);
    const id = s.addBox([0, 0, 0], max);
    s.host.selection.set([bodyRef(id)]);
    s.tools.activate('scale');
    const tool = s.tools.activeTool as ScaleTool;
    const grab = (pos: Vec3, modifiers: Modifiers = NO_MODIFIERS) => {
      const grip = tool.scaleBox!.grips.find((g) => near(g.pos, pos))!;
      s.tools.pointerDown(at(cam, grip.pos, { screen: worldToScreen(cam, VIEWPORT, grip.pos)!, modifiers }));
      return grip;
    };
    const drag = (to: Vec3, modifiers: Modifiers = NO_MODIFIERS): void => {
      s.tools.pointerMove(at(cam, to, { modifiers }));
      s.tools.pointerUp(at(cam, to, { modifiers }));
    };
    const size = (): number[] => {
      const b = meshBounds(s.body(id).mesh);
      return [0, 1, 2].map((a) => +(b.max[a]! - b.min[a]!).toFixed(6));
    };
    return { ...s, id, tool, grab, drag, size };
  }
  const m = (meters: number) => ({ kind: 'length' as const, meters, raw: meters, unit: 'm' as const });
  const factor = (k: number) => ({ kind: 'length' as const, meters: k * 0.0254, raw: k, unit: null });

  it('Shift lets a corner grip scale each axis freely, without the diagonal lock', async () => {
    const { tools, tool, grab, drag, size } = scaling();
    grab([1, 1, 1]);
    expect(tool.inferenceOptions().lockSnap?.kind).toBe('fromPoint');
    tools.keyDown(key('Shift', SHIFT));
    expect(tool.inferenceOptions().lockSnap).toBeUndefined();
    tools.pointerMove(at(ISO_CAMERA, [2, 1.5, 1], { modifiers: SHIFT }));
    expect(tool.dragFactors?.map((f) => +f.toFixed(9))).toEqual([2, 1.5, 1]);
    tools.keyUp(key('Shift'));
    expect(tool.inferenceOptions().lockSnap?.kind).toBe('fromPoint');
    tools.keyDown(key('Shift', SHIFT));
    drag([2, 1.5, 1], SHIFT);
    await tool.settled;
    expect(size()).toEqual([2, 1.5, 1]);
  });

  it('Shift on a flat corner keeps it in its plane', () => {
    const { tools, root, host, addRectangle } = setup(ISO_CAMERA);
    addRectangle(2, 1);
    host.selection.set([{ kind: 'sketchFace', path: [], id: [...root().sketch.faces.values()][0]!.id }]);
    tools.activate('scale');
    const t = tools.activeTool as ScaleTool;
    const c = t.scaleBox!.grips.find((g) => near(g.pos, [2, 1, 0]))!;
    tools.pointerDown(at(ISO_CAMERA, c.pos, { screen: worldToScreen(ISO_CAMERA, VIEWPORT, c.pos)!, modifiers: SHIFT }));
    expect(t.inferenceOptions().lockSnap?.kind).toBe('onPlane');
  });

  it('a length on a corner or edge grip sets the longest side it scales, the rest following; on a face grip its axis', async () => {
    const corner = scaling([2, 1, 0.5]);
    corner.grab([2, 1, 0.5]);
    corner.tools.onVcb(m(4));
    await corner.tool.settled;
    expect(corner.size()).toEqual([4, 2, 1]);

    const edge = scaling([2, 1, 0.5]);
    edge.grab([2, 1, 0.25]);
    edge.tools.onVcb(m(3));
    await edge.tool.settled;
    expect(edge.size()).toEqual([3, 1.5, 0.5]);

    const face = scaling([2, 1, 0.5]);
    face.grab([1, 0.5, 0.5]);
    face.tools.onVcb(m(2));
    await face.tool.settled;
    expect(face.size()).toEqual([2, 1, 2]);
  });

  it('of overlapping grips, the one nearest the viewer is picked', () => {
    const { tool } = scaling([1, 1, 1], TOP_CAMERA);
    const box = tool.scaleBox!;
    const screen = worldToScreen(TOP_CAMERA, VIEWPORT, [1, 1, 0])!;
    const picked = pickGrip(box, screen, TOP_CAMERA, VIEWPORT)!;
    expect(picked.pos).toEqual([1, 1, 1]);
    expect(picked.kind).toBe('corner');
    // seen from below, the bottom one
    const below: CameraState = { ...TOP_CAMERA, eye: [0, 0, -10] };
    expect(pickGrip(box, worldToScreen(below, VIEWPORT, [1, 1, 0])!, below, VIEWPORT)!.pos).toEqual([1, 1, 0]);
    // grips apart on screen are picked by distance
    const side = worldToScreen(TOP_CAMERA, VIEWPORT, [1, 0.5, 0])!;
    expect(pickGrip(box, [side[0], side[1] + 2], TOP_CAMERA, VIEWPORT)!.pos).toEqual([1, 0.5, 1]);
  });

  it('a value typed after a Shift-uniform drag keeps it uniform', async () => {
    const { tools, tool, grab, drag, size, host } = scaling();
    grab([1, 1, 0.5]);
    drag([2, 2, 0.5], SHIFT);
    await tool.settled;
    expect(size()).toEqual([2, 2, 2]);
    const entries = host.undoStack.length;
    tools.onVcb(factor(3));
    await tool.settled;
    expect(size()).toEqual([3, 3, 3]);
    tools.onVcb(m(1.5));
    await tool.settled;
    expect(size()).toEqual([1.5, 1.5, 1.5]);
    expect(host.undoStack.length).toBe(entries);
  });

  it('the last scale does not survive a tool switch or another change', async () => {
    const { tools, tool, grab, drag, size, addBox } = scaling();
    grab([1, 0.5, 0.5]);
    drag([2, 0.5, 0.5]);
    await tool.settled;
    expect(size()).toEqual([2, 1, 1]);
    expect(tools.status().vcbValue).toContain('2.00');
    tools.activate('move');
    tools.activate('scale');
    expect(tools.status().vcbValue).toBeUndefined();
    tools.onVcb(factor(3));
    await tool.settled;
    expect(size()).toEqual([2, 1, 1]);

    grab([2, 0.5, 0.5]);
    drag([3, 0.5, 0.5]);
    await tool.settled;
    expect(size()).toEqual([3, 1, 1]);
    addBox([5, 5, 0], [6, 6, 1]);
    expect(tools.status().vcbValue).toBeUndefined();
    tools.onVcb(factor(2));
    await tool.settled;
    expect(size()).toEqual([3, 1, 1]);
  });

  it('the held-key tag reads the same for Ctrl and Alt', () => {
    for (const mods of [CTRL, ALT]) {
      const { tools, grab } = scaling();
      grab([1, 0.5, 0.5], mods);
      tools.pointerMove(at(ISO_CAMERA, [1.5, 0.5, 0.5], { modifiers: mods }));
      expect(tools.status().held).toEqual(['About the center · Ctrl/Alt']);
    }
  });
});

describe('worldToScreen', () => {
  it('matches the 100 px/m top-down convention and handles the iso camera', () => {
    expect(worldToScreen(TOP_CAMERA, VIEWPORT, [1, 0, 0])).toEqual([500, 300]);
    expect(worldToScreen(TOP_CAMERA, VIEWPORT, [0, 1, 0])![1]).toBeCloseTo(200, 9);
    const a = worldToScreen(ISO_CAMERA, VIEWPORT, [1, 1, 0])!, b = worldToScreen(ISO_CAMERA, VIEWPORT, [1, 1, 1])!;
    expect(Math.abs(a[1] - b[1])).toBeGreaterThan(10);
  });
});


describe('TransformToolBase: arrays of a turn', () => {
  /** The shared machinery alone, as a rotation tool drives it. */
  class TurnTool extends TransformToolBase {
    readonly id = 'turn';
    readonly title = 'Rotate';
    onCancel(): void {}
    overlay() {
      return [];
    }
    status() {
      return { instructor: '', vcbLabel: '' };
    }
    turn(refs: EntityRef[], rotation: TransformRotation, copy: boolean): void {
      this.commitTransform(refs, m4rotationAbout(rotation.center, rotation.axis, rotation.angle), copy, 'Rotate', rotation);
    }
    array(count: number, mode: 'external' | 'internal'): boolean {
      return this.arrayLast(count, mode);
    }
    retype(rotation: TransformRotation): boolean {
      return this.reapplyLast(m4rotationAbout(rotation.center, rotation.axis, rotation.angle), undefined, rotation);
    }
  }

  it('passes the turn the last rotation made to transform.array, and keeps it for a re-edit of the array', async () => {
    const { registry, tools, addBox } = setup();
    const turn = new TurnTool();
    tools.register(turn);
    tools.activate('turn');
    const ref = bodyRef(addBox([1, 0, 0], [2, 1, 1]));
    const sent: unknown[] = [];
    const execute = registry.execute.bind(registry);
    vi.spyOn(registry, 'execute').mockImplementation((id: string, params?: unknown) => {
      if (id === 'transform.array') sent.push(params);
      return execute(id, params);
    });
    const half: TransformRotation = { center: [0, 0, 0], axis: [0, 0, 1], angle: (3 * Math.PI) / 2 };
    turn.turn([ref], half, true);
    await turn.settled;
    expect(turn.array(3, 'internal')).toBe(true);
    await turn.settled;
    expect(sent[0]).toMatchObject({ count: 3, mode: 'internal', rotation: { center: [0, 0, 0], axis: [0, 0, 1], angle: half.angle } });
    const whole: TransformRotation = { ...half, angle: 2 * Math.PI };
    turn.retype(whole);
    await turn.settled;
    expect(sent[1]).toMatchObject({ count: 3, mode: 'internal', rotation: { angle: 2 * Math.PI } });
    expect(tools.status().applied).toBe(false); // no settings: the bar is not shown
  });
});

describe('MoveTool: consistent placement and rails', () => {
  const length = (meters: number) => ({ kind: 'length' as const, meters, raw: meters, unit: 'm' as const });

  function start() {
    const s = setup();
    const id = s.addBox();
    s.host.selection.set([bodyRef(id)]);
    s.tools.activate('move');
    s.tools.pointerDown(at(TOP_CAMERA, [0, 0, 0]));
    s.tools.pointerUp(at(TOP_CAMERA, [0, 0, 0]));
    return { ...s, id, tool: s.tools.activeTool as MoveTool };
  }

  it('freezes travel with Shift even without a directional inference, through the base and back', () => {
    const { tools, tool } = start();
    tools.pointerMove(at(TOP_CAMERA, [2, 2, 0]));
    tools.keyDown(key('Shift', SHIFT));
    expect(tool.inferenceOptions().lockSnap?.point).toEqual([0, 0, 0]);
    expect(near(tool.inferenceOptions().lockSnap!.dir!, [Math.SQRT1_2, Math.SQRT1_2, 0])).toBe(true);
    for (const [point, expected] of [
      [[-2, -2, 0], [-2, -2, 0]], [[0, 0, 0], [0, 0, 0]], [[4, 0, 0], [2, 2, 0]],
    ] as [Vec3, Vec3][]) {
      tools.pointerMove(at(TOP_CAMERA, point));
      expect(near(tool.dragDelta!, expected)).toBe(true);
    }
    tools.keyUp(key('Shift'));
    tools.pointerMove(at(TOP_CAMERA, [4, 0, 0]));
    expect(tool.dragDelta).toEqual([4, 0, 0]);
  });

  it('keeps one arrow constraint, ignores autorepeat, and leaves it unchanged when Down has no edge', () => {
    const { tools, tool } = start();
    tools.keyDown(key('ArrowRight'));
    tools.keyDown({ ...key('ArrowRight'), repeat: true });
    expect(tool.axisLock).toBe('x');
    tools.keyDown(key('ArrowDown'));
    expect(tool.axisLock).toBe('x');
    expect(tool.status().instructor).toContain('Infer an edge');
    tools.keyDown(key('Shift', SHIFT));
    tools.pointerMove(at(TOP_CAMERA, [2, 5, 0]));
    expect(tool.dragDelta).toEqual([2, 0, 0]);
    tools.keyUp(key('Shift'));
    expect(tool.axisLock).toBe('x');
    tools.keyDown(key('ArrowLeft'));
    expect(tool.axisLock).toBe('y');
    expect(tool.inferenceOptions().lockSnap).toBeNull();
    tools.keyDown(key('ArrowLeft'));
    expect(tool.axisLock).toBeNull();
  });

  it('keeps Down locked to the chosen direction over new edges and across the base', () => {
    const { tools, tool } = start();
    const edge = (point: Vec3, dir: Vec3): InferenceResult => ({ ...freeInference(point, GROUND_PLANE), primary: { kind: 'onEdge', point, dir, color: SNAP_COLORS.onEdge, label: 'On Edge' } });
    tools.pointerMove(at(TOP_CAMERA, [3, 1, 0], { inference: edge([3, 1, 0], [0, 1, 0]) }));
    tools.keyDown(key('ArrowDown'));
    const lock = tool.inferenceOptions().lockSnap;
    for (const x of [2, 0, -2, 1]) {
      tools.pointerMove(at(TOP_CAMERA, [x, 5, 0], { inference: edge([x, 5, 0], [1, 1, 0]) }));
      expect(tool.inferenceOptions().lockSnap).toEqual(lock);
      expect(near(tool.dragDelta!, [x, 0, 0])).toBe(true);
    }
    tools.keyDown(key('ArrowDown'));
    expect(tool.inferenceOptions().lockSnap).toBeNull();
  });

  it('holds typed offsets in the live preview, commits once, and can edit the last offsets', async () => {
    const { tools, tool, host, id, body } = start();
    const before = host.doc.state;
    const entries = host.undoStack.length;
    expect(tool.status().fields?.map((f) => f.label)).toEqual(['Distance', 'ΔX', 'ΔY', 'ΔZ']);
    tools.keyDown(key('ArrowRight'));
    tools.lockEntry('x', length(3));
    expect(tool.axisLock).toBeNull();
    tools.pointerMove(at(TOP_CAMERA, [8, 2, 0]));
    expect(tool.dragDelta).toEqual([3, 2, 0]);
    expect(host.doc.state).toBe(before);
    tools.onEntry({ z: length(4) });
    await tool.settled;
    expect(meshBounds(body(id).mesh).min).toEqual([3, 2, 4]);
    expect(host.undoStack.length).toBe(entries + 1);
    tools.onEntry({ x: length(-2) });
    await tool.settled;
    expect(meshBounds(body(id).mesh).min).toEqual([-2, 2, 4]);
    expect(host.undoStack.length).toBe(entries + 1);
    host.undo();
    expect(meshBounds(body(id).mesh).min).toEqual([0, 0, 0]);
  });

  it('a typed distance follows the negative side of an arrow rail', async () => {
    const { tools, tool, body, id } = start();
    tools.keyDown(key('ArrowRight'));
    tools.pointerMove(at(TOP_CAMERA, [-2, 0, 0]));
    tools.onEntry({ distance: length(5) });
    await tool.settled;
    expect(meshBounds(body(id).mesh).min).toEqual([-5, 0, 0]);
  });

  it('Tab holds Distance during preview, and an offset releases that length', () => {
    const { tools, tool } = start();
    tools.pointerMove(at(TOP_CAMERA, [3, 4, 0]));
    tools.lockEntry('distance', length(10));
    tools.pointerMove(at(TOP_CAMERA, [0, 4, 0]));
    expect(tool.dragDelta).toEqual([0, 10, 0]);
    tools.lockEntry('x', length(2));
    tools.pointerMove(at(TOP_CAMERA, [3, 4, 0]));
    expect(tool.dragDelta).toEqual([2, 4, 0]);
    expect(tool.status().fields?.find((f) => f.id === 'distance')?.locked).toBe(false);
    tools.cancel();
    expect(tool.hasPendingWork()).toBe(false);
  });

  it('real inference ignores the complete moving solid even when selection is all its faces', () => {
    const { tools, tool, host, body, id } = start();
    tools.cancel();
    host.selection.set([...body(id).faces.values()].map((f) => ({ kind: 'face', path: [], id: id as Id, faceId: f.id, region: null })));
    tools.pointerDown(at(TOP_CAMERA, [0, 0, 1]));
    tools.pointerUp(at(TOP_CAMERA, [0, 0, 1]));
    expect(tool.inferenceOptions().ignore).toEqual([bodyRef(id)]);
    tools.keyDown(key('Shift', SHIFT));
    const engine = new InferenceEngineImpl();
    engine.setState(host.doc.state);
    const result = engine.resolve({ ray: { origin: [0.5, 0.5, 10], dir: [0, 0, -1] }, screen: [50, 50], pixelSizeAt: () => 0.01 }, tool.inferenceOptions());
    expect(result.hit).toBeNull();
    expect(result.primary.ref).toBeUndefined();
  });

  it.each([
    ['drag', 'surface', false], ['clicks', 'surface', false], ['drag', 'pickup', false], ['clicks', 'pickup', false],
    ['drag', 'surface', true], ['clicks', 'surface', true],
  ] as const)('preserves a revolved sphere: %s, %s, copy=%s', async (gesture, selection, copy) => {
    const s = setup();
    s.registry.registerAll(curveCommands);
    s.registry.registerAll(revolveCommands);
    s.registry.execute('sketch.addCurve', { ...arcFrom3Points([0, 0, -1], [1, 0, 0], [0, 0, 1], 12), closed: false });
    s.host.edit('Close profile', (draft) => { SketchGraph.for(draft).addEdge([0, 0, -1], [0, 0, 1]); });
    const profile = [...s.root().sketch.faces.values()][0]!;
    await s.registry.execute('revolve.apply', { profile: { kind: 'sketchFace', path: [], id: profile.id }, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, segments: 24 });
    const sphere = s.bodies()[0]!;
    expect(sphere.surfaces.size).toBe(1);
    expect([...sphere.edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
    const faces: EntityRef[] = [...sphere.faces.values()].map((f) => ({ kind: 'face', path: [], id: sphere.id, faceId: f.id, region: null }));
    s.host.selection.set(selection === 'surface' ? faces : []);
    s.tools.activate('move');
    const tool = s.tools.activeTool as MoveTool;
    if (copy) s.tools.setting('copy', true);
    const from = at(TOP_CAMERA, [1, 0, 0], { hit: bodyHit(sphere, [1, 0, 0]) });
    s.tools.pointerMove(from);
    s.tools.pointerDown(from);
    if (gesture === 'clicks') s.tools.pointerUp(from);
    const before = s.host.doc.state;
    const entries = s.host.undoStack.length;
    const autofold = vi.spyOn(s.kernel, 'autofold');
    const to = at(TOP_CAMERA, [3, 2, 0]);
    s.tools.pointerMove(to);
    expect(tool.dragDelta).toEqual([2, 2, 0]);
    expect(tool.overlay().some((p) => p.kind === 'polyline' && p.points.length >= 2)).toBe(true);
    expect(s.host.doc.state).toBe(before);
    // A fresh pick at the same screen coordinate must not replace the displayed destination.
    const release = { ...to, inference: freeInference([8, 9, 0], GROUND_PLANE) };
    if (gesture === 'clicks') s.tools.pointerDown(release);
    else s.tools.pointerUp(release);
    await tool.settled;
    expect(autofold).not.toHaveBeenCalled();
    expect(tool.status().instructor).not.toContain('failed');
    const moved = s.bodies().find((b) => copy ? b.id !== sphere.id : b.id === sphere.id)!;
    expect(moved.mesh.tris).toEqual(sphere.mesh.tris);
    expect(moved.mesh.faceId).toEqual(sphere.mesh.faceId);
    expect([...moved.surfaces.values()].map((surface) => surface.faceIds)).toEqual([...sphere.surfaces.values()].map((surface) => surface.faceIds));
    expect(moved.props).toEqual(sphere.props);
    expect([...moved.faces.keys()]).toEqual([...sphere.faces.keys()]);
    expect([...moved.edges.values()].map((e) => [e.key, e.soft, e.smooth, e.hidden, e.curveId])).toEqual([...sphere.edges.values()].map((e) => [e.key, e.soft, e.smooth, e.hidden, e.curveId]));
    const bounds = meshBounds(moved.mesh), old = meshBounds(sphere.mesh);
    expect(near(bounds.min, [old.min[0] + 2, old.min[1] + 2, old.min[2]])).toBe(true);
    expect(meshTopologyProblems(moved.mesh)).toEqual([]);
    if (copy) expect(s.body(sphere.id)).toBe(sphere);
    expect(s.host.undoStack.length).toBe(entries + 1);
    s.host.undo();
    expect(s.body(sphere.id).mesh).toEqual(sphere.mesh);
    s.host.redo();
    expect(s.body(moved.id).surfaces).toEqual(moved.surfaces);
    expect([...s.body(moved.id).edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
  });
});

describe('ScaleTool: smooth solids and consistent placement', () => {
  async function sphere() {
    const s = setup(ISO_CAMERA);
    s.registry.registerAll(curveCommands);
    s.registry.registerAll(revolveCommands);
    s.registry.execute('sketch.addCurve', { ...arcFrom3Points([0, 0, -1], [1, 0, 0], [0, 0, 1], 12), closed: false });
    s.host.edit('Close profile', (draft) => { SketchGraph.for(draft).addEdge([0, 0, -1], [0, 0, 1]); });
    const profile = [...s.root().sketch.faces.values()][0]!;
    await s.registry.execute('revolve.apply', { profile: { kind: 'sketchFace', path: [], id: profile.id }, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, segments: 24 });
    const id = s.bodies()[0]!.id;
    s.host.edit('Edge display property', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id)!;
      [...body.edges.values()][0]!.hidden = true;
    });
    const source = s.body(id);
    s.host.selection.set([...source.faces.values()].map((f) => ({ kind: 'face', path: [], id, faceId: f.id, region: null })));
    s.tools.activate('scale');
    return { ...s, id, source, tool: s.tools.activeTool as ScaleTool };
  }

  it.each([{ factors: [2, 2, 2] as Vec3 }, { factors: [-1, 2, 1] as Vec3 }])('preserves smoothing when a transformed container bakes its affine matrix $factors', async ({ factors }) => {
    const s = await sphere();
    s.host.edit('Bake affine transform', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(s.id)!;
      transformBodyAffineInPlace(body as unknown as Body, m4scaleAbout([0, 0, 0], factors));
    });
    expect(meshTopologyProblems(s.body(s.id).mesh)).toEqual([]);
    expect([...s.body(s.id).edges.values()].every((edge) => edge.soft && edge.smooth)).toBe(true);
    expect([...s.body(s.id).edges.values()].filter((edge) => edge.hidden)).toHaveLength(1);
    expect(s.body(s.id).surfaces.size).toBe(1);
  });

  it.each([
    ['drag', 'corner', [3, 3, 3], [2, 2, 2]], ['clicks', 'corner', [3, 3, 3], [2, 2, 2]],
    ['drag', 'face', [3, 0, 0], [2, 1, 1]], ['clicks', 'face', [3, 0, 0], [2, 1, 1]],
    ['drag', 'corner', [-3, -3, -3], [-1, -1, -1]], ['clicks', 'face', [-5, 0, 0], [-2, 1, 1]],
  ] as const)('preserves a smooth revolved sphere through %s %s scaling to %j', async (gesture, kind, target, factors) => {
    const s = await sphere();
    const pos: Vec3 = kind === 'corner' ? [1, 1, 1] : [1, 0, 0];
    const grip = s.tool.scaleBox!.grips.find((g) => near(g.pos, pos))!;
    const start = at(ISO_CAMERA, grip.pos);
    s.tools.pointerDown(start);
    if (gesture === 'clicks') s.tools.pointerUp(start);
    expect(s.tool.inferenceOptions().ignore).toEqual([bodyRef(s.id)]);
    const before = s.host.doc.state;
    const entries = s.host.undoStack.length;
    s.tools.pointerMove(at(ISO_CAMERA, target));
    expect(s.tool.dragFactors!.map((f) => +f.toFixed(6))).toEqual(factors);
    expect(s.host.doc.state).toBe(before);
    const preview = s.tool.overlay();
    expect(preview.filter((p) => p.kind === 'polyline').length).toBeGreaterThan(12);
    const finish = at(ISO_CAMERA, [20, 30, 40], { screen: worldToScreen(ISO_CAMERA, VIEWPORT, target)! });
    if (gesture === 'drag') s.tools.pointerUp(finish);
    else s.tools.pointerDown(finish);
    await s.tool.settled;
    expect(s.tool.status().instructor).not.toContain('failed');
    const scaled = s.body(s.id);
    expect(meshTopologyProblems(scaled.mesh)).toEqual([]);
    expect(scaled.mesh.tris.length).toBe(s.source.mesh.tris.length);
    expect(scaled.faces.size).toBe(s.source.faces.size);
    expect(scaled.surfaces.size).toBe(1);
    expect([...scaled.surfaces.values()][0]!.faceIds).toHaveLength(scaled.faces.size);
    expect([...scaled.edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
    expect([...scaled.edges.values()].filter((e) => e.hidden)).toHaveLength(1);
    expect(scaled.props.volume).toBeCloseTo(s.source.props.volume * Math.abs(factors[0] * factors[1] * factors[2]), 5);
    const anchor = kind === 'corner' ? [-1, -1, -1] : [-1, 0, 0];
    const old = meshBounds(s.source.mesh), bounds = meshBounds(scaled.mesh);
    for (let axis = 0; axis < 3; axis++) {
      const a = anchor[axis]! + (old.min[axis]! - anchor[axis]!) * factors[axis]!;
      const b = anchor[axis]! + (old.max[axis]! - anchor[axis]!) * factors[axis]!;
      expect(bounds.min[axis]).toBeCloseTo(Math.min(a, b), 5);
      expect(bounds.max[axis]).toBeCloseTo(Math.max(a, b), 5);
    }
    expect(s.host.undoStack.length).toBe(entries + 1);
    s.host.undo();
    expect(s.body(s.id).mesh).toEqual(s.source.mesh);
    s.host.redo();
    expect([...s.body(s.id).edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
  });
});

describe('ScaleTool: toolbar input details', () => {
  it('disables a planar selection\'s missing dimension and clears held values when switching tools', () => {
    const s = setup(ISO_CAMERA);
    s.addRectangle(2, 1);
    s.host.selection.set([{ kind: 'sketchFace', path: [], id: [...s.root().sketch.faces.keys()][0]! }]);
    s.tools.activate('scale');
    const tool = s.tools.activeTool as ScaleTool;
    const corner = tool.scaleBox!.grips.find((grip) => near(grip.pos, [2, 1, 0]))!;
    s.tools.pointerDown(at(ISO_CAMERA, corner.pos));
    expect(tool.status().fields?.find((f) => f.id === 'z')?.disabled).toBe(true);
    s.tools.lockEntry('x', { kind: 'length', meters: 4, raw: 4, unit: 'm' });
    expect(tool.status().fields?.find((f) => f.id === 'x')?.locked).toBe(true);
    s.tools.activate('move');
    s.tools.activate('scale');
    expect(tool.status().fields?.every((f) => !f.locked)).toBe(true);
    expect(tool.hasPendingWork()).toBe(false);
  });
});
