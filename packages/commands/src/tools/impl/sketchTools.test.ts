// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, FaceLocalId, Id, Ray, Vec2, Vec3 } from '@pushform/core';
import { freeInference, GROUND_PLANE, SNAP_COLORS } from '@pushform/inference';
import type { InferenceResult, PickHit } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { editCommands } from '../../registry/editCommands';
import { sketchCommands } from '../../commands/sketch';
import { DocumentHost } from '../../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_INFERENCE } from '../../host/services';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS } from '../Tool';
import type { Modifiers, ToolPointerEvent } from '../Tool';
import { parseVcb } from '../../vcb/parse';
import { sketchTools } from '../sketchTools';
import type { SelectTool } from './Select';
import { lassoModeOf, type LassoTool } from './Lasso';
import type { EraserTool } from './Eraser';
import type { RectangleTool } from './Rectangle';

const CAMERA: CameraState = {
  eye: [0, 0, 10],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov: 35,
  projection: 'parallel',
  orthoHeight: 6, // 600 px tall viewport → 0.01 m per px
};

class StubCamera implements CameraHost {
  getState(): CameraState {
    return CAMERA;
  }
  setState(): void {}
  viewportSize() {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 10], dir: [0, 0, -1] };
  }
  pick(): Vec3 | null {
    return null;
  }
  sceneBounds(): Box3 | null {
    return null;
  }
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(): void {}
  setProjection(): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

function setup(services: [string, unknown][] = []) {
  const host = new DocumentHost();
  const camera = new StubCamera();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host], ...services]) });
  registry.registerAll(editCommands);
  registry.registerAll(sketchCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of sketchTools()) tools.register(t);
  const sketch = () => host.doc.rootDefinition.entities.sketch;
  return { host, registry, tools, sketch };
}

/** Pointer event at world point `p` (screen = 100 px per metre from the origin) with a stub inference. */
function at(
  p: Vec3,
  opts: { button?: number; buttons?: number; modifiers?: Modifiers; hit?: PickHit | null; inference?: InferenceResult } = {},
): ToolPointerEvent {
  const screen: Vec2 = [400 + p[0] * 100, 300 - p[1] * 100];
  const button = opts.button ?? 0;
  return {
    screen,
    ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
    button,
    buttons: opts.buttons ?? (button === 0 ? 1 : 0),
    modifiers: opts.modifiers ?? NO_MODIFIERS,
    inference: opts.inference ?? freeInference(p, GROUND_PLANE, opts.hit ?? null),
    camera: CAMERA,
  };
}

const endpointAt = (p: Vec3): InferenceResult => ({
  ...freeInference(p, GROUND_PLANE),
  primary: { kind: 'endpoint', point: p, color: SNAP_COLORS.endpoint, label: 'Endpoint' },
  tooltip: 'Endpoint',
});

/** "On Edge" inference at `p` on an edge running along `dir`. */
const onEdgeAt = (p: Vec3, dir: Vec3): InferenceResult => ({
  ...freeInference(p, GROUND_PLANE),
  primary: { kind: 'onEdge', point: p, dir, color: SNAP_COLORS.onEdge, label: 'On Edge' },
  tooltip: 'On Edge',
});

const edgeHit = (id: number, p: Vec3): PickHit => ({
  ref: { kind: 'sketchEdge', path: [], id: id as Id },
  point: p,
  t: 10,
  screenDist: 1,
});
const faceHit = (id: number, faceId: number, p: Vec3): PickHit => ({
  ref: { kind: 'face', path: [], id: id as Id, faceId: faceId as FaceLocalId, region: null },
  point: p,
  t: 10,
  normal: [0, 0, 1],
  screenDist: 0,
});

const key = (k: string, modifiers: Modifiers = NO_MODIFIERS) => ({ key: k, code: k, modifiers, repeat: false });
const CTRL: Modifiers = { ...NO_MODIFIERS, ctrl: true };
const SHIFT: Modifiers = { ...NO_MODIFIERS, shift: true };

function vertexPositions(s: { vertices: Map<Id, { p: Vec3 }> }): Vec3[] {
  return [...s.vertices.values()].map((v) => [+v.p[0].toFixed(6), +v.p[1].toFixed(6), +v.p[2].toFixed(6)]);
}

describe('LineTool', () => {
  it('chains segments, closes a loop into a face and ends the chain on an endpoint snap', () => {
    const { tools, sketch, host } = setup();
    tools.activate('line');
    expect(tools.status()).toMatchObject({ instructor: 'Select start point.', vcbLabel: 'Length' });
    tools.click(at([0, 0, 0]));
    expect(tools.status().instructor).toBe('Select end point or enter value.');
    tools.pointerMove(at([1, 0, 0]));
    // rubber band + inference glyph-free overlay (free snap has no glyph)
    expect(tools.overlay().some((o) => o.kind === 'polyline')).toBe(true);
    tools.click(at([1, 0, 0]));
    tools.click(at([1, 1, 0]));
    tools.click(at([0, 1, 0]));
    expect(sketch().edges.size).toBe(3);
    expect(sketch().faces.size).toBe(0);
    tools.click(at([0, 0, 0], { inference: endpointAt([0, 0, 0]) }));
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
    expect(sketch().vertices.size).toBe(4);
    // landing on an existing vertex ends the chain
    expect(tools.status().instructor).toBe('Select start point.');
    expect(host.undoStack.length).toBe(4);
  });

  it("VCB 10' extends along the rubber band and keeps chaining", () => {
    const { tools, sketch } = setup();
    tools.activate('line');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 0.0, 0]));
    expect(tools.status().vcbValue).toBe(`3' 3 3/8"`);
    const v = parseVcb("10'", 'in');
    expect(v.ok).toBe(true);
    if (v.ok) tools.onVcb(v.value);
    expect(sketch().edges.size).toBe(1);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[3.048, 0, 0]]));
    expect(tools.status().instructor).toBe('Select end point or enter value.');
    // typing again before moving re-sizes the same segment (undo count stays 1)
    const v2 = parseVcb('2m', 'in');
    if (v2.ok) tools.onVcb(v2.value);
    expect(sketch().edges.size).toBe(1);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[2, 0, 0]]));
    // relative and absolute coordinates
    const rel = parseVcb('<,1m,>', 'in');
    if (rel.ok) tools.onVcb(rel.value);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[2, 1, 0]]));
    const abs = parseVcb('[0,1m,0]', 'in');
    if (abs.ok) tools.onVcb(abs.value);
    expect(sketch().edges.size).toBe(3);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[0, 1, 0]]));
  });

  it('Esc cancels only the current segment and keeps earlier edges; arrows lock axes', () => {
    const { tools, sketch } = setup();
    tools.activate('line');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.click(at([1, 1, 0]));
    tools.pointerMove(at([2, 2, 0]));
    expect(tools.keyDown(key('ArrowRight'))).toBe(true);
    expect(tools.activeTool?.inferenceOptions?.()).toMatchObject({ anchor: [1, 1, 0], lockAxis: 'x' });
    expect(tools.keyDown(key('ArrowRight'))).toBe(true); // toggles off
    expect(tools.activeTool?.inferenceOptions?.().lockAxis).toBeNull();
    tools.keyDown(key('Escape'));
    expect(sketch().edges.size).toBe(2);
    expect(tools.activeToolId).toBe('line');
    expect(tools.status().instructor).toBe('Select start point.');
    expect(tools.activeTool?.inferenceOptions?.().anchor).toBeUndefined();
  });

  it('Down arrow locks parallel or perpendicular to the last inferred edge, whichever is nearer the pointer', () => {
    const { tools, sketch } = setup();
    tools.activate('line');
    // Without a start point or an inferred edge, Down arrow just releases an arrow lock.
    expect(tools.keyDown(key('ArrowDown'))).toBe(true);
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toBeNull();
    tools.click(at([0, 0, 0]));
    tools.keyDown(key('ArrowRight'));
    tools.keyDown(key('ArrowDown'));
    expect(tools.activeTool?.inferenceOptions?.()).toMatchObject({ lockAxis: null, lockSnap: null });
    // Hovering the edge x = 3 (On Edge) remembers it.
    tools.pointerMove(at([3, 2, 0], { inference: onEdgeAt([3, 2, 0], [0, 1, 0]) }));
    // The pointer heads along +x: perpendicular (toward the edge's line) is nearer than parallel.
    tools.pointerMove(at([1, 0.2, 0]));
    tools.keyDown(key('ArrowDown'));
    expect(tools.activeTool?.inferenceOptions?.()).toMatchObject({ lockAxis: null,
      lockSnap: { kind: 'perpendicular', point: [0, 0, 0], label: 'Perpendicular to Edge', color: SNAP_COLORS.perpendicular } });
    expect(tools.activeTool?.inferenceOptions?.().lockSnap?.dir).toEqual([1, 0, 0]);
    // A typed length goes along the lock, and the lock follows the chain's new start point.
    const v = parseVcb('2m', 'in');
    if (v.ok) tools.onVcb(v.value);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[2, 0, 0]]));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toMatchObject({ kind: 'perpendicular', point: [2, 0, 0] });
    // Down arrow again releases it; pointing along the edge then locks parallel, pointing the way of the pointer.
    tools.keyDown(key('ArrowDown'));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toBeNull();
    tools.pointerMove(at([2.1, -1, 0]));
    tools.keyDown(key('ArrowDown'));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toMatchObject({ kind: 'parallel', label: 'Parallel to Edge', dir: [0, -1, 0] });
    // Another arrow replaces it with its axis; Shift's held inference wins while Shift is down.
    tools.keyDown(key('ArrowUp'));
    expect(tools.activeTool?.inferenceOptions?.()).toMatchObject({ lockAxis: 'z', lockSnap: null });
    tools.keyDown(key('ArrowUp'));
    tools.keyDown(key('ArrowDown'));
    tools.pointerMove(at([3, 0.5, 0], { inference: onEdgeAt([3, 0.5, 0], [0, 1, 0]) }));
    tools.keyDown(key('Shift'));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap?.kind).toBe('onEdge');
    tools.keyUp(key('Shift'));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap?.kind).toBe('parallel');
    // Esc ends the segment and the lock.
    tools.keyDown(key('Escape'));
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toBeNull();
  });

  it('Alt cycles all inferences, none, and parallel/perpendicular only, named in the status text', () => {
    const { tools } = setup();
    tools.activate('line');
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('all');
    tools.keyDown(key('Alt'));
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('none');
    expect(tools.status().instructor).toBe('Select start point. Inference off (Alt).');
    tools.click(at([0, 0, 0]));
    tools.keyDown(key('Alt'));
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('directional');
    expect(tools.status().instructor).toBe('Select end point or enter value. Parallel and perpendicular inference only (Alt).');
    tools.keyDown({ ...key('Alt'), repeat: true });
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('directional');
    tools.keyDown(key('Alt'));
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('all');
    expect(tools.status().instructor).toBe('Select end point or enter value.');
    // Choosing the tool again starts with all inferences.
    tools.keyDown(key('Alt'));
    tools.activate('select');
    tools.activate('line');
    expect(tools.activeTool?.inferenceOptions?.().snapping).toBe('all');
  });

  it('colors the rubber band by axis snap and shows the inference tooltip', () => {
    const { tools } = setup();
    tools.activate('line');
    tools.click(at([0, 0, 0]));
    const onAxis: InferenceResult = {
      ...freeInference([2, 0, 0], GROUND_PLANE),
      primary: { kind: 'onAxis', point: [2, 0, 0], axis: 'x', dir: [1, 0, 0], color: SNAP_COLORS.axisX, label: 'On Red Axis' },
      tooltip: 'On Red Axis',
      lines: [{ a: [0, 0, 0], b: [5, 0, 0], color: SNAP_COLORS.axisX, dashed: true }],
    };
    tools.pointerMove(at([2, 0, 0], { inference: onAxis }));
    const ov = tools.overlay();
    expect(ov.find((o) => o.kind === 'polyline' && o.points.length === 2 && !o.dashed)).toMatchObject({ color: SNAP_COLORS.axisX });
    expect(ov.find((o) => o.kind === 'cursorHint')).toMatchObject({ text: 'On Red Axis' });
    expect(ov.find((o) => o.kind === 'polyline' && o.dashed)).toBeDefined();
    expect(ov.find((o) => o.kind === 'point' && o.shape === 'square')).toBeDefined();
  });
});

describe('RectangleTool', () => {
  it('two clicks on the ground make 4 edges and a face of the right size', () => {
    const { tools, sketch, host } = setup();
    tools.activate('rectangle');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([2, 3, 0]));
    expect(tools.status()).toMatchObject({ instructor: 'Select opposite corner or enter value.', vcbLabel: 'Dimensions' });
    expect(tools.status().vcbValue).toBe(`6' 6 3/4", 9' 10 1/8"`);
    expect(tools.overlay().filter((o) => o.kind === 'polygon')).toHaveLength(1);
    tools.click(at([2, 3, 0]));
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
    expect(vertexPositions(sketch()).sort()).toEqual([[0, 0, 0], [0, 3, 0], [2, 0, 0], [2, 3, 0]].sort());
    expect(host.undoStack.length).toBe(1);
    expect(tools.status().instructor).toBe('Select first corner.');
  });

  it('VCB 2,3 after the commit re-sizes the last rectangle with a single undo step', () => {
    const { tools, sketch, host } = setup();
    tools.activate('rectangle');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 1.5, 0]));
    expect(host.undoStack.length).toBe(1);
    const v = parseVcb('2m,3m', 'in');
    if (v.ok) tools.onVcb(v.value);
    expect(host.undoStack.length).toBe(1);
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
    expect(vertexPositions(sketch()).sort()).toEqual([[0, 0, 0], [0, 3, 0], [2, 0, 0], [2, 3, 0]].sort());
    // either side omitted keeps the current value; negative flips
    const v2 = parseVcb(',-1m', 'in');
    if (v2.ok) tools.onVcb(v2.value);
    expect(host.undoStack.length).toBe(1);
    expect(vertexPositions(sketch()).sort()).toEqual([[0, -1, 0], [0, 0, 0], [2, -1, 0], [2, 0, 0]].sort());
    expect((tools.get('rectangle') as RectangleTool).lastParams).toMatchObject({ a: [0, 0, 0], c: [2, -1, 0] });
    // VCB while dragging commits with the typed dimensions
    tools.click(at([5, 5, 0]));
    tools.pointerMove(at([5.5, 5.5, 0]));
    const v3 = parseVcb('1m,1m', 'in');
    if (v3.ok) tools.onVcb(v3.value);
    expect(host.undoStack.length).toBe(2);
    expect(sketch().faces.size).toBe(2);
  });

  it('shows Square / Golden Section hints within 2 px and snaps to them', () => {
    const { tools, sketch } = setup();
    tools.activate('rectangle');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([2, 2.01, 0])); // 1 px off (0.01 m/px)
    let hint = tools.overlay().find((o) => o.kind === 'cursorHint');
    expect(hint).toMatchObject({ text: 'Square' });
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.dashed)).toBe(true);
    tools.pointerMove(at([2, 2.05, 0])); // 5 px off → no hint
    hint = tools.overlay().find((o) => o.kind === 'cursorHint');
    expect(hint).toBeUndefined();
    tools.pointerMove(at([1, 1.618, 0]));
    expect(tools.overlay().find((o) => o.kind === 'cursorHint')).toMatchObject({ text: 'Golden Section' });
    tools.pointerMove(at([2, 2.01, 0]));
    tools.click(at([2, 2.01, 0]));
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[2, 2, 0]]));
  });

  it('uses the hovered face plane or the arrow-key plane lock', () => {
    const { tools, sketch } = setup();
    tools.activate('rectangle');
    // first click on a vertical body face (normal +x): the rectangle lies in the YZ plane
    const hit: PickHit = { ref: { kind: 'face', path: [], id: 1 as Id, faceId: 0 as FaceLocalId, region: null }, point: [1, 0, 0], t: 1, normal: [1, 0, 0], screenDist: 0 };
    tools.click(at([1, 0, 0], { hit }));
    tools.click(at([1, 2, 1], { inference: freeInference([1, 2, 1], { n: [1, 0, 0], d: -1 }) }));
    expect(sketch().faces.size).toBe(1);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[1, 2, 1], [1, 0, 1], [1, 2, 0]]));
    // arrow lock: ← locks the green (y) normal, so a second rectangle drawn from the ground is vertical
    expect(tools.keyDown(key('ArrowLeft'))).toBe(true);
    expect((tools.get('rectangle') as RectangleTool).planeLock).toBe('y');
    expect(tools.activeTool?.inferenceOptions?.().plane).toMatchObject({ n: [0, 1, 0] });
    tools.click(at([5, 5, 0]));
    tools.click(at([6, 5, 1]));
    expect(sketch().faces.size).toBe(2);
    expect(vertexPositions(sketch())).toEqual(expect.arrayContaining([[6, 5, 1], [5, 5, 1], [6, 5, 0]]));
  });
});

describe('SelectTool', () => {
  const FACE = faceHit(7, 0, [0, 0, 0]);
  const FACE2 = faceHit(7, 1, [1, 0, 0]);

  it('click selects a face hit, Ctrl adds, Shift toggles, empty click clears; hover exposes the ref', () => {
    const { tools, host } = setup();
    const changes: EntityRef[][] = [];
    host.selection.events.on('change', (e) => changes.push(e.refs));
    tools.activate('select');
    tools.pointerMove(at([0, 0, 0], { hit: FACE }));
    expect((tools.activeTool as SelectTool).hoverRef).toEqual(FACE.ref);
    tools.click(at([0, 0, 0], { hit: FACE }));
    expect(host.selection.refs).toEqual([FACE.ref]);
    tools.click(at([1, 0, 0], { hit: FACE2, modifiers: CTRL }));
    expect(host.selection.size).toBe(2);
    tools.click(at([0, 0, 0], { hit: FACE, modifiers: SHIFT }));
    expect(host.selection.refs).toEqual([FACE2.ref]);
    tools.click(at([0, 0, 0], { hit: FACE, modifiers: SHIFT }));
    expect(host.selection.size).toBe(2);
    tools.click(at([1, 0, 0], { hit: FACE2, modifiers: { ...CTRL, shift: true } }));
    expect(host.selection.refs).toEqual([FACE.ref]);
    tools.click(at([3, 3, 0]));
    expect(host.selection.isEmpty).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(6);
    expect(host.undoStack.length).toBe(0); // selection is not undoable
  });

  it('double-click a sketch face selects it with its edges, triple-click all connected, body face → body', () => {
    const { tools, host, registry, sketch } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    registry.execute('sketch.addEdge', { a: [1, 1, 0], b: [2, 2, 0] });
    registry.execute('sketch.addEdge', { a: [5, 5, 0], b: [6, 6, 0] }); // not connected
    const face = [...sketch().faces.values()][0]!;
    const faceRef: EntityRef = { kind: 'sketchFace', path: [], id: face.id };
    const hit: PickHit = { ref: faceRef, point: [0.5, 0.5, 0], t: 1, normal: [0, 0, 1], screenDist: 0 };
    tools.activate('select');
    const select = tools.activeTool as SelectTool;
    let t = 0;
    select.now = () => t;
    tools.doubleClick(at([0.5, 0.5, 0], { hit }));
    expect(host.selection.size).toBe(5);
    expect(host.selection.has(faceRef)).toBe(true);
    // click, click, (dblclick), click within 400 ms → triple
    tools.click(at([0.5, 0.5, 0], { hit }));
    t += 100;
    tools.click(at([0.5, 0.5, 0], { hit }));
    tools.doubleClick(at([0.5, 0.5, 0], { hit }));
    t += 100;
    tools.click(at([0.5, 0.5, 0], { hit }));
    expect(host.selection.size).toBe(6); // 4 rect edges + diagonal + face, not the far edge
    tools.doubleClick(at([0, 0, 0], { hit: FACE }));
    expect(host.selection.refs).toEqual([{ kind: 'body', path: [], id: 7 }]);
  });

  it('drag box uses the engine pickBox when present (window vs crossing) and Delete erases the selection', () => {
    const calls: unknown[] = [];
    const engine = {
      pickBox(rect: unknown) {
        calls.push(rect);
        return [{ kind: 'sketchEdge', path: [], id: 99 as Id }];
      },
    };
    const { tools, host, registry, sketch } = setup([[SERVICE_INFERENCE, engine]]);
    tools.activate('select');
    tools.pointerDown(at([0, 0, 0]));
    tools.pointerMove(at([1, -1, 0], { button: -1, buttons: 1 }));
    expect(tools.overlay()).toEqual([expect.objectContaining({ kind: 'screenRect', dashed: false })]);
    tools.pointerUp(at([1, -1, 0]));
    tools.click(at([1, -1, 0])); // the browser click after a drag is ignored
    expect(calls).toEqual([{ min: [400, 300], max: [500, 400], mode: 'window' }]);
    expect(host.selection.size).toBe(1);
    tools.pointerDown(at([1, -1, 0]));
    tools.pointerMove(at([0, 0, 0], { button: -1, buttons: 1 }));
    expect(tools.overlay()).toEqual([expect.objectContaining({ kind: 'screenRect', dashed: true })]);
    tools.pointerUp(at([0, 0, 0]));
    expect(calls[1]).toMatchObject({ mode: 'crossing' });

    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const edgeId = [...sketch().edges.keys()][0]!;
    host.selection.set([{ kind: 'sketchEdge', path: [], id: edgeId }]);
    expect(tools.keyDown(key('Delete'))).toBe(true);
    expect(sketch().edges.size).toBe(3);
    expect(sketch().faces.size).toBe(0);
    expect(host.selection.isEmpty).toBe(true);
    expect(tools.keyDown(key('Backspace'))).toBe(true); // nothing selected: consumed, no-op
  });
});

describe('LassoTool', () => {
  function lassoSetup() {
    const calls: { outline: readonly Vec2[]; mode: string }[] = [];
    const engine = {
      pickLasso(outline: readonly Vec2[], mode: string) {
        calls.push({ outline, mode });
        return [{ kind: 'sketchEdge', path: [], id: 99 as Id }];
      },
    };
    return { calls, ...setup([[SERVICE_INFERENCE, engine]]) };
  }

  it('is registered as tool.lasso and judges direction as seen on screen', () => {
    const { registry } = lassoSetup();
    expect(registry.has('tool.lasso')).toBe(true);
    const clockwise: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]]; // right, then down the screen
    expect(lassoModeOf(clockwise)).toBe('crossing');
    expect(lassoModeOf([...clockwise].reverse())).toBe('window');
  });

  it('a freehand drag closes on release and selects; clockwise crosses, dashed while drawn', () => {
    const { tools, host, calls } = lassoSetup();
    tools.activate('lasso');
    tools.pointerDown(at([0, 0, 0]));
    for (const p of [[1, 0, 0], [1, -1, 0], [0, -1, 0]] as Vec3[]) tools.pointerMove(at(p, { button: -1, buttons: 1 }));
    expect(tools.overlay()).toEqual([expect.objectContaining({ kind: 'screenPolyline', dashed: true, closed: true })]);
    tools.pointerUp(at([0, -1, 0]));
    tools.click(at([0, -1, 0])); // the browser click after a drag is ignored
    expect(calls).toEqual([{ outline: [[400, 300], [500, 300], [500, 400], [400, 400]], mode: 'crossing' }]);
    expect(host.selection.refs).toEqual([{ kind: 'sketchEdge', path: [], id: 99 }]);
    expect(tools.overlay()).toEqual([]);
  });

  it('clicked points close on double-click or Enter with Select modifiers; Esc drops the outline', () => {
    const { tools, host, calls } = lassoSetup();
    host.selection.set([{ kind: 'sketchEdge', path: [], id: 1 as Id }]);
    tools.activate('lasso');
    // counterclockwise on screen: up, then left
    for (const p of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 0]] as Vec3[]) tools.click(at(p));
    expect((tools.activeTool as LassoTool).outline).toHaveLength(3);
    tools.doubleClick(at([1, 1, 0], { modifiers: CTRL }));
    expect(calls[0]).toMatchObject({ mode: 'window' });
    expect(host.selection.size).toBe(2); // Ctrl added to the existing selection

    for (const p of [[0, 0, 0], [1, 0, 0], [1, 1, 0]] as Vec3[]) tools.click(at(p));
    expect(tools.keyDown(key('Enter', { ...CTRL, shift: true }))).toBe(true);
    expect(host.selection.refs).toEqual([{ kind: 'sketchEdge', path: [], id: 1 }]); // Ctrl+Shift removed it

    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.keyDown(key('Escape'));
    expect((tools.activeTool as LassoTool).outline).toHaveLength(0);
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.doubleClick(at([1, 0, 0])); // two points are no outline
    expect(calls).toHaveLength(2);
    expect(host.selection.size).toBe(1);
  });
});

describe('EraserTool', () => {
  function rectangle(registry: CommandRegistry) {
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
  }

  it('drag across two edges removes both (and the face) in one undo step', () => {
    const { tools, host, registry, sketch } = setup();
    rectangle(registry);
    const [e1, e2] = [...sketch().edges.keys()];
    tools.activate('eraser');
    tools.pointerDown(at([0.5, 0, 0], { hit: edgeHit(e1!, [0.5, 0, 0]) }));
    tools.pointerMove(at([0.7, 0.2, 0], { button: -1, buttons: 1 }));
    tools.pointerMove(at([1, 0.5, 0], { button: -1, buttons: 1, hit: edgeHit(e2!, [1, 0.5, 0]) }));
    expect((tools.activeTool as EraserTool).markedRefs).toHaveLength(2);
    expect(tools.overlay().filter((o) => o.kind === 'polyline')).toHaveLength(2);
    tools.pointerUp(at([1, 0.5, 0], { hit: edgeHit(e2!, [1, 0.5, 0]) }));
    tools.click(at([1, 0.5, 0], { hit: edgeHit(e2!, [1, 0.5, 0]) })); // trailing click ignored
    expect(sketch().edges.size).toBe(2);
    expect(sketch().faces.size).toBe(0);
    expect(host.undoStack.length).toBe(2);
    host.undo();
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
  });

  it('Shift hides, Ctrl softens, Ctrl+Shift unsoftens; body edges are a no-op with a message', () => {
    const { tools, registry, sketch } = setup();
    rectangle(registry);
    const e1 = [...sketch().edges.keys()][0]!;
    tools.activate('eraser');
    tools.click(at([0.5, 0, 0], { hit: edgeHit(e1, [0.5, 0, 0]), modifiers: SHIFT }));
    expect(sketch().edges.get(e1)).toMatchObject({ hidden: true, soft: false });
    tools.click(at([0.5, 0, 0], { hit: edgeHit(e1, [0.5, 0, 0]), modifiers: CTRL }));
    expect(sketch().edges.get(e1)).toMatchObject({ soft: true, smooth: true });
    tools.click(at([0.5, 0, 0], { hit: edgeHit(e1, [0.5, 0, 0]), modifiers: { ...CTRL, shift: true } }));
    expect(sketch().edges.get(e1)).toMatchObject({ soft: false, smooth: false });
    expect(sketch().edges.size).toBe(4);
    const bodyEdge: PickHit = { ref: { kind: 'edge', path: [], id: 3 as Id, edgeKey: '0:1:0' }, point: [0, 0, 0], t: 1, screenDist: 1 };
    tools.click(at([0, 0, 0], { hit: bodyEdge }));
    expect(tools.status().instructor).toMatch(/Edges of a solid cannot be erased/);
    expect(sketch().edges.size).toBe(4);
  });
});
