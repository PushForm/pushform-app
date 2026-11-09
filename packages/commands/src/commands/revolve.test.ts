// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { m4translation, type DefId, type Box3, type Id, type Ray, type Vec3 } from '@pushform/core';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import { SketchGraph, type EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { RevolveTool } from '../tools/impl/Revolve';
import { NO_MODIFIERS, type ToolPointerEvent } from '../tools/Tool';
import { ToolManager } from '../tools/ToolManager';
import { modelCommands } from './model';
import { groupCommands, type MakeResult } from './groups';
import { contextCommands } from './context';
import { revolveCommands, runRevolveKernel, commitRevolve, type RevolveParams } from './revolve';
class FakeCamera implements CameraHost {
  state: CameraState = {
    eye: [10, -10, 10],
    target: [0, 0, 0],
    up: [0, 0, 1],
    fov: 35,
    projection: 'perspective',
    orthoHeight: 10,
  };
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

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const k of kernels.splice(0)) k.dispose();
});
function setup(min = 0, max = 1) {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const camera = new FakeCamera();
  const registry = new CommandRegistry({
    tx: host,
    camera,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_KERNEL, kernel],
    ]),
  });
  registry.registerAll(revolveCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(groupCommands);
  registry.registerAll(contextCommands);
  host.edit('Profile', (draft) => {
    const g = SketchGraph.for(draft);
    g.addEdge([min, 0, 0], [max, 0, 0]);
    g.addEdge([max, 0, 0], [max, 0, 2]);
    g.addEdge([max, 0, 2], [min, 0, 2]);
    g.addEdge([min, 0, 2], [min, 0, 0]);
  });
  const root = () => host.doc.rootDefinition.entities;
  const face = [...root().sketch.faces.values()][0]!;
  const params: RevolveParams = {
    profile: { kind: 'sketchFace', path: [], id: face.id },
    axisOrigin: [0, 0, 0],
    axisDir: [0, 0, 1],
    angleDeg: 360,
    segments: 48,
  };
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  const tool = new RevolveTool();
  tools.register(tool);
  tools.activate('revolve');
  const ref: EntityRef = { kind: 'sketchFace', path: [], id: face.id };
  return { host, kernel, registry, root, face, params, tools, tool, ref };
}
function at(point: Vec3, ref?: EntityRef): ToolPointerEvent {
  return {
    screen: [0, 0],
    ray: { origin: [0, -10, 0], dir: [0, 1, 0] },
    button: 0,
    buttons: 0,
    modifiers: NO_MODIFIERS,
    inference: {
      point,
      kind: 'free',
      hit: ref ? { ref, point, t: 1, screenDist: 0 } : null,
    } as unknown as ToolPointerEvent['inference'],
    camera: new FakeCamera().state,
  };
}
function chooseAxis(s: ReturnType<typeof setup>) {
  s.tools.click(at([0.5, 0, 1], s.ref));
  s.tools.click(at([0, 0, 0]));
  s.tools.click(at([0, 0, 2]));
}
describe('Revolve', () => {
  it('makes a cylinder touching the axis, consumes the profile, and undoes and redoes in one step', async () => {
    const s = setup();
    const entries = s.host.undoStack.length;
    await s.registry.execute('revolve.apply', s.params);
    const body = [...s.root().bodies.values()][0]!;
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(body.props.volume).toBeCloseTo(48 * Math.sin((2 * Math.PI) / 48), 5);
    expect(s.root().sketch.faces.size).toBe(0);
    expect(s.host.undoStack.length).toBe(entries + 1);
    expect(s.host.undoStack.peek()?.label).toBe('Revolve');
    s.host.undo();
    expect(s.root().bodies.size).toBe(0);
    expect(s.root().sketch.faces.has(s.face.id)).toBe(true);
    s.host.redo();
    expect(s.root().bodies.size).toBe(1);
    expect(s.root().sketch.faces.size).toBe(0);
  });
  it('makes a capped quarter ring from an offset profile', async () => {
    const s = setup(1, 2);
    await s.registry.execute('revolve.apply', { ...s.params, angleDeg: 90 });
    const body = [...s.root().bodies.values()][0]!;
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(body.props.volume).toBeCloseTo(12 * 3 * Math.sin((2 * Math.PI) / 48), 5);
  });
  it.each([
    { axisDir: [0, 0, 0] },
    { axisDir: [0, 1, 0] },
    { axisOrigin: [0, 1, 0] },
    { axisDir: [0, 0.1, 1] },
    { angleDeg: 0 },
    { angleDeg: 361 },
    { segments: 2 },
    { segments: 721 },
  ])('rejects invalid inputs without changing the document: %j', async (patch) => {
    const s = setup();
    const state = s.host.doc.state,
      entries = s.host.undoStack.length;
    await expect(async () =>
      s.registry.execute('revolve.apply', { ...s.params, ...patch }),
    ).rejects.toThrow();
    expect(s.host.doc.state).toBe(state);
    expect(s.host.undoStack.length).toBe(entries);
  });
  it('rejects a profile crossing the axis instead of clipping it', async () => {
    const s = setup(-1, 1);
    await expect(s.registry.execute('revolve.apply', s.params)).rejects.toThrow('one side');
    expect(s.root().bodies.size).toBe(0);
    expect(s.root().sketch.faces.size).toBe(1);
  });
  it('previews without editing and rejects a stale preview', async () => {
    const s = setup();
    const before = s.host.doc.state;
    const work = await runRevolveKernel(s.host, s.kernel, s.params);
    expect(s.host.doc.state).toBe(before);
    s.host.edit('Change', (draft) => {
      draft.meta.units.anglePrecision = 5;
    });
    expect(() => commitRevolve(s.host, work)).toThrow('model changed');
    expect(s.root().bodies.size).toBe(0);
  });
  it('uses world axis points inside a translated group', async () => {
    const s = setup();
    const group = s.registry.execute('group.make', { refs: [s.ref] }) as MakeResult;
    // Move the instance to make the world axis differ from the profile's local coordinates.
    s.host.edit('Translate', (draft) => {
      draft.definitions
        .get(draft.rootDefinitionId)!
        .entities.instances.get(group.instanceId as Id)!.transform = [
        ...m4translation([5, 0, 3]),
      ] as never;
    });
    s.registry.execute('context.enter', { path: [group.instanceId] });
    const path = [group.instanceId];
    const container = s.host.doc.state.definitions.get(group.definitionId as DefId)!.entities;
    const face = [...container.sketch.faces.values()][0]!;
    await s.registry.execute('revolve.apply', {
      ...s.params,
      profile: { kind: 'sketchFace', path, id: face.id },
      axisOrigin: [5, 0, 3],
    });
    expect(s.root().bodies.size).toBe(0);
    expect(
      s.host.doc.state.definitions.get(group.definitionId as DefId)!.entities.bodies.size,
    ).toBe(1);
  });
  it('previews, changes angle and segments, then applies through the tool', async () => {
    const s = setup();
    const before = s.host.doc.state;
    chooseAxis(s);
    await s.tool.settled;
    expect(s.tool.status().instructor).toContain('Check the preview');
    expect(s.tool.previewMeshes.length).toBeGreaterThan(0);
    expect(s.host.doc.state).toBe(before);
    s.tool.onVcb({ kind: 'angle', degrees: 90 });
    s.tool.onSetting('segments', { kind: 'segments', count: 24 });
    await s.tool.settled;
    s.tool.onSetting('apply', undefined);
    await s.tool.settled;
    expect(s.root().bodies.size).toBe(1);
    expect([...s.root().bodies.values()][0]!.props.volume).toBeCloseTo(
      6 * Math.sin(Math.PI / 12),
      5,
    );
    expect(s.tool.hasPendingWork()).toBe(false);
  });
  it('accepts a sketch edge as the axis', async () => {
    const s = setup();
    s.tools.click(at([0.5, 0, 1], s.ref));
    const edge = [...s.root().sketch.edges.values()].find(
      (e) =>
        s.root().sketch.vertices.get(e.a)!.p[0] === 0 &&
        s.root().sketch.vertices.get(e.b)!.p[0] === 0,
    )!;
    s.tools.click(at([0, 0, 1], { kind: 'sketchEdge', path: [], id: edge.id }));
    await s.tool.settled;
    expect(s.tool.status().instructor).toContain('Check the preview');
  });
  it('cancels an in-flight preview and never commits it', async () => {
    const s = setup();
    const before = s.host.doc.state;
    const spy = vi.spyOn(s.kernel, 'revolve');
    chooseAxis(s);
    s.tool.onCancel();
    await s.tool.settled;
    expect(s.tool.hasPendingWork()).toBe(false);
    expect(s.tool.overlay()).toEqual([]);
    expect(s.host.doc.state).toBe(before);
    expect(spy).not.toHaveBeenCalled();
  });
  it('discards an older in-flight result when the angle changes', async () => {
    const s = setup();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = s.kernel.revolve.bind(s.kernel);
    vi.spyOn(s.kernel, 'revolve').mockImplementationOnce(async (p) => {
      started();
      await gate;
      return original(p);
    });
    chooseAxis(s);
    await running;
    s.tool.onVcb({ kind: 'angle', degrees: 90 });
    release();
    await s.tool.settled;
    s.tool.onKeyDown({ key: 'Enter', code: 'Enter', modifiers: NO_MODIFIERS, repeat: false });
    await s.tool.settled;
    expect([...s.root().bodies.values()][0]!.props.volume).toBeCloseTo(
      12 * Math.sin(Math.PI / 24),
      5,
    );
  });
  it('rejects changed parameters for a precomputed result', async () => {
    const s = setup();
    const work = await runRevolveKernel(s.host, s.kernel, s.params);
    await expect(
      s.registry.execute('revolve.apply', { ...s.params, angleDeg: 90, precomputed: work }),
    ).rejects.toThrow('settings changed');
    expect(s.root().bodies.size).toBe(0);
  });
  it('reports kernel failures and keeps the profile', async () => {
    const s = setup();
    const state = s.host.doc.state;
    vi.spyOn(s.kernel, 'revolve').mockRejectedValueOnce(new Error('Invalid solid'));
    chooseAxis(s);
    await s.tool.settled;
    expect(s.tool.status().instructor).toBe('Invalid solid');
    expect(s.tool.previewMeshes).toEqual([]);
    expect(s.host.doc.state).toBe(state);
  });
  it('uses a solid face as a profile and preserves the source solid', async () => {
    const s = setup();
    const id = s.registry.execute('model.addBox', { min: [3, 0, 0], max: [4, 1, 2] }) as Id;
    const source = s.root().bodies.get(id)!;
    const face = [...source.faces.values()].find((f) => f.plane.n[2] > 0.9)!;
    await s.registry.execute('revolve.apply', {
      ...s.params,
      profile: { kind: 'face', path: [], id, faceId: face.id },
      axisOrigin: [3, 0, 2],
      axisDir: [1, 0, 0],
    });
    expect(s.root().bodies.size).toBe(2);
    expect(s.root().bodies.get(id)).toBe(source);
    for (const body of s.root().bodies.values())
      expect(meshTopologyProblems(body.mesh)).toEqual([]);
  });
  it('preserves holes in a profile as an enclosed cavity', async () => {
    const s = setup();
    s.host.edit('Hole', (draft) => {
      const g = SketchGraph.for(draft);
      const points: Vec3[] = [
        [0.2, 0, 0.5],
        [0.8, 0, 0.5],
        [0.8, 0, 1.5],
        [0.2, 0, 1.5],
      ];
      for (let i = 0; i < 4; i++) g.addEdge(points[i]!, points[(i + 1) % 4]!);
    });
    const ring = [...s.root().sketch.faces.values()].find((f) => f.loops.length === 2)!;
    expect(ring).toBeDefined();
    await s.registry.execute('revolve.apply', {
      ...s.params,
      profile: { kind: 'sketchFace', path: [], id: ring.id },
    });
    expect(s.root().bodies.size).toBe(1);
    const body = [...s.root().bodies.values()][0]!;
    expect(body.props.volume).toBeCloseTo(0.7 * 48 * Math.sin(Math.PI / 24), 5);
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
  });
});
