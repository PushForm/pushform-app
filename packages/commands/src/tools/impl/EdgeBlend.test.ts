// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Ray, Vec3 } from '@pushform/core';
import { v3dist } from '@pushform/core';
import { tessellateCircle } from '@pushform/geom';
import type { InferenceResult } from '@pushform/inference';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import type { Body, EdgeRecord, EntityContainer, EntityRef } from '@pushform/model';
import { CommandRegistry } from '../../registry/CommandRegistry';
import { editCommands } from '../../registry/editCommands';
import type { CameraHost, CameraState } from '../../camera/CameraHost';
import { DocumentHost } from '../../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../../host/services';
import { modelCommands } from '../../commands/model';
import { pushPullCommands } from '../../commands/pushpull';
import { sketchCommands } from '../../commands/sketch';
import { curveCommands, type AddCurveInput } from '../../commands/curves';
import { edgeBlendCommands } from '../../commands/edgeBlend';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS, type Modifiers, type Tool, type ToolPointerEvent } from '../Tool';
import { edgeBlendTools, type EdgeBlendTool } from './EdgeBlend';

class FakeCamera implements CameraHost {
  state: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
  getState(): CameraState {
    return this.state;
  }
  setState(s: CameraState): void {
    this.state = s;
  }
  viewportSize(): { width: number; height: number } {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 0], dir: [0, 0, -1] };
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

/** Stand-in for Select: `tool.select` must exist for the second Esc to return to it. */
const selectStub: Tool = { id: 'select', title: 'Select', activate() {}, deactivate() {}, onCancel() {}, overlay: () => [], status: () => ({ instructor: '', vcbLabel: '' }) };

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const k of kernels.splice(0)) k.dispose();
});

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const camera = new FakeCamera();
  const services = new Map<string, unknown>([
    [SERVICE_DOCUMENT, host],
    [SERVICE_KERNEL, kernel],
  ]);
  const registry = new CommandRegistry({ tx: host, camera, services });
  for (const c of [editCommands, modelCommands, sketchCommands, curveCommands, pushPullCommands, edgeBlendCommands]) registry.registerAll(c);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  tools.register(selectStub);
  for (const t of edgeBlendTools()) tools.register(t);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const body = (id: number): Body => root().bodies.get(id as never)!;
  const fillet = tools.get('fillet') as EdgeBlendTool;
  const chamfer = tools.get('chamfer') as EdgeBlendTool;
  return { host, registry, tools, root, body, fillet, chamfer };
}

const addBox = (registry: CommandRegistry): number => registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;

function edgeAt(body: Body, a: Vec3, b: Vec3): EdgeRecord {
  const e = [...body.edges.values()].find((r) => {
    const p = r.polyline[0]!, q = r.polyline[r.polyline.length - 1]!;
    return (v3dist(p, a) < 1e-6 && v3dist(q, b) < 1e-6) || (v3dist(p, b) < 1e-6 && v3dist(q, a) < 1e-6);
  });
  if (!e) throw new Error('edge not found');
  return e;
}

/** A pointer event whose inference hit is `ref`. */
function at(ref: EntityRef | null, modifiers: Partial<Modifiers> = {}): ToolPointerEvent {
  const inference = ref ? ({ hit: { ref, point: [0, 0, 0], t: 1, screenDist: 0 } } as unknown as InferenceResult) : null;
  return {
    screen: [0, 0],
    ray: { origin: [0, 0, 10], dir: [0, 0, -1] },
    button: 0,
    buttons: 0,
    modifiers: { ...NO_MODIFIERS, ...modifiers },
    inference,
    camera: new FakeCamera().state,
  };
}

const edgeRef = (bodyId: number, e: EdgeRecord): EntityRef => ({ kind: 'edge', path: [], id: bodyId as never, edgeKey: e.key });

describe('Fillet and Chamfer tools', () => {
  it('hovers and clicks hard edges; Shift-click toggles; Esc clears, a second Esc leaves the tool', () => {
    const { registry, tools, body, chamfer } = setup();
    const id = addBox(registry);
    const e1 = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    const e2 = edgeAt(body(id), [1, 0, 1], [1, 1, 1]);
    tools.activate('chamfer');
    tools.pointerMove(at(edgeRef(id, e1)));
    expect(chamfer.hoverEdges).toEqual([e1.key]);
    expect(tools.overlay().length).toBeGreaterThan(0);
    tools.click(at(edgeRef(id, e1)));
    tools.click(at(edgeRef(id, e2)));
    expect(chamfer.edgeSet).toEqual([e1.key, e2.key]);
    tools.click(at(edgeRef(id, e1)));
    expect(chamfer.edgeSet).toEqual([e1.key, e2.key]);
    tools.click(at(edgeRef(id, e1), { shift: true }));
    expect(chamfer.edgeSet).toEqual([e2.key]);
    tools.click(at(edgeRef(id, e1), { shift: true }));
    expect(chamfer.edgeSet).toEqual([e2.key, e1.key]);
    // a face under the cursor is not an edge
    tools.click(at({ kind: 'face', path: [], id: id as never, faceId: e1.faceA, region: null }));
    expect(chamfer.edgeSet).toHaveLength(2);
    tools.cancel();
    expect(chamfer.edgeSet).toEqual([]);
    expect(tools.activeToolId).toBe('chamfer');
    tools.cancel();
    expect(tools.activeToolId).toBe('select');
  });

  it('never offers soft, smooth or hidden edges', () => {
    const { host, registry, tools, body, fillet } = setup();
    const id = addBox(registry);
    const e1 = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    host.edit('Smooth', (draft) => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id as never)!.edges.get(e1.key)!;
      e.smooth = true;
    });
    tools.activate('fillet');
    tools.pointerMove(at(edgeRef(id, e1)));
    expect(fillet.hoverEdges).toEqual([]);
    tools.click(at(edgeRef(id, e1)));
    expect(fillet.edgeSet).toEqual([]);
  });

  it('picks an edge of a curve as the whole curve loop', async () => {
    const { registry, tools, root, body, fillet } = setup();
    const t = tessellateCircle([0, 0, 0], [0, 0, 1], 1, 24);
    registry.execute('sketch.addCurve', { points: t.points, closed: true, curve: t.curve } satisfies AddCurveInput);
    const face = [...root().sketch.faces.values()][0]!;
    await registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: face.id }, distance: face.plane.n[2] > 0 ? 1 : -1, mode: 'merge' });
    const id = [...root().bodies.keys()][0]! as number;
    const cyl = body(id);
    const top = [...cyl.faces.values()].find((f) => f.plane.n[2] > 0.99)!;
    const capEdge = [...cyl.edges.values()].find((e) => (e.faceA === top.id || e.faceB === top.id) && e.curveId !== null)!;
    tools.activate('fillet');
    tools.click(at(edgeRef(id, capEdge)));
    expect(fillet.edgeSet).toHaveLength(24);
    tools.click(at(edgeRef(id, capEdge), { shift: true }));
    expect(fillet.edgeSet).toHaveLength(0);
  });

  it('starts with the hard edges selected beforehand', () => {
    const { host, registry, tools, body, fillet } = setup();
    const id = addBox(registry);
    const e1 = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    const e2 = edgeAt(body(id), [0, 0, 0], [1, 0, 0]);
    host.selection.set([edgeRef(id, e1), edgeRef(id, e2), { kind: 'body', path: [], id: id as never }]);
    tools.activate('fillet');
    expect(fillet.edgeSetBodyId).toBe(id);
    expect([...fillet.edgeSet].sort()).toEqual([e1.key, e2.key].sort());
  });

  it('takes the radius and segments in the Measurements box, remembers them, previews and commits as one undo step', async () => {
    const { host, registry, tools, body, fillet } = setup();
    const id = addBox(registry);
    const e1 = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    tools.activate('fillet');
    expect(tools.status().vcbLabel).toBe('Radius');
    tools.click(at(edgeRef(id, e1)));
    // Enter without a radius explains what is missing
    expect(tools.keyDown({ key: 'Enter', code: 'Enter', modifiers: NO_MODIFIERS, repeat: false })).toBe(true);
    await fillet.settled;
    expect(fillet.message).toMatch(/radius/);
    tools.onVcb({ kind: 'length', meters: 0.25, raw: 0.25, unit: null });
    tools.onVcb({ kind: 'segments', count: 12 });
    expect(fillet.size).toBe(0.25);
    expect(fillet.segments).toBe(12);
    expect(fillet.message).toBeNull();
    await fillet.previewSettled();
    expect(fillet.previewMeshes).toHaveLength(1);
    expect(fillet.previewReplacesBodyId).toBe(id);
    const entries = host.undoStack.length;
    tools.doubleClick(at(edgeRef(id, e1)));
    await fillet.settled;
    expect(fillet.message).toBeNull();
    expect(fillet.edgeSet).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Fillet');
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeLessThan(1);
    // 12 segments per circle: a quarter round of 3 faces
    expect([...b.faces.values()].filter((f) => f.surfaceId !== null)).toHaveLength(3);
    // the value is remembered for the session, also across tool switches
    tools.activate('select');
    tools.activate('fillet');
    expect(fillet.size).toBe(0.25);
    expect(tools.status().vcbValue).toBeDefined();
    expect(host.undo()).toBe(true);
    expect(body(id).props.volume).toBeCloseTo(1, 9);
  });

  it('explains a distance that is too large, changes nothing and keeps the edge set', async () => {
    const { host, registry, tools, body, chamfer } = setup();
    const id = addBox(registry);
    const e1 = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    tools.activate('chamfer');
    tools.click(at(edgeRef(id, e1)));
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: null });
    await chamfer.previewSettled();
    expect(chamfer.previewMeshes).toHaveLength(0);
    expect(chamfer.message).toMatch(/too large/);
    const version = body(id).version;
    const entries = host.undoStack.length;
    tools.keyDown({ key: 'Enter', code: 'Enter', modifiers: NO_MODIFIERS, repeat: false });
    await chamfer.settled;
    expect(chamfer.message).toMatch(/too large/);
    expect(tools.status().instructor).toMatch(/too large/);
    expect(chamfer.edgeSet).toEqual([e1.key]);
    expect(body(id).version).toBe(version);
    expect(host.undoStack.length).toBe(entries);
  });
});
