// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Box3, ImageId, MaterialId, PlaneBasis, Ray, Vec2, Vec3 } from '@pushform/core';
import { basisToLocal, v3eq } from '@pushform/core';
import { InlineBackend, KernelClient, KernelError, meshTopologyProblems } from '@pushform/kernel';
import { freeInference, GROUND_PLANE, InferenceEngineImpl, type InferenceResult, type PickHit } from '@pushform/inference';
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
import { planPushPull, PUSH_PULL_MESSAGES, pushPullCommands, runPushPullKernel, type PushPullApplyResult } from './pushpull';

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

const faceHit = (bodyId: number, face: FaceRecord, point: Vec3, normal: Vec3 = face.plane.n): PickHit => ({
  ref: { kind: 'face', path: [], id: bodyId as never, faceId: face.id, region: null },
  point,
  t: 1,
  normal,
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

describe('PushPullTool', () => {

  it('shows a loose face pulled either way as a positive distance and applies a typed one the way it is pulled', async () => {
    const { host, tools, root, bodies } = setup();
    host.edit('Rectangle', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([2, 0, 0], [2, 1, 0]);
      g.addEdge([2, 1, 0], [0, 1, 0]);
      g.addEdge([0, 1, 0], [0, 0, 0]);
    });
    const face = [...root().sketch.faces.values()][0]!;
    // A face drawn on the ground has its front facing down, so pulling up moves against its normal.
    expect(face.plane.n[2]).toBeCloseTo(-1, 9);
    const hit: PickHit = { ref: { kind: 'sketchFace', path: [], id: face.id }, point: [1, 0.5, 0], t: 1, normal: face.plane.n, screenDist: 0 };
    tools.activate('pushpull');
    const tool = tools.activeTool as PushPullTool;
    const shown = (): string => tools.status().fields![0]!.value;
    tools.pointerDown(pe([100, 100], 0, freeInference([1, 0.5, 0], GROUND_PLANE, hit)));
    // Up and down both read as a positive distance, whichever way the face's front points.
    tools.pointerMove(pe([100, 80], -1, freeInference([1, 0.5, 0.5], GROUND_PLANE)));
    expect(Math.abs(tool.dragDistance!)).toBeCloseTo(0.5, 9);
    expect(shown()).not.toMatch(/^-/);
    tools.pointerMove(pe([100, 120], -1, freeInference([1, 0.5, -0.25], GROUND_PLANE)));
    expect(shown()).not.toMatch(/^-/);
    // Pulled up again, a typed 2 makes a box 2 high above the ground, not below it.
    tools.pointerMove(pe([100, 80], -1, freeInference([1, 0.5, 0.5], GROUND_PLANE)));
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: 'm' });
    await tool.settled;
    await vi.waitFor(() => expect(bodies()).toHaveLength(1));
    const zs = () => { const v = bodies()[0]!.mesh.verts; const out: number[] = []; for (let i = 2; i < v.length; i += 3) out.push(v[i]!); return out; };
    expect(Math.min(...zs())).toBeCloseTo(0, 6);
    expect(Math.max(...zs())).toBeCloseTo(2, 6);
    expect(tools.status().vcbValue).not.toMatch(/^-/);
    // Re-editing keeps the direction.
    tools.onVcb({ kind: 'length', meters: 3, raw: 3, unit: 'm' });
    await tool.settled;
    await vi.waitFor(() => expect(Math.max(...zs())).toBeCloseTo(3, 6));
    expect(Math.min(...zs())).toBeCloseTo(0, 6);
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
    tools.keyDown({ key: 'Control', code: 'ControlLeft', modifiers: { ...NO_MODIFIERS, ctrl: true }, repeat: false });
    // a tap toggles: pressed and released with nothing between
    expect(tools.keyUp({ key: 'Control', code: 'ControlLeft', modifiers: { ...NO_MODIFIERS, ctrl: true }, repeat: false })).toBe(true);
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

describe('PushPullTool with real picking', () => {
  const EYE: Vec3 = [1.5, -0.5, 6];
  const rayTo = (p: Vec3): Ray => {
    const d: Vec3 = [p[0] - EYE[0], p[1] - EYE[1], p[2] - EYE[2]];
    const l = Math.hypot(...d);
    return { origin: EYE, dir: [d[0] / l, d[1] / l, d[2] / l] };
  };
  /** Parameter along `base + t·dir` (unit dir) closest to the ray. */
  const closestOnLine = (base: Vec3, dir: Vec3, ray: Ray): number => {
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const w0: Vec3 = [base[0] - ray.origin[0], base[1] - ray.origin[1], base[2] - ray.origin[2]];
    const b = dot(dir, ray.dir), d = dot(dir, w0), e = dot(ray.dir, w0);
    return (b * e - d) / (1 - b * b);
  };
  function picking(s: ReturnType<typeof setup>) {
    const engine = new InferenceEngineImpl();
    return (p: Vec3, button: number, screen: Vec2): ToolPointerEvent => {
      engine.setState(s.host.doc.state);
      const ray = rayTo(p);
      const inference = engine.resolve({ ray, screen, pixelSizeAt: () => 0.001 }, s.tools.activeTool?.inferenceOptions?.() ?? {});
      return { screen, ray, button, buttons: button === 0 ? 1 : 0, modifiers: NO_MODIFIERS, inference, camera: { eye: EYE, target: [0.5, 0.5, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 1 } };
    };
  }

  it('pushing in with the pointer over the pulled face follows the pointer, not the face behind it', async () => {
    const s = setup();
    const bodyId = addBox(s.registry);
    const ev = picking(s);
    s.tools.activate('pushpull');
    const tool = s.tools.activeTool as PushPullTool;
    s.tools.pointerDown(ev([0.5, 0.5, 1], 0, [400, 300]));
    expect(tool.dragDistance).toBe(0);
    // Still over the top face, a little toward the viewer: the ray goes on to the bottom face's back.
    const move = ev([0.52, 0.48, 1], -1, [400, 310]);
    expect(move.inference?.hit?.ref).toMatchObject({ kind: 'face', id: bodyId });
    s.tools.pointerMove(move);
    const expected = closestOnLine([0.5, 0.5, 1], [0, 0, 1], move.ray);
    expect(expected).toBeLessThan(0);
    expect(expected).toBeGreaterThan(-0.2);
    expect(tool.dragDistance).toBeCloseTo(expected, 9);
    s.tools.pointerUp(ev([0.52, 0.48, 1], 0, [400, 310]));
    await tool.settled;
    expect(s.root().bodies.get(bodyId as never)?.props.volume).toBeCloseTo(1 + expected, 6);
  });
});

describe('PushPullTool flow', () => {
  const typed = (m: number) => ({ kind: 'length' as const, meters: m, raw: m, unit: 'm' as const });
  const ESC = { key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false };
  const bodyOf = (s: ReturnType<typeof setup>, id: number): Body => s.root().bodies.get(id as never)!;
  const faceAlong = (body: Body, n: Vec3): FaceRecord => [...body.faces.values()].find((f) => v3eq(f.plane.n, n))!;
  /** Press on `face` at `from`, drag to the free point `to` and release. */
  const drag = (s: ReturnType<typeof setup>, bodyId: number, face: FaceRecord, from: Vec3, to: Vec3): void => {
    s.tools.pointerDown(pe([100, 100], 0, freeInference(from, GROUND_PLANE, faceHit(bodyId, face, from))));
    s.tools.pointerMove(pe([100, 60], -1, freeInference(to, GROUND_PLANE)));
    s.tools.pointerUp(pe([100, 60], 0, freeInference(to, GROUND_PLANE)));
  };
  const start = () => {
    const s = setup();
    const a = addBox(s.registry);
    const b = addBox(s.registry, [2, 0, 0], [3, 1, 2]);
    s.tools.activate('pushpull');
    return { ...s, a, b, tool: s.tools.activeTool as PushPullTool };
  };

  it('hovering a face is not an operation in progress; a pull under way is', () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    s.tools.pointerMove(pe([100, 100], -1, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    expect(s.tool.overlay().length).toBeGreaterThan(0);
    expect(s.tool.hasPendingWork()).toBe(false);
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    expect(s.tool.hasPendingWork()).toBe(true);
    s.tools.keyDown(ESC);
    expect(s.tool.hasPendingWork()).toBe(false);
  });

  it('with one face selected, the next press anywhere pulls that face', async () => {
    const s = setup();
    const a = addBox(s.registry);
    const top = topFace(bodyOf(s, a));
    s.host.selection.set([{ kind: 'face', path: [], id: a as never, faceId: top.id, region: null }]);
    s.tools.activate('pushpull');
    const tool = s.tools.activeTool as PushPullTool;
    expect(s.tools.status().instructor).toMatch(/selected face/);
    expect(tool.overlay().some((p) => p.kind === 'polygon')).toBe(true);
    // A press over empty space starts pulling the selected face.
    s.tools.pointerDown(pe([300, 300], 0, freeInference([5, 5, 0], GROUND_PLANE, null)));
    expect(tool.dragDistance).toBe(0);
    s.tools.pointerMove(pe([300, 250], -1, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    expect(tool.dragDistance).toBeCloseTo(0.5, 9);
    s.tools.pointerUp(pe([300, 250], 0, freeInference([0.5, 0.5, 1.5], GROUND_PLANE)));
    await tool.settled;
    expect(bodyOf(s, a).props.volume).toBeCloseTo(1.5, 6);
    // Only the next press: another press over empty space does nothing.
    s.tools.pointerDown(pe([300, 300], 0, freeInference([5, 5, 0], GROUND_PLANE, null)));
    expect(tool.dragDistance).toBeNull();
  });

  it('matches the height of faces within 30° of parallel, never the pulled face, and lets a point snap win', () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    const bTop = topFace(bodyOf(s, s.b));
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    const at = (point: Vec3, hit: PickHit | null, secondary: InferenceResult['secondary'] = []): number => {
      s.tools.pointerMove(pe([100, 80], -1, { ...freeInference(point, GROUND_PLANE, hit), secondary }));
      return s.tool.dragDistance!;
    };
    const tilted = (deg: number): Vec3 => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)];
    // A parallel face 1 m higher.
    expect(at([0.5, 0.5, 1.3], faceHit(s.b, bTop, [2.5, 0.5, 2]))).toBeCloseTo(1, 9);
    // 20° from parallel still matches: where the pull line crosses that plane.
    const n20 = tilted(20);
    expect(at([0.5, 0.5, 1.3], faceHit(s.b, bTop, [2.5, 0.5, 2], n20))).toBeCloseTo((n20[0] * 2 + n20[2]) / n20[2], 9);
    // 40° does not: the pointer is followed.
    expect(at([0.5, 0.5, 1.3], faceHit(s.b, bTop, [2.5, 0.5, 2], tilted(40)))).toBeCloseTo(0.3, 9);
    // The pulled face itself never sets the height.
    expect(at([0.5, 0.5, 0.8], faceHit(s.a, top, [0.5, 0.5, 1]))).toBeCloseTo(-0.2, 9);
    // A point snap on the way wins over a matched height.
    const endpoint = { kind: 'endpoint' as const, point: [0.5, 0.5, 1.4] as Vec3, color: '#000', label: 'Endpoint' };
    expect(at([0.5, 0.5, 1.4], faceHit(s.b, bTop, [2.5, 0.5, 2]), [endpoint])).toBeCloseTo(0.4, 9);
    s.tools.keyDown(ESC);
  });

  it('a distance typed after pushing in redoes it inward, as one undo step', async () => {
    const s = start();
    const entries = s.host.undoStack.length;
    drag(s, s.a, topFace(bodyOf(s, s.a)), [0.5, 0.5, 1], [0.5, 0.5, 0.75]);
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(0.75, 6);
    s.tools.onVcb(typed(0.5));
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(0.5, 6);
    expect(s.host.undoStack.length).toBe(entries + 1);
    expect(s.tools.status().vcbValue).toMatch(/^-/);
  });

  it('a distance typed with nothing in progress pulls the hovered face, or asks to point to one', async () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    s.tools.pointerMove(pe([100, 100], -1, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    s.tools.onVcb(typed(0.5));
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1.5, 6);
    s.tools.keyDown(ESC); // ends the chance to redo
    const entries = s.host.undoStack.length;
    s.tools.pointerMove(pe([500, 500], -1, freeInference([9, 9, 0], GROUND_PLANE, null)));
    s.tools.onVcb(typed(0.5));
    await s.tool.settled;
    expect(s.tools.status().instructor).toBe('Point to a face, then type the distance.');
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1.5, 6);
    expect(s.host.undoStack.length).toBe(entries);
  });

  it('a typed redo checks the pull is still the last change; a skipped one keeps the shown and double-click distances', async () => {
    const s = start();
    drag(s, s.a, topFace(bodyOf(s, s.a)), [0.5, 0.5, 1], [0.5, 0.5, 1.5]);
    await s.tool.settled;
    const shown = s.tools.status().vcbValue;
    // Another Push/Pull, not made by the tool, is now the last change.
    await s.registry.execute('pushpull.apply', { target: { kind: 'face', path: [], id: s.b, faceId: topFace(bodyOf(s, s.b)).id, region: null }, distance: 0.25, mode: 'merge' });
    s.tools.pointerMove(pe([500, 500], -1, freeInference([9, 9, 0], GROUND_PLANE, null)));
    s.tools.onVcb(typed(2));
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1.5, 6);
    expect(bodyOf(s, s.b).props.volume).toBeCloseTo(2.25, 6);
    expect(s.tools.status().vcbValue).toBe(shown);
    // Double-click still repeats 0.5.
    const bTop = topFace(bodyOf(s, s.b));
    s.tools.doubleClick(pe([200, 100], 0, freeInference([2.5, 0.5, 2.25], GROUND_PLANE, faceHit(s.b, bTop, [2.5, 0.5, 2.25]))));
    await s.tool.settled;
    expect(bodyOf(s, s.b).props.volume).toBeCloseTo(2.75, 6);
  });

  it('double-click repeats the last pull out or push in along each face\'s front, and does nothing before any pull', async () => {
    const s = start();
    const bTop = (): FaceRecord => topFace(bodyOf(s, s.b));
    s.tools.doubleClick(pe([200, 100], 0, freeInference([2.5, 0.5, 2], GROUND_PLANE, faceHit(s.b, bTop(), [2.5, 0.5, 2]))));
    await s.tool.settled;
    expect(bodyOf(s, s.b).props.volume).toBeCloseTo(2, 6);
    drag(s, s.a, topFace(bodyOf(s, s.a)), [0.5, 0.5, 1], [0.5, 0.5, 0.75]);
    await s.tool.settled;
    s.tools.doubleClick(pe([200, 100], 0, freeInference([2.5, 0.5, 2], GROUND_PLANE, faceHit(s.b, bTop(), [2.5, 0.5, 2]))));
    await s.tool.settled;
    expect(bodyOf(s, s.b).props.volume).toBeCloseTo(1.75, 6);
    // A face pointing another way is pushed in along its own front.
    const side = faceAlong(bodyOf(s, s.b), [1, 0, 0]);
    s.tools.doubleClick(pe([200, 100], 0, freeInference([3, 0.5, 1], GROUND_PLANE, faceHit(s.b, side, [3, 0.5, 1]))));
    await s.tool.settled;
    expect(bodyOf(s, s.b).props.volume).toBeCloseTo(1.75 - 0.25 * 1.75, 6);
  });

  it('refuses to push a whole face to or past the opposite side, leaving the solid', async () => {
    const s = start();
    const entries = s.host.undoStack.length;
    drag(s, s.a, topFace(bodyOf(s, s.a)), [0.5, 0.5, 1], [0.5, 0.5, 0]);
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1, 6);
    expect(s.tools.status().instructor).toBe(PUSH_PULL_MESSAGES.nothingLeft);
    expect(s.host.undoStack.length).toBe(entries);
    const top = topFace(bodyOf(s, s.a));
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    s.tools.onVcb(typed(-1.5));
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1, 6);
    await expect(apply(s.registry, { target: { kind: 'face', path: [], id: s.a, faceId: top.id, region: null }, distance: -1, mode: 'merge' })).rejects.toThrow(PUSH_PULL_MESSAGES.nothingLeft);
    expect(s.host.undoStack.length).toBe(entries);
  });

  it('refuses a face of a smooth surface with a message that it works on flat faces', async () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    const side = faceAlong(bodyOf(s, s.a), [1, 0, 0]);
    s.host.edit('Soften', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(s.a as never)!;
      for (const e of body.edges.values()) if ((e.faceA === top.id && e.faceB === side.id) || (e.faceA === side.id && e.faceB === top.id)) e.soft = e.smooth = true;
    });
    const hit = faceHit(s.a, top, [0.5, 0.5, 1]);
    s.tools.pointerMove(pe([100, 100], -1, freeInference([0.5, 0.5, 1], GROUND_PLANE, hit)));
    expect(s.tool.overlay()).toEqual([]);
    expect(s.tools.status().instructor).toMatch(/flat faces/);
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, hit)));
    expect(s.tool.dragDistance).toBeNull();
    expect(s.tools.status().instructor).toMatch(/flat faces/);
    await expect(apply(s.registry, { target: { kind: 'face', path: [], id: s.a, faceId: top.id, region: null }, distance: 1, mode: 'merge' })).rejects.toThrow(/flat faces/);
  });

  it('New body is off each time the tool is chosen', () => {
    const s = start();
    s.tools.register({ id: 'other', title: 'Other', activate() {}, deactivate() {}, onCancel() {}, overlay: () => [], status: () => ({ instructor: '', vcbLabel: '' }) });
    s.tools.setting('newBody', true);
    expect(s.tool.pushPullMode).toBe('newBody');
    s.tools.activate('other');
    s.tools.activate('pushpull');
    expect(s.tool.pushPullMode).toBe('merge');
    expect(s.tools.status().settings?.[0]).toMatchObject({ id: 'newBody', on: false });
  });

  it('switching New body during a pull previews the other mode', async () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    s.tools.pointerMove(pe([100, 60], -1, freeInference([0.5, 0.5, 1.25], GROUND_PLANE)));
    await vi.waitFor(() => expect(s.tool.previewReplacesBodyId).toBe(s.a), { timeout: 3000 });
    s.tools.setting('newBody', true);
    await vi.waitFor(() => expect(s.tool.previewMeshes).toHaveLength(1), { timeout: 3000 });
    expect(s.tool.previewReplacesBodyId).toBeNull();
    s.tools.keyDown(ESC);
  });

  it('switching New body just after a pull redoes it in the other mode, as one undo step', async () => {
    const s = start();
    const entries = s.host.undoStack.length;
    drag(s, s.a, topFace(bodyOf(s, s.a)), [0.5, 0.5, 1], [0.5, 0.5, 1.5]);
    await s.tool.settled;
    expect(s.tools.status().applied).toBe(true);
    s.tools.setting('newBody', true);
    await s.tool.settled;
    const volumes = () => s.bodies().map((b) => b.props.volume).sort((x, y) => x - y);
    expect(volumes().map((v) => +v.toFixed(6))).toEqual([0.5, 1, 2]);
    expect(s.host.undoStack.length).toBe(entries + 1);
    expect(s.tools.status().applied).toBe(true);
    s.tools.setting('newBody', false);
    await s.tool.settled;
    expect(volumes().map((v) => +v.toFixed(6))).toEqual([1.5, 2]);
    expect(s.host.undoStack.length).toBe(entries + 1);
    s.host.undo();
    expect(volumes().map((v) => +v.toFixed(6))).toEqual([1, 2]);
  });

  it('applies the pull against the solid as it is when the pull ends, not a stale preview', async () => {
    const s = start();
    const top = topFace(bodyOf(s, s.a));
    s.tools.pointerDown(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    s.tools.pointerUp(pe([100, 100], 0, freeInference([0.5, 0.5, 1], GROUND_PLANE, faceHit(s.a, top, [0.5, 0.5, 1]))));
    s.tools.pointerMove(pe([100, 60], -1, freeInference([0.5, 0.5, 1.25], GROUND_PLANE)));
    await vi.waitFor(() => expect(s.tool.previewMeshes).toHaveLength(1), { timeout: 3000 });
    // The solid changes while the pull is under way.
    const bottom = faceAlong(bodyOf(s, s.a), [0, 0, -1]);
    await apply(s.registry, { target: { kind: 'face', path: [], id: s.a, faceId: bottom.id, region: null }, distance: 0.5, mode: 'merge' });
    s.tools.pointerDown(pe([100, 60], 0, freeInference([0.5, 0.5, 1.25], GROUND_PLANE)));
    await s.tool.settled;
    expect(bodyOf(s, s.a).props.volume).toBeCloseTo(1.75, 6);
  });
});

describe('pushpull.apply refusals and New body', () => {
  const addSheet = (host: DocumentHost): void => {
    host.edit('Rectangle', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([2, 0, 0], [2, 1, 0]);
      g.addEdge([2, 1, 0], [0, 1, 0]);
      g.addEdge([0, 1, 0], [0, 0, 0]);
    });
  };

  it('New body on a sheet face makes a solid and keeps the sheet face', async () => {
    const { host, registry, root, bodies } = setup();
    addSheet(host);
    const face = [...root().sketch.faces.values()][0]!;
    const res = await apply(registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: -1, mode: 'newBody' });
    expect(res.bodyIds).toHaveLength(1);
    expect(bodies()[0]!.props.volume).toBeCloseTo(2, 6);
    expect(root().sketch.faces.get(face.id)).toBeDefined();
    expect(root().sketch.edges.size).toBe(4);
  });

  it('says why in words, without internal ids, when the face is gone or the kernel fails', async () => {
    const { host, registry, root } = setup();
    const bodyId = addBox(registry);
    await expect(apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: 999, region: null }, distance: 1, mode: 'merge' })).rejects.toThrow(PUSH_PULL_MESSAGES.gone);
    await expect(apply(registry, { target: { kind: 'face', path: [], id: 999, faceId: 1, region: null }, distance: 1, mode: 'merge' })).rejects.toThrow(PUSH_PULL_MESSAGES.gone);
    addSheet(host);
    const face = [...root().sketch.faces.values()][0]!;
    const plan = planPushPull(host.doc.state, { kind: 'sketchFace', path: [], id: face.id }, 1, 'merge');
    const failing = { extrudeSketch: () => Promise.reject(new KernelError('InvalidInput', 'pushPull region polygon has no area')) } as unknown as KernelClient;
    await expect(runPushPullKernel(failing, plan)).rejects.toThrow(PUSH_PULL_MESSAGES.noArea);
    const broken = { extrudeSketch: () => Promise.reject(new KernelError('ManifoldError', 'Face 3 not found on body 7')) } as unknown as KernelClient;
    await expect(runPushPullKernel(broken, plan)).rejects.toThrow(PUSH_PULL_MESSAGES.failed);
    for (const m of Object.values(PUSH_PULL_MESSAGES)) expect(m).not.toMatch(/\d/);
  });

  it('recomputes a precomputed result made for another version of the solid', async () => {
    const { registry, kernel, root, host } = setup();
    const bodyId = addBox(registry);
    const top = topFace(root().bodies.get(bodyId as never)!);
    const target = { kind: 'face' as const, path: [], id: bodyId, faceId: top.id, region: null };
    const stale = await runPushPullKernel(kernel, planPushPull(host.doc.state, target, 0.25, 'merge'), true);
    const bottom = [...root().bodies.get(bodyId as never)!.faces.values()].find((f) => v3eq(f.plane.n, [0, 0, -1]))!;
    await apply(registry, { target: { ...target, faceId: bottom.id }, distance: 0.5, mode: 'merge' });
    await apply(registry, { target, distance: 0.25, mode: 'merge', precomputed: stale, precomputedVersion: root().bodies.get(bodyId as never)!.version - 1 });
    expect(root().bodies.get(bodyId as never)!.props.volume).toBeCloseTo(1.75, 6);
  });
});
