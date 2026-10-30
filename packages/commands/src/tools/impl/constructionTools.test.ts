// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec2, Vec3 } from '@pushform/core';
import { formatLength, v3eq } from '@pushform/core';
import { freeInference, GROUND_PLANE, SNAP_COLORS } from '@pushform/inference';
import type { InferenceResult, PickHit } from '@pushform/inference';
import { DEFAULT_AXES, SketchGraph } from '@pushform/model';
import type { Guide } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { editCommands } from '../../registry/editCommands';
import { sketchCommands } from '../../commands/sketch';
import { guideCommands } from '../../commands/guides';
import { axesCommands } from '../../commands/axes';
import { offsetCommands } from '../../commands/offset';
import { DocumentHost } from '../../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../../host/services';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS } from '../Tool';
import type { Modifiers, ToolPointerEvent } from '../Tool';
import { parseVcb } from '../../vcb/parse';
import { constructionTools } from '../constructionTools';
import type { TapeTool } from './Tape';
import type { ProtractorTool } from './Protractor';
import type { AxesTool } from './AxesTool';
import type { OffsetTool } from './Offset';

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

function setup() {
  const host = new DocumentHost();
  const camera = new StubCamera();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(editCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(guideCommands);
  registry.registerAll(axesCommands);
  registry.registerAll(offsetCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of constructionTools()) tools.register(t);
  const root = () => host.doc.rootDefinition.entities;
  const sketch = () => root().sketch;
  const guides = (): Guide[] => [...root().guides.values()];
  /** Unit square on the ground; returns the id of the bottom edge (0,0)→(1,0). */
  const square = (): Id => {
    host.edit('Square', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [1, 0, 0]);
      g.addEdge([1, 0, 0], [1, 1, 0]);
      g.addEdge([1, 1, 0], [0, 1, 0]);
      g.addEdge([0, 1, 0], [0, 0, 0]);
    });
    const s = sketch();
    for (const e of s.edges.values()) {
      const a = s.vertices.get(e.a)!.p, b = s.vertices.get(e.b)!.p;
      if (a[1] === 0 && b[1] === 0) return e.id;
    }
    throw new Error('bottom edge not found');
  };
  return { host, registry, tools, root, sketch, guides, square };
}

/** Pointer event at world point `p` (screen = 100 px per metre from the origin) with a stub inference. */
function at(
  p: Vec3,
  opts: { button?: number; modifiers?: Modifiers; hit?: PickHit | null; inference?: InferenceResult } = {},
): ToolPointerEvent {
  const screen: Vec2 = [400 + p[0] * 100, 300 - p[1] * 100];
  const button = opts.button ?? 0;
  return {
    screen,
    ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
    button,
    buttons: button === 0 ? 1 : 0,
    modifiers: opts.modifiers ?? NO_MODIFIERS,
    inference: opts.inference ?? freeInference(p, GROUND_PLANE, opts.hit ?? null),
    camera: CAMERA,
  };
}

const edgeHit = (id: Id, p: Vec3): PickHit => ({ ref: { kind: 'sketchEdge', path: [], id }, point: p, t: 10, screenDist: 1 });
const sketchFaceHit = (id: Id, p: Vec3): PickHit => ({ ref: { kind: 'sketchFace', path: [], id }, point: p, t: 10, normal: [0, 0, 1], screenDist: 0 });

const key = (k: string, modifiers: Modifiers = NO_MODIFIERS) => ({ key: k, code: k, modifiers, repeat: false });
const vcb = (s: string) => {
  const v = parseVcb(s, 'm');
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  return v.value;
};
const ALT: Modifiers = { ...NO_MODIFIERS, alt: true };

describe('TapeTool', () => {
  it('creates a guide line parallel to an edge at a typed offset', () => {
    const { tools, guides, square, host } = setup();
    const bottom = square();
    tools.activate('tape');
    const tape = tools.activeTool as TapeTool;
    expect(tape.mode).toBe('guideLine');
    tools.click(at([0.5, 0, 0], { hit: edgeHit(bottom, [0.5, 0, 0]) }));
    expect(tape.anchor).toEqual([0.5, 0, 0]);
    tools.pointerMove(at([0.5, 0.3, 0]));
    expect(tools.status()).toMatchObject({ vcbLabel: 'Length', vcbValue: formatLength(0.3, host.doc.state.meta.units) });
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.dashed)).toBe(true);
    tools.onVcb(vcb('0.5'));
    const g = guides();
    expect(g).toHaveLength(1);
    const line = g[0]!;
    expect(line.kind).toBe('line');
    if (line.kind !== 'line') return;
    expect(line.origin[1]).toBeCloseTo(0.5);
    expect(line.origin[2]).toBeCloseTo(0);
    expect(Math.abs(line.dir[0])).toBeCloseTo(1);
    expect(line.dir[1]).toBeCloseTo(0);
    expect(tape.anchor).toBeNull();
    expect(host.undoStack.peek()?.label).toBe('Guide Line');
    // clicking instead of typing also works (offset through the clicked point)
    tools.click(at([0.2, 0, 0], { hit: edgeHit(bottom, [0.2, 0, 0]) }));
    tools.pointerMove(at([0.2, -0.25, 0]));
    tools.click(at([0.2, -0.25, 0]));
    expect(guides()).toHaveLength(2);
    const second = guides()[1]!;
    if (second.kind === 'line') expect(second.origin[1]).toBeCloseTo(-0.25);
    expect(host.undo()).toBe(true);
    expect(guides()).toHaveLength(1);
  });

  it('cycles to Guide Points with Ctrl and places a guide point with a leader', () => {
    const { tools, guides } = setup();
    tools.activate('tape');
    const tape = tools.activeTool as TapeTool;
    expect(tools.keyDown(key('Control'))).toBe(true);
    expect(tape.mode).toBe('guidePoint');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 1, 0]));
    tools.click(at([1, 1, 0]));
    const g = guides();
    expect(g.map((x) => x.kind).sort()).toEqual(['point', 'segment']);
    const pt = g.find((x) => x.kind === 'point')!;
    expect(pt.origin).toEqual([1, 1, 0]);
    // typed distance along the cursor direction
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([2, 0, 0]));
    tools.onVcb(vcb('3'));
    const pts = guides().filter((x) => x.kind === 'point');
    expect(pts).toHaveLength(2);
    expect(pts[1]!.origin[0]).toBeCloseTo(3);
  });

  it('Down arrow locks the tape parallel to the last inferred edge, and a typed distance places the guide point along it', () => {
    const { tools, guides } = setup();
    tools.activate('tape');
    tools.keyDown(key('Control')); // guide point mode
    tools.click(at([0, 0, 0]));
    const onEdge: InferenceResult = { ...freeInference([3, 1, 0], GROUND_PLANE),
      primary: { kind: 'onEdge', point: [3, 1, 0], dir: [0, 1, 0], color: SNAP_COLORS.onEdge, label: 'On Edge' } };
    tools.pointerMove(at([3, 1, 0], { inference: onEdge }));
    tools.pointerMove(at([0.1, 1, 0]));
    expect(tools.keyDown(key('ArrowDown'))).toBe(true);
    expect(tools.activeTool?.inferenceOptions?.()).toMatchObject({ lockAxis: null, lockSnap: { kind: 'parallel', point: [0, 0, 0], dir: [0, 1, 0] } });
    tools.onVcb(vcb('2'));
    const pts = guides().filter((x) => x.kind === 'point');
    expect(pts).toHaveLength(1);
    expect(pts[0]!.origin[0]).toBeCloseTo(0);
    expect(pts[0]!.origin[1]).toBeCloseTo(2);
    expect(tools.activeTool?.inferenceOptions?.().lockSnap).toBeNull();
  });

  it('measures, reads the distance in the VCB and proposes a model resize', () => {
    const { tools, square, host, sketch, guides } = setup();
    square();
    tools.activate('tape');
    const tape = tools.activeTool as TapeTool;
    tools.keyDown(key('Control'));
    tools.keyDown(key('Control'));
    expect(tape.mode).toBe('measure');
    // hovering an edge reads its length
    const bottom = [...sketch().edges.values()][0]!;
    tools.pointerMove(at([0.5, 0, 0], { hit: edgeHit(bottom.id, [0.5, 0, 0]) }));
    expect(tools.status().vcbValue).toBe(formatLength(1, host.doc.state.meta.units));
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([3, 4, 0]));
    expect(tools.status().vcbValue).toBe(formatLength(5, host.doc.state.meta.units));
    tools.click(at([3, 4, 0]));
    expect(tape.lastMeasure?.length).toBeCloseTo(5);
    expect(guides()).toHaveLength(0);
    expect(tape.pendingResize).toBeNull();
    tools.onVcb(vcb('10'));
    expect(tape.pendingResize?.factor).toBeCloseTo(2);
    expect(tools.status().instructor).toMatch(/Resize model/);
    const entries = host.undoStack.length;
    expect(tape.confirmResize()).toBe(true);
    expect(tape.pendingResize).toBeNull();
    expect(host.undoStack.length).toBe(entries + 1);
    const xs = [...sketch().vertices.values()].map((v) => v.p[0]).sort();
    expect(xs).toEqual([0, 0, 2, 2]);
    expect(tape.lastMeasure?.length).toBeCloseTo(10);
    expect(host.undo()).toBe(true);
    expect([...sketch().vertices.values()].map((v) => v.p[0]).sort()).toEqual([0, 0, 1, 1]);
  });
});

describe('ProtractorTool', () => {
  it('places a guide line at 30° from the baseline (VCB) and Ctrl toggles guide creation', () => {
    const { tools, guides } = setup();
    tools.activate('protractor');
    const pro = tools.activeTool as ProtractorTool;
    tools.click(at([0, 0, 0]));
    expect(pro.center).toEqual([0, 0, 0]);
    expect(v3eq(pro.planeNormal, [0, 0, 1])).toBe(true);
    tools.click(at([1, 0, 0]));
    tools.pointerMove(at([2, 2, 0]));
    expect(tools.status().vcbLabel).toBe('Angle');
    expect(pro.angle).toBeCloseTo(45);
    expect(tools.overlay().length).toBeGreaterThan(20); // protractor ring + ticks
    tools.onVcb(vcb('30deg'));
    const g = guides();
    expect(g).toHaveLength(1);
    const line = g[0]!;
    if (line.kind !== 'line') throw new Error('expected a line');
    expect(line.origin).toEqual([0, 0, 0]);
    expect(line.dir[0]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(line.dir[1]).toBeCloseTo(Math.sin(Math.PI / 6));
    expect(pro.center).toBeNull();
    // rise:run and 15° snapping inside the protractor radius (0.6 m here)
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.pointerMove(at([0.3, 0.3, 0]));
    expect(pro.angle).toBeCloseTo(45);
    tools.pointerMove(at([0.3, 0.2, 0]));
    expect(pro.angle).toBeCloseTo(30);
    tools.onVcb(vcb('1:1'));
    expect(guides()).toHaveLength(2);
    // Ctrl turns guide creation off
    tools.keyDown(key('Control'));
    expect(pro.guidesEnabled).toBe(false);
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.click(at([2, 2, 0]));
    expect(guides()).toHaveLength(2);
  });
});

describe('AxesTool', () => {
  it('sets the axes from origin, red and green clicks; reset restores the defaults', () => {
    const { tools, host, registry } = setup();
    tools.activate('axes');
    tools.click(at([1, 1, 0]));
    tools.click(at([2, 1, 0]));
    tools.click(at([1, 2, 0]));
    const axes = host.doc.rootDefinition.axes;
    expect(axes.origin).toEqual([1, 1, 0]);
    expect(axes.x).toEqual([1, 0, 0]);
    expect(axes.y).toEqual([0, 1, 0]);
    expect(axes.z).toEqual([0, 0, 1]);
    expect(host.undoStack.peek()?.label).toBe('Place Axes');
    // double-click moves the origin and keeps the orientation
    tools.doubleClick(at([3, 3, 0]));
    expect(host.doc.rootDefinition.axes.origin).toEqual([3, 3, 0]);
    expect(host.doc.rootDefinition.axes.x).toEqual([1, 0, 0]);
    // Alt: place green first, then blue; red follows right-handedly
    const tool = tools.activeTool as AxesTool;
    tools.keyDown(key('Alt', ALT));
    expect(tool.firstAxis).toBe('y');
    tools.click(at([0, 0, 0]));
    tools.click(at([-1, 0, 0]));
    tools.click(at([0, 0, 1]));
    const a2 = host.doc.rootDefinition.axes;
    expect(a2.y).toEqual([-1, 0, 0]);
    expect(a2.z).toEqual([0, 0, 1]);
    expect(a2.x.map((x) => Math.round(x) + 0)).toEqual([0, 1, 0]); // y × z, right-handed
    registry.execute('axes.reset');
    expect(host.doc.rootDefinition.axes).toEqual(DEFAULT_AXES);
    expect(host.undo()).toBe(true);
    expect(host.doc.rootDefinition.axes.y).toEqual([-1, 0, 0]);
  });
});

describe('OffsetTool', () => {
  it('offsets a sketch face inward by the cursor distance: an inner face forms (2 faces)', () => {
    const { tools, sketch, square, host } = setup();
    square();
    const face = [...sketch().faces.values()][0]!;
    tools.activate('offset');
    const tool = tools.activeTool as OffsetTool;
    tools.pointerMove(at([0.5, 0.5, 0], { hit: sketchFaceHit(face.id, [0.5, 0.5, 0]) }));
    expect(tools.overlay().some((o) => o.kind === 'polygon')).toBe(true);
    tools.click(at([0.5, 0.5, 0], { hit: sketchFaceHit(face.id, [0.5, 0.5, 0]) }));
    tools.pointerMove(at([0.5, 0.1, 0]));
    expect(tool.dragDistance).toBeCloseTo(-0.1);
    expect(tools.status().vcbValue).toBe(formatLength(-0.1, host.doc.state.meta.units));
    const entries = host.undoStack.length;
    tools.click(at([0.5, 0.1, 0]));
    expect(sketch().faces.size).toBe(2);
    expect(sketch().edges.size).toBe(8);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Offset');
    const inner = [...sketch().faces.values()].find((f) => f.id !== face.id)!;
    const xs = inner.loops[0]!.map((r) => sketch().vertices.get(sketch().edges.get(r.edgeId)!.a)!.p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0.1);
    expect(Math.max(...xs)).toBeCloseTo(0.9);
    expect(sketch().faces.get(face.id)!.loops).toHaveLength(2); // the original got a hole
    // typing a new value re-applies the last offset (undo + redo, no extra entry)
    tools.onVcb(vcb('0.2'));
    expect(host.undoStack.length).toBe(entries + 1);
    expect(sketch().faces.size).toBe(2);
    const inner2 = [...sketch().faces.values()].find((f) => f.id !== face.id)!;
    const xs2 = inner2.loops[0]!.map((r) => sketch().vertices.get(sketch().edges.get(r.edgeId)!.a)!.p[0]);
    expect(Math.min(...xs2)).toBeCloseTo(0.2);
    // outward offset grows a new face around the original
    tools.click(at([0.5, 0.5, 0], { hit: sketchFaceHit(face.id, [0.5, 0.5, 0]) }));
    tools.pointerMove(at([0.5, -0.3, 0]));
    expect(tool.dragDistance).toBeCloseTo(0.3);
    tools.click(at([0.5, -0.3, 0]));
    expect(sketch().faces.size).toBe(3);
  });

  it('offsets preselected connected edges as a parallel polyline', () => {
    const { tools, sketch, host } = setup();
    host.edit('L', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [1, 0, 0]);
      g.addEdge([1, 0, 0], [1, 1, 0]);
    });
    host.selection.set([...sketch().edges.keys()].map((id) => ({ kind: 'sketchEdge', path: [], id })));
    tools.activate('offset');
    expect(tools.status().instructor).toMatch(/selected edges/);
    tools.click(at([0.5, 0.5, 0]));
    tools.pointerMove(at([1.5, 0.5, 0])); // right of travel along the second edge
    expect((tools.activeTool as OffsetTool).dragDistance).toBeCloseTo(0.5);
    tools.onVcb(vcb('0.1'));
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(0);
    const xs = [...sketch().vertices.values()].map((v) => +v.p[0].toFixed(6));
    expect(xs).toContain(1.1);
  });
});
