// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '@pushform/core';
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
import type { ScaleTool } from './Scale';
import { worldToScreen } from './transformShared';

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

  it('Ctrl tap copies; `3x` turns the copy into an array of 4 evenly spaced bodies (one undo entry)', async () => {
    const { host, tools, addBox, bodies } = setup();
    const id = addBox();
    host.selection.set([bodyRef(id)]);
    const entries = host.undoStack.length;
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    expect(tools.keyDown(key('Control', CTRL))).toBe(true);
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

describe('RotateTool', () => {
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
    expect(tools.status().instructor).toContain('baseline');
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

describe('worldToScreen', () => {
  it('matches the 100 px/m top-down convention and handles the iso camera', () => {
    expect(worldToScreen(TOP_CAMERA, VIEWPORT, [1, 0, 0])).toEqual([500, 300]);
    expect(worldToScreen(TOP_CAMERA, VIEWPORT, [0, 1, 0])![1]).toBeCloseTo(200, 9);
    const a = worldToScreen(ISO_CAMERA, VIEWPORT, [1, 1, 0])!, b = worldToScreen(ISO_CAMERA, VIEWPORT, [1, 1, 1])!;
    expect(Math.abs(a[1] - b[1])).toBeGreaterThan(10);
  });
});

