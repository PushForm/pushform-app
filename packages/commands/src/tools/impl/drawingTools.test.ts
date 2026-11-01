// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec2, Vec3 } from '@pushform/core';
import { v3dist } from '@pushform/core';
import { freeInference, GROUND_PLANE, SNAP_COLORS } from '@pushform/inference';
import type { InferenceResult, PickHit } from '@pushform/inference';
import type { Body, Sketch } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { editCommands } from '../../registry/editCommands';
import { sketchCommands } from '../../commands/sketch';
import { curveCommands } from '../../commands/curves';
import { modelCommands } from '../../commands/model';
import { DocumentHost } from '../../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../../host/services';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS } from '../Tool';
import type { Modifiers, ToolPointerEvent } from '../Tool';
import { parseVcb } from '../../vcb/parse';
import { drawingTools } from '../drawingTools';
import { LineTool } from './Line';
import { RectangleTool } from './Rectangle';
import type { CircleTool } from './Circle';
import type { PolygonTool } from './Polygon';
import type { TwoPointArcTool } from './TwoPointArc';
import type { FreehandTool } from './Freehand';
import type { RotatedRectangleTool } from './RotatedRectangle';

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
  registry.registerAll(curveCommands);
  registry.registerAll(modelCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of drawingTools()) tools.register(t);
  tools.register(new LineTool());
  tools.register(new RectangleTool());
  const sketch = (): Sketch => host.doc.rootDefinition.entities.sketch;
  const bodies = (): Body[] => [...host.doc.rootDefinition.entities.bodies.values()];
  return { host, registry, tools, sketch, bodies };
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

const key = (k: string, modifiers: Modifiers = NO_MODIFIERS) => ({ key: k, code: k, modifiers, repeat: false });

function vcb(tools: ToolManager, text: string): void {
  const v = parseVcb(text, 'in');
  expect(v.ok).toBe(true);
  if (v.ok) tools.onVcb(v.value);
}

const near = (a: Vec3, b: Vec3, tol = 1e-6): boolean => v3dist(a, b) <= tol;
const hasVertex = (s: Sketch, p: Vec3): boolean => [...s.vertices.values()].some((v) => near(v.p, p));

describe('CircleTool', () => {
  it('center + radius → 24 edges, 1 face, 1 Curve record; 12s before the click → 12 sides', () => {
    const { tools, sketch, host } = setup();
    tools.activate('circle');
    expect(tools.status()).toMatchObject({ instructor: 'Select center point.', vcbLabel: 'Sides', vcbValue: '24' });
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 0, 0]));
    expect(tools.status()).toMatchObject({ instructor: 'Select point on circle or enter value.', vcbLabel: 'Diameter' });
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.closed && o.points.length === 24)).toBe(true);
    tools.click(at([1, 0, 0]));
    expect(sketch().edges.size).toBe(24);
    expect(sketch().faces.size).toBe(1);
    expect(sketch().curves.size).toBe(1);
    const curve = [...sketch().curves.values()][0]!;
    expect(curve).toMatchObject({ kind: 'circle', radius: 1, segments: 24 });
    expect(curve.edgeRefs).toHaveLength(24);
    for (const e of sketch().edges.values()) expect(e.curveId).toBe(curve.id);
    expect(hasVertex(sketch(), [1, 0, 0])).toBe(true); // first vertex follows the cursor
    expect(host.undoStack.length).toBe(1);
    expect(tools.status().instructor).toBe('Select center point.');

    // VCB after the commit re-edits the same circle (one undo step)
    vcb(tools, '12s');
    expect(sketch().edges.size).toBe(12);
    expect(sketch().faces.size).toBe(1);
    expect(host.undoStack.length).toBe(1);
    expect((tools.get('circle') as CircleTool).segments).toBe(12);
    // a bare length is the diameter, `r` a radius
    vcb(tools, '4m');
    expect(hasVertex(sketch(), [2, 0, 0])).toBe(true);
    expect([...sketch().curves.values()][0]).toMatchObject({ radius: 2, segments: 12 });
    vcb(tools, '2mr');
    expect([...sketch().curves.values()][0]).toMatchObject({ radius: 2, segments: 12 });

    // `8s` re-edits the last circle too; a bare `8` would be a diameter re-edit now that a circle exists
    vcb(tools, '8s');
    expect(sketch().edges.size).toBe(8);
    expect(host.undoStack.length).toBe(1);
    // the session setting carries to the next circle; a diameter typed while dragging
    tools.click(at([5, 5, 0]));
    tools.pointerMove(at([5, 6, 0]));
    expect(tools.status().fields).toMatchObject([{ id: 'diameter', label: 'Diameter', kind: 'length' }]);
    vcb(tools, '1m');
    expect(sketch().curves.size).toBe(2);
    expect([...sketch().curves.values()][1]).toMatchObject({ radius: 0.5, segments: 8 });
    expect(sketch().faces.size).toBe(2);
  });

  it('draws on a body face as imprint edges carrying the curve id', () => {
    const { tools, registry, bodies, sketch } = setup();
    const bodyId = registry.execute('model.addBox', { min: [0, 0, 0], max: [4, 4, 1] }) as number;
    const body = bodies()[0]!;
    expect(body.id).toBe(bodyId);
    const top = [...body.faces.values()].find((f) => f.plane.n[2] > 0.5)!;
    const hit: PickHit = { ref: { kind: 'face', path: [], id: bodyId as Id, faceId: top.id, region: null }, point: [2, 2, 1], t: 9, normal: [0, 0, 1], screenDist: 0 };
    tools.activate('circle');
    tools.click(at([2, 2, 1], { hit, inference: freeInference([2, 2, 1], { n: [0, 0, 1], d: -1 }, hit) }));
    tools.click(at([3, 2, 1], { inference: freeInference([3, 2, 1], { n: [0, 0, 1], d: -1 }, hit) }));
    const after = bodies()[0]!;
    const graph = after.imprints.get(top.id);
    expect(graph?.edges.size).toBe(24);
    expect(after.curves.size).toBe(1);
    const curve = [...after.curves.values()][0]!;
    for (const e of graph!.edges.values()) expect(e.curveId).toBe(curve.id);
    expect(curve.edgeRefs).toHaveLength(24);
    expect(sketch().edges.size).toBe(0);
  });

  it('arrow keys lock the plane, Esc cancels the centre and keeps the tool', () => {
    const { tools, sketch } = setup();
    tools.activate('circle');
    expect(tools.keyDown(key('ArrowRight'))).toBe(true);
    expect((tools.get('circle') as CircleTool).planeLock).toBe('x');
    expect(tools.activeTool?.inferenceOptions?.().plane).toMatchObject({ n: [1, 0, 0] });
    tools.click(at([0, 0, 0]));
    tools.click(at([0, 1, 1], { inference: freeInference([0, 1, 1], { n: [1, 0, 0], d: 0 }) }));
    expect(sketch().faces.size).toBe(1);
    for (const v of sketch().vertices.values()) expect(v.p[0]).toBeCloseTo(0, 9);
    tools.click(at([5, 5, 0]));
    expect(tools.activeTool?.inferenceOptions?.().anchor).toEqual([5, 5, 0]);
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('circle');
    expect(tools.activeTool?.inferenceOptions?.().anchor).toBeUndefined();
    expect(sketch().curves.size).toBe(1);
  });
});

describe('PolygonTool', () => {
  it('draws a hexagon (6 edges, 1 face, polygon curve); Ctrl toggles circumscribed', () => {
    const { tools, sketch } = setup();
    tools.activate('polygon');
    expect(tools.status().vcbValue).toBe('6');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    expect(sketch().edges.size).toBe(6);
    expect(sketch().faces.size).toBe(1);
    expect([...sketch().curves.values()][0]).toMatchObject({ kind: 'polygon', segments: 6, radius: 1 });
    expect(hasVertex(sketch(), [1, 0, 0])).toBe(true);
    const poly = tools.get('polygon') as PolygonTool;
    tools.click(at([5, 5, 0]));
    expect(tools.keyDown(key('Control'))).toBe(true);
    expect(poly.circumscribed).toBe(true);
    tools.click(at([6, 5, 0]));
    const c = [...sketch().curves.values()][1]!;
    expect(c.radius).toBeCloseTo(1 / Math.cos(Math.PI / 6), 9);
    expect(hasVertex(sketch(), [5 + c.radius, 5, 0])).toBe(true);
  });
});

describe('ArcTool / PieTool', () => {
  it('center, radius point, end angle → 12 edges and no face; typed diameter then angle', () => {
    const { tools, sketch } = setup();
    tools.activate('arc');
    tools.click(at([0, 0, 0]));
    expect(tools.status()).toMatchObject({ instructor: 'Select point on arc or enter diameter.', vcbLabel: 'Diameter' });
    tools.click(at([1, 0, 0]));
    expect(tools.status().vcbLabel).toBe('Angle');
    tools.pointerMove(at([0, 1, 0]));
    expect(tools.status().vcbValue).toBe('90.0°');
    tools.click(at([0, 1, 0]));
    expect(sketch().edges.size).toBe(12);
    expect(sketch().faces.size).toBe(0);
    expect([...sketch().curves.values()][0]).toMatchObject({ kind: 'arc', radius: 1, segments: 12 });
    expect(hasVertex(sketch(), [0, 1, 0])).toBe(true);
    // typed diameter then typed angle
    tools.click(at([5, 5, 0]));
    tools.pointerMove(at([6, 5, 0]));
    vcb(tools, '4m');
    expect(tools.status().vcbLabel).toBe('Angle');
    vcb(tools, '180');
    expect(sketch().curves.size).toBe(2);
    expect(hasVertex(sketch(), [7, 5, 0])).toBe(true);
    expect(hasVertex(sketch(), [3, 5, 0])).toBe(true);
  });

  it('pie closes through the centre and makes a face', () => {
    const { tools, sketch } = setup();
    tools.activate('pie');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.click(at([0, 1, 0]));
    expect(sketch().edges.size).toBe(14);
    expect(sketch().faces.size).toBe(1);
    expect(sketch().curves.size).toBe(1);
    expect([...sketch().curves.values()][0]!.edgeRefs).toHaveLength(12);
    expect([...sketch().edges.values()].filter((e) => e.curveId === null)).toHaveLength(2);
  });
});

describe('TwoPointArcTool', () => {
  it('start, end, bulge → N edges and no face; half-circle hint; VCB radius', () => {
    const { tools, sketch } = setup();
    tools.activate('arc2');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([2, 0, 0]));
    expect(tools.status()).toMatchObject({ instructor: 'Select end point of arc or enter length.', vcbLabel: 'Length' });
    tools.click(at([2, 0, 0]));
    expect(tools.status().vcbLabel).toBe('Bulge');
    tools.pointerMove(at([1, 1.01, 0])); // 1 px from a half circle (0.01 m / px)
    expect(tools.overlay().find((o) => o.kind === 'cursorHint')).toMatchObject({ text: 'Half Circle' });
    tools.pointerMove(at([1, 0.5, 0]));
    expect(tools.overlay().find((o) => o.kind === 'cursorHint')).toBeUndefined();
    tools.click(at([1, 0.5, 0]));
    expect(sketch().edges.size).toBe(12);
    expect(sketch().faces.size).toBe(0);
    const curve = [...sketch().curves.values()][0]!;
    expect(curve.kind).toBe('arc');
    expect(curve.radius).toBeCloseTo(1.25, 9); // r = (c² + 4s²) / 8s with c = 2, s = 0.5
    expect(hasVertex(sketch(), [1, 0.5, 0])).toBe(true);
    expect((tools.get('arc2') as TwoPointArcTool).lastRadius).toBeCloseTo(1.25, 9);
    // `20s` after the commit re-tessellates
    vcb(tools, '20s');
    expect(sketch().edges.size).toBe(20);
    // typed radius in the bulge stage
    tools.click(at([5, 0, 0]));
    tools.click(at([7, 0, 0]));
    tools.pointerMove(at([6, -0.2, 0]));
    vcb(tools, '1mr');
    expect(sketch().curves.size).toBe(2);
    expect(hasVertex(sketch(), [6, -1, 0])).toBe(true); // half circle below the chord
  });

  it('starting at the end of an arc infers Tangent at Vertex', () => {
    const { tools, sketch } = setup();
    tools.activate('arc');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    tools.click(at([0, 1, 0])); // quarter arc ending at (0,1,0) with tangent (-1,0,0)
    tools.activate('arc2');
    tools.click(at([0, 1, 0], { inference: endpointAt([0, 1, 0]) }));
    const arc2 = tools.get('arc2') as TwoPointArcTool;
    expect(arc2.tangentDir).toBeDefined();
    expect(arc2.tangentDir![0]).toBeCloseTo(-1, 9);
    tools.pointerMove(at([-2, 1, 0]));
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.color === SNAP_COLORS.tangent)).toBe(false); // collinear → straight
    tools.pointerMove(at([-1, 2, 0]));
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.color === SNAP_COLORS.tangent)).toBe(true);
    tools.click(at([-1, 2, 0]));
    // tangent arc from (0,1) to (-1,2) with tangent (-1,0): centre (0,2), sagitta = r(1 - cos45°)
    const s = 1 - Math.SQRT1_2;
    tools.pointerMove(at([-0.5 - s * Math.SQRT1_2 + 0.01, 1.5 - s * Math.SQRT1_2, 0]));
    expect(tools.overlay().find((o) => o.kind === 'cursorHint')).toMatchObject({ text: 'Tangent at Vertex' });
    tools.click(at([-0.5 - s * Math.SQRT1_2 + 0.01, 1.5 - s * Math.SQRT1_2, 0]));
    const c = [...sketch().curves.values()][1]!;
    expect(c.radius).toBeCloseTo(1, 6);
    expect(c.center[0]).toBeCloseTo(0, 6);
    expect(c.center[1]).toBeCloseTo(2, 6);
  });

  it('double-click a rectangle corner replaces it with a fillet of the last radius', () => {
    const { tools, sketch, registry, host } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [2, 0, 0], c: [2, 2, 0], d: [0, 2, 0] });
    tools.activate('arc2');
    const arc2 = tools.get('arc2') as TwoPointArcTool;
    arc2.lastRadius = 0.5;
    const entries = host.undoStack.length;
    tools.doubleClick(at([2, 2, 0], { inference: endpointAt([2, 2, 0]) }));
    expect(sketch().edges.size).toBe(2 + 2 + 12);
    expect(sketch().faces.size).toBe(1);
    expect(sketch().curves.size).toBe(1);
    expect(hasVertex(sketch(), [2, 2, 0])).toBe(false);
    expect(hasVertex(sketch(), [1.5, 2, 0])).toBe(true);
    expect(hasVertex(sketch(), [2, 1.5, 0])).toBe(true);
    const c = [...sketch().curves.values()][0]!;
    expect(c.radius).toBeCloseTo(0.5, 9);
    expect(c.center[0]).toBeCloseTo(1.5, 9);
    expect(c.center[1]).toBeCloseTo(1.5, 9);
    expect(host.undoStack.length).toBe(entries + 1);
    // the browser click pair before a dblclick must not leave a dangling arc
    tools.click(at([0, 0, 0], { inference: endpointAt([0, 0, 0]) }));
    tools.click(at([0, 0, 0], { inference: endpointAt([0, 0, 0]) }));
    tools.doubleClick(at([0, 0, 0], { inference: endpointAt([0, 0, 0]) }));
    expect(sketch().curves.size).toBe(2);
    expect(sketch().faces.size).toBe(1);
    expect(tools.status().instructor).toMatch(/Select start point/);
  });
});

describe('ThreePointArcTool', () => {
  it('start, pivot, end → arc through the three points', () => {
    const { tools, sketch } = setup();
    tools.activate('arc3');
    tools.click(at([-1, 0, 0]));
    tools.click(at([0, 1, 0]));
    tools.pointerMove(at([1, 0, 0]));
    expect(tools.status()).toMatchObject({ vcbLabel: 'Radius', vcbValue: `3' 3 3/8"` });
    tools.click(at([1, 0, 0]));
    expect(sketch().edges.size).toBe(12);
    expect(sketch().faces.size).toBe(0);
    const c = [...sketch().curves.values()][0]!;
    expect(c.radius).toBeCloseTo(1, 9);
    expect(hasVertex(sketch(), [0, 1, 0])).toBe(true);
    expect(hasVertex(sketch(), [1, 0, 0])).toBe(true);
  });
});

describe('FreehandTool', () => {
  it('press-drag-release welds the samples into one freehand curve; closing on the start makes a face', () => {
    const { tools, sketch, host } = setup();
    tools.activate('freehand');
    const fh = tools.get('freehand') as FreehandTool;
    tools.pointerDown(at([0, 0, 0]));
    expect(fh.isDrawing).toBe(true);
    tools.pointerMove(at([0.01, 0, 0], { button: -1, buttons: 1 })); // 1 px: ignored
    tools.pointerMove(at([0.5, 0.2, 0], { button: -1, buttons: 1 }));
    tools.pointerMove(at([1, 0, 0], { button: -1, buttons: 1 }));
    tools.pointerMove(at([1.5, 0.4, 0], { button: -1, buttons: 1 }));
    expect(fh.sampleCount).toBe(4);
    expect(tools.overlay().some((o) => o.kind === 'polyline' && o.points.length === 4)).toBe(true);
    tools.pointerUp(at([2, 0, 0]));
    tools.click(at([2, 0, 0])); // browser click after the release is ignored
    expect(sketch().curves.size).toBe(1);
    const c = [...sketch().curves.values()][0]!;
    expect(c.kind).toBe('freehand');
    expect(c.edgeRefs).toHaveLength(4);
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(0);
    expect(host.undoStack.length).toBe(1);

    tools.pointerDown(at([5, 5, 0]));
    tools.pointerMove(at([6, 5, 0], { button: -1, buttons: 1 }));
    tools.pointerMove(at([6, 6, 0], { button: -1, buttons: 1 }));
    tools.pointerMove(at([5, 6, 0], { button: -1, buttons: 1 }));
    tools.pointerUp(at([5, 5.02, 0])); // 2 px from the start → closed
    expect(sketch().curves.size).toBe(2);
    expect(sketch().faces.size).toBe(1);
    expect([...sketch().curves.values()][1]!.edgeRefs).toHaveLength(4);
    expect(sketch().edges.size).toBe(8);

    // Esc mid-stroke discards it
    tools.pointerDown(at([8, 8, 0]));
    tools.pointerMove(at([9, 8, 0], { button: -1, buttons: 1 }));
    tools.keyDown(key('Escape'));
    expect(fh.isDrawing).toBe(false);
    tools.pointerUp(at([9, 9, 0]));
    expect(sketch().curves.size).toBe(2);
  });
});

describe('RotatedRectangleTool', () => {
  it('corner, first edge, then width,angle → 4 edges and 1 face tilted about the first edge', () => {
    const { tools, sketch, host } = setup();
    tools.activate('rotrect');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([2, 0, 0]));
    expect(tools.status()).toMatchObject({ instructor: 'Select second corner or enter length.', vcbLabel: 'Length' });
    tools.click(at([2, 0, 0]));
    expect(tools.status().vcbLabel).toBe('Width, Angle');
    tools.pointerMove(at([2, 1, 0]));
    expect(tools.status().vcbValue).toBe(`3' 3 3/8", 0.0°`);
    expect(tools.overlay().filter((o) => o.kind === 'polygon')).toHaveLength(1);
    vcb(tools, '1m,45');
    expect(sketch().edges.size).toBe(4);
    expect(sketch().faces.size).toBe(1);
    const h = Math.SQRT1_2;
    expect(hasVertex(sketch(), [2, h, h])).toBe(true);
    expect(hasVertex(sketch(), [0, h, h])).toBe(true);
    expect(host.undoStack.length).toBe(1);
    // re-edit after the commit
    vcb(tools, ',90');
    expect(host.undoStack.length).toBe(1);
    expect(hasVertex(sketch(), [2, 0, 1])).toBe(true);
    expect((tools.get('rotrect') as RotatedRectangleTool).lastParams).toMatchObject({ width: 1, angleDeg: 90 });
    // a plain click in the protractor plane draws flat
    tools.click(at([5, 5, 0]));
    tools.click(at([7, 5, 0]));
    tools.click(at([7, 6.5, 0]));
    expect(sketch().faces.size).toBe(2);
    expect(hasVertex(sketch(), [5, 6.5, 0])).toBe(true);
  });

  it('Shift keeps the first edge direction and VCB length sets it', () => {
    const { tools, sketch } = setup();
    tools.activate('rotrect');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 1, 0]));
    expect(tools.keyDown(key('Shift'))).toBe(true);
    tools.pointerMove(at([3, 1, 0]));
    vcb(tools, '2m');
    tools.keyUp(key('Shift'));
    tools.click(at([-1, 1, 0], { inference: freeInference([-1, 1, 0], GROUND_PLANE) }));
    expect(sketch().faces.size).toBe(1);
    expect(hasVertex(sketch(), [Math.SQRT2, Math.SQRT2, 0])).toBe(true);
  });
});

describe('curve commands', () => {
  it('setCurveSegments / setCurveRadius re-tessellate in place and the face survives; explode and weld', () => {
    const { tools, sketch, registry } = setup();
    tools.activate('circle');
    tools.click(at([0, 0, 0]));
    tools.click(at([1, 0, 0]));
    const id = [...sketch().curves.keys()][0]!;
    registry.execute('sketch.setCurveSegments', { curveId: id, segments: 8 });
    expect(sketch().edges.size).toBe(8);
    expect(sketch().faces.size).toBe(1);
    expect(sketch().curves.get(id)).toMatchObject({ segments: 8 });
    expect(sketch().curves.get(id)!.edgeRefs).toHaveLength(8);
    registry.execute('sketch.setCurveRadius', { curveId: id, radius: 2 });
    expect(sketch().faces.size).toBe(1);
    expect(hasVertex(sketch(), [2, 0, 0])).toBe(true);
    registry.execute('sketch.explodeCurve', { curveId: id });
    expect(sketch().curves.size).toBe(0);
    for (const e of sketch().edges.values()) expect(e.curveId).toBeNull();
    expect(sketch().faces.size).toBe(1);
    const welded = registry.execute('sketch.weld', { edgeIds: [...sketch().edges.keys()] }) as number;
    expect(sketch().curves.get(welded as never)).toMatchObject({ kind: 'freehand', segments: 8 });
    for (const e of sketch().edges.values()) expect(e.curveId).toBe(welded);
    registry.execute('sketch.addEdge', { a: [5, 5, 0], b: [6, 6, 0] });
    expect(() => registry.execute('sketch.weld', { edgeIds: [...sketch().edges.keys()] })).toThrow(/chain/);
  });
});

describe('value fields', () => {
  const entry = (tools: ToolManager, values: Record<string, string>) =>
    tools.onEntry(Object.fromEntries(Object.entries(values).map(([k, t]) => {
      const v = parseVcb(t, 'in');
      if (!v.ok) throw new Error(t);
      return [k, v.value];
    })));
  const ids = (tools: ToolManager) => (tools.status().fields ?? []).map((f) => f.id);

  it('Line shows Length and Angle fields and takes either or both', () => {
    const { tools, sketch } = setup();
    tools.activate('line');
    expect(ids(tools)).toEqual([]);
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 1, 0]));
    expect(ids(tools)).toEqual(['length', 'angle']);
    expect(tools.status().fields![1]!.value).toBe('45.0°');
    expect(tools.overlay().filter((o) => o.kind === 'polyline').length).toBeGreaterThan(3); // dimension lines and arc
    // angle only keeps the pointer's distance
    entry(tools, { angle: '90' });
    expect(hasVertex(sketch(), [0, Math.SQRT2, 0])).toBe(true);
    // both from the new start point
    tools.pointerMove(at([3, 3, 0]));
    entry(tools, { length: '2m', angle: '-90' });
    expect(hasVertex(sketch(), [0, Math.SQRT2 - 2, 0])).toBe(true);
  });

  it('Line locks a length left with Tab and keeps it while the pointer sets the angle', () => {
    const { tools, sketch } = setup();
    tools.activate('line');
    tools.click(at([0, 0, 0]));
    const v = parseVcb('3m', 'in');
    if (v.ok) tools.lockEntry('length', v.value);
    tools.pointerMove(at([0, 5, 0]));
    expect(tools.status().fields![0]).toMatchObject({ id: 'length', locked: true });
    tools.click(at([0, 5, 0]));
    expect(hasVertex(sketch(), [0, 3, 0])).toBe(true);
    expect(tools.status().fields?.[0]?.locked).toBe(false);
  });

  it('Line drops the Angle field when the end leaves the drawing plane', () => {
    const { tools } = setup();
    tools.activate('line');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([0, 0, 2]));
    expect(ids(tools)).toEqual(['length']);
  });

  it('Rectangle shows Width and Height, keeps the pointer side and locks a typed width', () => {
    const { tools, sketch } = setup();
    tools.activate('rectangle');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([-1, 2, 0]));
    expect(tools.status().fields!.map((f) => f.label)).toEqual(['Width', 'Height']);
    entry(tools, { width: '3m' });
    expect(hasVertex(sketch(), [-3, 2, 0])).toBe(true);
    tools.click(at([10, 0, 0]));
    const w = parseVcb('4m', 'in');
    if (w.ok) tools.lockEntry('width', w.value);
    tools.pointerMove(at([11, 1, 0]));
    tools.click(at([11, 1, 0]));
    expect(hasVertex(sketch(), [14, 1, 0])).toBe(true);
  });

  it('Arc takes a diameter and then shows the Angle field on the sweep', () => {
    const { tools } = setup();
    tools.activate('pie');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 0, 0]));
    expect(ids(tools)).toEqual(['diameter']);
    vcb(tools, '4m');
    tools.pointerMove(at([0, 3, 0]));
    const f = tools.status().fields![0]!;
    expect(f).toMatchObject({ id: 'angle', value: '90.0°' });
    expect(f.at![0]).toBeGreaterThan(0);
    expect(f.at![1]).toBeGreaterThan(0);
  });

  it('a single-value tool without onEntry receives the typed value through onVcb', () => {
    const { tools, sketch } = setup();
    tools.activate('circle');
    tools.click(at([0, 0, 0]));
    tools.pointerMove(at([1, 0, 0]));
    entry(tools, { diameter: '6m' });
    expect([...sketch().curves.values()][0]).toMatchObject({ radius: 3 });
  });
});
