// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Box3, ImageId, MaterialId, PlaneBasis, Ray, Vec2, Vec3 } from '@pushform/core';
import { basisToLocal, v3eq } from '@pushform/core';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import { freeInference, GROUND_PLANE, type InferenceResult, type PickHit } from '@pushform/inference';
import { allocId, computeRegions, createImprintGraph, sketchFaceLoops, SketchGraph, uvApply, uvToAffine, type Body, type Draft, type EntityContainer, type FaceRecord, type ImprintGraph, type UvMapping } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState, Projection, StandardView } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { ToolManager } from '../tools/ToolManager';
import { NO_MODIFIERS, type ToolPointerEvent } from '../tools/Tool';
import { pushPullTools, type PushPullTool } from '../tools/impl/PushPull';
import { modelCommands } from './model';
import { pushPullCommands, type PushPullApplyResult } from './pushpull';

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
  standardView(_v: StandardView): void {}
  setProjection(_p: Projection): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

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
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(pushPullCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of pushPullTools()) tools.register(t);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const bodies = (): Body[] => [...root().bodies.values()];
  return { host, kernel, registry, tools, root, bodies };
}

const topFace = (body: Body): FaceRecord => {
  const f = [...body.faces.values()].find((r) => v3eq(r.plane.n, [0, 0, 1]));
  if (!f) throw new Error('no +z face');
  return f;
};

function addBox(registry: CommandRegistry, min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]): number {
  return registry.execute('model.addBox', { min, max }) as number;
}

async function apply(registry: CommandRegistry, params: unknown): Promise<PushPullApplyResult> {
  return (await registry.execute('pushpull.apply', params)) as PushPullApplyResult;
}

describe('pushpull.apply', () => {
  it('gives the caps the texture coordinates of the sheet sides they come from', async () => {
    const { host, registry, root, bodies } = setup();
    const tile = { widthM: 0.5, heightM: 0.25 };
    host.edit('Rectangle', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([2, 0, 0], [2, 1, 0]);
      g.addEdge([2, 1, 0], [0, 1, 0]);
      g.addEdge([0, 1, 0], [0, 0, 0]);
    });
    let front = 0 as MaterialId, back = 0 as MaterialId;
    host.edit('Texture', (draft) => {
      front = allocId<MaterialId>(draft);
      back = allocId<MaterialId>(draft);
      for (const id of [front, back]) draft.materials.set(id, { id, name: `T${id}`, color: [1, 1, 1], alpha: 1, texture: { imageId: 1 as ImageId, ...tile, colorize: false } });
      const f = [...draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.faces.values()][0]!;
      Object.assign(f, { frontMaterialId: front, backMaterialId: back, uv: { kind: 'affine', matrix: [1, 0.5, 0.3, -0.2, 2, 0.1] }, uvBack: { kind: 'affine', matrix: [-1, 0, 0.7, 0, 3, 0] } });
    });
    const sheet = [...root().sketch.faces.values()][0]!;
    const points = sketchFaceLoops(root().sketch, sheet)[0]!;
    const st = (basis: PlaneBasis, uv: UvMapping, p: Vec3): number[] => {
      const l = basisToLocal(basis, p);
      return [...uvApply(uvToAffine(uv, tile.widthM, tile.heightM), l[0], l[1])];
    };
    // The sheet faces down (n = -Z): its front becomes the bottom cap, its back the top cap 1 m up.
    expect(sheet.plane.n[2]).toBeCloseTo(-1);
    await apply(registry, { target: { kind: 'sketchFace', path: [], id: sheet.id }, distance: -1, mode: 'merge' });
    const body = bodies()[0]!;
    const capOf = (id: MaterialId): FaceRecord => [...body.faces.values()].find((f) => f.frontMaterialId === id)!;
    for (const p of points) {
      const top: Vec3 = [p[0], p[1], p[2] + 1];
      st(capOf(front).basis, capOf(front).uv, p).forEach((x, i) => expect(x).toBeCloseTo(st(sheet.basis, sheet.uv, p)[i]!, 9));
      st(capOf(back).basis, capOf(back).uv, top).forEach((x, i) => expect(x).toBeCloseTo(st(sheet.basis, sheet.uvBack!, p)[i]!, 9));
    }
  });

  it('extrudes a sketch rectangle into one body and removes the sheet (undo restores it)', async () => {
    const { host, registry, root, bodies } = setup();
    host.edit('Rectangle', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([2, 0, 0], [2, 1, 0]);
      g.addEdge([2, 1, 0], [0, 1, 0]);
      g.addEdge([0, 1, 0], [0, 0, 0]);
    });
    expect(root().sketch.faces.size).toBe(1);
    expect(root().sketch.edges.size).toBe(4);
    const face = [...root().sketch.faces.values()][0]!;
    const entriesBefore = host.undoStack.length;

    const res = await apply(registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 1, mode: 'merge' });
    expect(res.bodyIds).toHaveLength(1);
    expect(bodies()).toHaveLength(1);
    const body = bodies()[0]!;
    expect(body.id).toBe(res.bodyIds[0]);
    expect(body.props.volume).toBeCloseTo(2 * 1 * 1, 6);
    expect(body.faces.size).toBe(6);
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(root().sketch.faces.size).toBe(0);
    expect(root().sketch.edges.size).toBe(0);
    expect(root().sketch.vertices.size).toBe(0);
    expect(host.undoStack.length).toBe(entriesBefore + 1);
    expect(host.undoStack.peek()?.label).toBe('Push/Pull');

    expect(host.undo()).toBe(true);
    expect(bodies()).toHaveLength(0);
    expect(root().sketch.faces.get(face.id)?.id).toBe(face.id);
    expect(root().sketch.edges.size).toBe(4);
  });

  it('pulls the whole top face of a box by 1: volume 2, top face keeps its id', async () => {
    const { host, registry, root } = setup();
    const bodyId = addBox(registry);
    const before = root().bodies.get(bodyId as never)!;
    const top = topFace(before);
    const entries = host.undoStack.length;

    const res = await apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: top.id, region: null }, distance: 1, mode: 'merge' });
    expect(res.bodyIds).toEqual([bodyId]);
    const after = root().bodies.get(bodyId as never)!;
    expect(after.version).toBe(before.version + 1);
    expect(after.props.volume).toBeCloseTo(2, 6);
    expect(after.faces.size).toBe(6);
    const topAfter = after.faces.get(top.id)!;
    expect(v3eq(topAfter.plane.n, [0, 0, 1])).toBe(true);
    for (const p of topAfter.loops[0]!) expect(p[2]).toBeCloseTo(2, 6);
    expect(meshTopologyProblems(after.mesh)).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('pushes an imprinted 0.2 square region through the box: through-hole of volume 0.96', async () => {
    const { host, registry, root } = setup();
    const bodyId = addBox(registry);
    const top = topFace(root().bodies.get(bodyId as never)!);
    const uv = (x: number, y: number): [number, number] => {
      const l = basisToLocal(top.basis, [x, y, 1]);
      return [l[0], l[1]];
    };
    host.edit('Imprint', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId as never)!;
      const g = createImprintGraph();
      const pts = [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)];
      pts.forEach((p, i) => g.vertices.set(i + 1, p));
      for (let i = 0; i < 4; i++) {
        g.edges.set(i + 10, { id: i + 10, a: i + 1, b: ((i + 1) % 4) + 1, soft: false, smooth: false, hidden: false, curveId: null });
      }
      g.nextId = 20;
      body.imprints.set(top.id, g as unknown as Draft<ImprintGraph>);
    });
    const body = root().bodies.get(bodyId as never)!;
    const regions = computeRegions(body, top.id);
    expect(regions).toHaveLength(2);
    const inner = regions.reduce((a, b) => (b.area < a.area ? b : a));
    expect(inner.area).toBeCloseTo(0.04, 9);

    const res = await apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: top.id, region: inner.index }, distance: -1, mode: 'merge' });
    expect(res.bodyIds).toEqual([bodyId]);
    const after = root().bodies.get(bodyId as never)!;
    expect(after.props.volume).toBeCloseTo(1 - 0.04, 6);
    expect(after.faces.size).toBe(10);
    expect(meshTopologyProblems(after.mesh)).toEqual([]);
    // The hole loop is real geometry now: the imprint edges on its boundary are gone.
    expect(after.imprints.get(top.id)).toBeUndefined();
    expect(after.faces.get(top.id)!.loops).toHaveLength(2);
  });
});

describe('PushPullTool', () => {
  const faceHit = (bodyId: number, face: FaceRecord, point: Vec3): PickHit => ({
    ref: { kind: 'face', path: [], id: bodyId as never, faceId: face.id, region: null },
    point,
    t: 1,
    normal: face.plane.n,
    screenDist: 0,
  });
  const pe = (screen: Vec2, button: number, inference: InferenceResult | null): ToolPointerEvent => ({
    screen,
    ray: { origin: [screen[0] / 100, screen[1] / 100, 5], dir: [0, 0, -1] },
    button,
    buttons: button === 0 ? 1 : 0,
    modifiers: NO_MODIFIERS,
    inference,
    camera: { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'perspective', orthoHeight: 1 },
  });

  it('drag-release pulls 0.5, VCB re-edits to 2 with one undo entry, Esc cancels a drag', async () => {
    const { host, registry, tools, root } = setup();
    const bodyId = addBox(registry);
    const entries = host.undoStack.length;
    const body = (): Body => root().bodies.get(bodyId as never)!;
    tools.activate('pushpull');
    const tool = tools.activeTool as PushPullTool;
    expect(tools.status().instructor).toBe('Select face to push or pull.');

    // hover highlights the face
    const top0 = topFace(body());
    tools.pointerMove(pe([100, 100], -1, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(bodyId, top0, [0.5, 0.5, 1]))));
    expect(tools.overlay().some((p) => p.kind === 'polygon')).toBe(true);

    // press on the face, drag 0.5 up along the normal, release
    tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(bodyId, top0, [0.5, 0.5, 1]))));
    tools.pointerMove(pe([100, 80], -1, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    expect(tools.status().instructor).toBe('Click or type distance.');
    expect(tools.status().vcbLabel).toBe('Distance');
    expect(tool.dragDistance).toBeCloseTo(0.5, 9);
    expect(tools.overlay().some((p) => p.kind === 'polyline')).toBe(true);
    tools.pointerUp(pe([100, 80], 0, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    await tool.settled;
    expect(body().props.volume).toBeCloseTo(1.5, 6);
    expect(host.undoStack.length).toBe(entries + 1);

    // typing a length right after the commit re-applies with the new distance, still one entry
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    await vi.waitFor(() => expect(body().props.volume).toBeCloseTo(3, 6));
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Push/Pull');
    expect(body().faces.size).toBe(6);

    // Esc during a drag leaves the model unchanged
    const top1 = topFace(body());
    tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 3], GROUND_PLANE, faceHit(bodyId, top1, [0.5, 0.5, 3]))));
    tools.pointerMove(pe([100, 60], -1, freeInference([0.5, 0.5, 4], GROUND_PLANE)));
    expect(tool.dragDistance).toBeCloseTo(1, 9);
    expect(tools.keyDown({ key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false })).toBe(true);
    expect(tool.dragDistance).toBeNull();
    await tool.settled;
    expect(body().props.volume).toBeCloseTo(3, 6);
    expect(host.undoStack.length).toBe(entries + 1);

    // undo restores the original box in one step
    expect(host.undo()).toBe(true);
    expect(body().props.volume).toBeCloseTo(1, 6);
  });

  it('hover highlight and ghost cap of a region with a hole leave the hole open', () => {
    const { host, registry, tools, root } = setup();
    const bodyId = addBox(registry);
    const top = topFace(root().bodies.get(bodyId as never)!);
    const uv = (x: number, y: number): [number, number] => {
      const l = basisToLocal(top.basis, [x, y, 1]);
      return [l[0], l[1]];
    };
    host.edit('Imprint', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId as never)!;
      const g = createImprintGraph();
      [uv(0.4, 0.4), uv(0.6, 0.4), uv(0.6, 0.6), uv(0.4, 0.6)].forEach((p, i) => g.vertices.set(i + 1, p));
      for (let i = 0; i < 4; i++) {
        g.edges.set(i + 10, { id: i + 10, a: i + 1, b: ((i + 1) % 4) + 1, soft: false, smooth: false, hidden: false, curveId: null });
      }
      g.nextId = 20;
      body.imprints.set(top.id, g as unknown as Draft<ImprintGraph>);
    });
    tools.activate('pushpull');
    const polygons = () => tools.overlay().filter((p) => p.kind === 'polygon');
    const hit = faceHit(bodyId, top, [0.2, 0.2, 1]);
    tools.pointerMove(pe([100, 100], -1, freeInference([0.2, 0.2, 1], GROUND_PLANE, hit)));
    const hover = polygons();
    expect(hover).toHaveLength(1);
    expect(hover[0]!.holes).toHaveLength(1);
    expect(hover[0]!.holes![0]!.every((p) => p[2] === 1)).toBe(true);

    tools.pointerDown(pe([100, 100], 0, freeInference([0.2, 0.2, 1], GROUND_PLANE, hit)));
    tools.pointerMove(pe([100, 80], -1, freeInference([0.2, 0.2, 1.5], GROUND_PLANE)));
    const cap = polygons().find((p) => p.points.every((q) => Math.abs(q[2] - 1.5) < 1e-9));
    expect(cap?.holes).toHaveLength(1);
    expect(cap!.holes![0]!.every((q) => Math.abs(q[2] - 1.5) < 1e-9)).toBe(true);
    tools.keyDown({ key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false });
  });

  it('click-move-click commits on the second click and reuses a matching kernel preview', async () => {
    const { registry, tools, root } = setup();
    const bodyId = addBox(registry);
    const body = (): Body => root().bodies.get(bodyId as never)!;
    tools.activate('pushpull');
    const tool = tools.activeTool as PushPullTool;
    const top = topFace(body());
    tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(bodyId, top, [0.5, 0.5, 1]))));
    tools.pointerUp(pe([100, 101], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(bodyId, top, [0.5, 0.5, 1]))));
    expect(tool.dragDistance).not.toBeNull();
    tools.pointerMove(pe([100, 40], -1, freeInference([0.5, 0.5, 1.25], GROUND_PLANE)));
    expect(tool.previewMeshes).toHaveLength(0);
    await vi.waitFor(() => expect(tool.previewMeshes).toHaveLength(1), { timeout: 3000 });
    expect(tool.previewReplacesBodyId).toBe(bodyId);
    expect(body().props.volume).toBeCloseTo(1, 6); // preview never touches the document
    tools.pointerDown(pe([100, 40], 0, freeInference([0.5, 0.5, 1.25], GROUND_PLANE)));
    expect(tool.previewMeshes).toHaveLength(0);
    await tool.settled;
    expect(body().props.volume).toBeCloseTo(1.25, 6);
  });

  it('Ctrl toggles newBody mode: the pulled region becomes a separate solid', async () => {
    const { registry, tools, root, bodies } = setup();
    const bodyId = addBox(registry);
    tools.activate('pushpull');
    const tool = tools.activeTool as PushPullTool;
    expect(tools.keyDown({ key: 'Control', code: 'ControlLeft', modifiers: { ...NO_MODIFIERS, ctrl: true }, repeat: false })).toBe(true);
    expect(tool.pushPullMode).toBe('newBody');
    const top = topFace(root().bodies.get(bodyId as never)!);
    tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(bodyId, top, [0.5, 0.5, 1]))));
    tools.pointerMove(pe([100, 50], -1, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    tools.pointerUp(pe([100, 50], 0, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    const volumes = bodies().map((b) => b.props.volume).sort((a, b) => a - b);
    expect(volumes[0]).toBeCloseTo(0.5, 6);
    expect(volumes[1]).toBeCloseTo(1, 6);
  });
});
