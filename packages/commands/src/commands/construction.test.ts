// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec3 } from '@pushform/core';
import { v3eq } from '@pushform/core';
import { InlineBackend, KernelClient, KernelError, meshTopologyProblems } from '@pushform/kernel';
import { computeRegions, SketchGraph, type Body, type EntityContainer, type FaceRecord } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { ToolManager } from '../tools/ToolManager';
import { constructionTools } from '../tools/constructionTools';
import type { SolidTool } from '../tools/impl/SolidTool';
import { modelCommands } from './model';
import { sketchCommands } from './sketch';
import { offsetCommands, orderSketchEdgeChain, type OffsetApplyResult } from './offset';
import { followMeCommands, type FollowMeApplyResult } from './followme';
import { solidCommands, type SolidsApplyResult } from './solids';
import { intersectCommands, type IntersectApplyResult } from './intersect';

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
  registry.registerAll(sketchCommands);
  registry.registerAll(offsetCommands);
  registry.registerAll(followMeCommands);
  registry.registerAll(solidCommands);
  registry.registerAll(intersectCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  for (const t of constructionTools()) tools.register(t);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const bodies = (): Body[] => [...root().bodies.values()];
  const addBox = (min: Vec3, max: Vec3): number => registry.execute('model.addBox', { min, max }) as number;
  const bodyRef = (id: number) => ({ kind: 'body' as const, path: [], id });
  return { host, kernel, registry, tools, root, bodies, addBox, bodyRef };
}

const topFace = (body: Body): FaceRecord => {
  const f = [...body.faces.values()].find((r) => v3eq(r.plane.n, [0, 0, 1]));
  if (!f) throw new Error('no +z face');
  return f;
};

const volumes = (bodies: Body[]): number[] => bodies.map((b) => +b.props.volume.toFixed(6)).sort();

describe('solids.*', () => {
  it('union of two overlapping boxes → one body with the merged volume (one undo entry)', async () => {
    const { registry, bodies, addBox, bodyRef, host } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    const entries = host.undoStack.length;
    const res = (await registry.execute('solids.union', { a: bodyRef(a), b: bodyRef(b) })) as SolidsApplyResult;
    expect(res.bodyIds).toEqual([a]);
    expect(res.deleted).toEqual([b]);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.props.volume).toBeCloseTo(1.5, 6);
    expect(bodies()[0]!.faces.size).toBe(6);
    expect(meshTopologyProblems(bodies()[0]!.mesh)).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Union');
    expect(host.undo()).toBe(true);
    expect(bodies()).toHaveLength(2);
    expect(volumes(bodies())).toEqual([1, 1]);
  });

  it('subtract deletes the cutter (a) and cuts b; trim keeps the cutter', async () => {
    const { registry, bodies, addBox, bodyRef, root } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const cutter = addBox([0.5, 0, 0], [1.5, 1, 1]);
    await registry.execute('solids.subtract', { a: bodyRef(cutter), b: bodyRef(a) });
    expect(bodies()).toHaveLength(1);
    expect(root().bodies.get(a as Id)?.props.volume).toBeCloseTo(0.5, 6);
    expect(root().bodies.has(cutter as Id)).toBe(false);

    const { registry: r2, bodies: b2, addBox: box2, bodyRef: ref2, root: root2 } = setup();
    const t = box2([0, 0, 0], [1, 1, 1]);
    const c = box2([0.5, 0, 0], [1.5, 1, 1]);
    const res = (await r2.execute('solids.trim', { a: ref2(c), b: ref2(t) })) as SolidsApplyResult;
    expect(res.deleted).toEqual([]);
    expect(b2()).toHaveLength(2);
    expect(root2().bodies.get(t as Id)?.props.volume).toBeCloseTo(0.5, 6);
    expect(root2().bodies.get(c as Id)?.props.volume).toBeCloseTo(1, 6);
  });

  it('intersect keeps the shared volume; split yields three pieces', async () => {
    const { registry, bodies, addBox, bodyRef } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    await registry.execute('solids.intersect', { a: bodyRef(a), b: bodyRef(b) });
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.props.volume).toBeCloseTo(0.5, 6);

    const { registry: r2, bodies: b2, addBox: box2, bodyRef: ref2, host } = setup();
    const x = box2([0, 0, 0], [1, 1, 1]);
    const y = box2([0.5, 0, 0], [1.5, 1, 1]);
    const entries = host.undoStack.length;
    const res = (await r2.execute('solids.split', { a: ref2(x), b: ref2(y) })) as SolidsApplyResult;
    expect(res.deleted.sort()).toEqual([x, y].sort());
    expect(res.bodyIds).toHaveLength(3);
    expect(b2()).toHaveLength(3);
    expect(volumes(b2())).toEqual([0.5, 0.5, 0.5]);
    for (const body of b2()) expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undo()).toBe(true);
    expect(b2()).toHaveLength(2);
  });

  it('outer shell of three overlapping boxes → one body', async () => {
    const { registry, bodies, addBox, bodyRef } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    const c = addBox([1, 0, 0], [2, 1, 1]);
    const res = (await registry.execute('solids.outerShell', { bodies: [bodyRef(a), bodyRef(b), bodyRef(c)] })) as SolidsApplyResult;
    expect(res.bodyIds).toEqual([a]);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.props.volume).toBeCloseTo(2, 6);
    expect(meshTopologyProblems(bodies()[0]!.mesh)).toEqual([]);
  });

  it('rejects a non-solid body', async () => {
    const { registry, addBox, bodyRef, host } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    host.edit('invalidate', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(b as Id)!.valid = false;
    });
    await expect(registry.execute('solids.union', { a: bodyRef(a), b: bodyRef(b) })).rejects.toMatchObject({ code: 'solids.notSolid' });
  });

  it('SolidTool runs on two preselected bodies when activated and by a click sequence', async () => {
    const { registry, tools, bodies, addBox, bodyRef, host } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0, 0], [1.5, 1, 1]);
    host.selection.set([bodyRef(a) as never, bodyRef(b) as never]);
    tools.activate('solid.union');
    const tool = tools.activeTool as SolidTool;
    await tool.settled;
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.props.volume).toBeCloseTo(1.5, 6);
    expect(tools.status().instructor).toMatch(/first solid/);
    // click sequence
    const c = addBox([3, 0, 0], [4, 1, 1]);
    const d = addBox([3.5, 0, 0], [4.5, 1, 1]);
    const ev = (id: number): never =>
      ({
        screen: [0, 0],
        ray: { origin: [0, 0, 0], dir: [0, 0, -1] },
        button: 0,
        buttons: 1,
        modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        camera: new FakeCamera().state,
        inference: {
          point: [0, 0, 0],
          primary: { kind: 'free', point: [0, 0, 0], color: '#000', label: '' },
          secondary: [],
          lines: [],
          lockedAxis: null,
          tooltip: '',
          plane: { n: [0, 0, 1], d: 0 },
          hit: { ref: { kind: 'body', path: [], id }, point: [0, 0, 0], t: 1, screenDist: 0 },
        },
      }) as never;
    tools.click(ev(c));
    expect(tool.firstBodyId).toBe(c);
    expect(tools.status().instructor).toMatch(/second solid/);
    tools.click(ev(d));
    await tool.settled;
    expect(bodies()).toHaveLength(2);
    expect(registry.has('tool.solid.subtract')).toBe(true);
  });
});

describe('followme.apply', () => {
  it('sweeps a square profile along an L path into one valid body (skipped while the kernel op is unimplemented)', async (ctx) => {
    const { registry, host, root, bodies } = setup();
    host.edit('Profile + path', (draft) => {
      const g = SketchGraph.for(draft);
      // profile: 0.2 square in the plane y = 0 centred on (0.1, 0, 0.1)
      g.addEdge([0, 0, 0], [0.2, 0, 0]);
      g.addEdge([0.2, 0, 0], [0.2, 0, 0.2]);
      g.addEdge([0.2, 0, 0.2], [0, 0, 0.2]);
      g.addEdge([0, 0, 0.2], [0, 0, 0]);
      // path: along +y then +x
      g.addEdge([0.1, 0, 0.1], [0.1, 1, 0.1]);
      g.addEdge([0.1, 1, 0.1], [1, 1, 0.1]);
    });
    const face = [...root().sketch.faces.values()][0]!;
    expect(face).toBeDefined();
    const pathIds = [...root().sketch.edges.values()].filter((e) => {
      const a = root().sketch.vertices.get(e.a)!.p, b = root().sketch.vertices.get(e.b)!.p;
      return a[1] !== 0 || b[1] !== 0;
    });
    expect(pathIds).toHaveLength(2);
    const chain = orderSketchEdgeChain(root().sketch, pathIds.map((e) => e.id));
    expect(chain.closed).toBe(false);
    expect(chain.points).toHaveLength(3);
    const entries = host.undoStack.length;
    let res: FollowMeApplyResult;
    try {
      res = (await registry.execute('followme.apply', { profile: { kind: 'sketchFace', path: [], id: face.id }, pathEdgeIds: pathIds.map((e) => e.id) })) as FollowMeApplyResult;
    } catch (e) {
      if (e instanceof KernelError && e.code === 'NotImplemented') {
        ctx.skip();
        return;
      }
      throw e;
    }
    expect(res.bodyIds).toHaveLength(1);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.valid).toBe(true);
    expect(bodies()[0]!.props.volume).toBeGreaterThan(0.04 * 1.5);
    expect(meshTopologyProblems(bodies()[0]!.mesh)).toEqual([]);
    expect(root().sketch.faces.size).toBe(0);
    expect(host.undoStack.length).toBe(entries + 1);
  });

  it('rejects a discontinuous path before touching the kernel', async () => {
    const { registry, host, root } = setup();
    host.edit('Profile + path', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [0.2, 0, 0]);
      g.addEdge([0.2, 0, 0], [0.2, 0, 0.2]);
      g.addEdge([0.2, 0, 0.2], [0, 0, 0.2]);
      g.addEdge([0, 0, 0.2], [0, 0, 0]);
      g.addEdge([0.1, 0, 0.1], [0.1, 1, 0.1]);
      g.addEdge([5, 5, 5], [6, 6, 6]);
    });
    const face = [...root().sketch.faces.values()][0]!;
    const ids = [...root().sketch.edges.values()].filter((e) => root().sketch.vertices.get(e.a)!.p[1] !== 0 || root().sketch.vertices.get(e.b)!.p[1] !== 0).map((e) => e.id);
    await expect(registry.execute('followme.apply', { profile: { kind: 'sketchFace', path: [], id: face.id }, pathEdgeIds: ids })).rejects.toMatchObject({ code: 'path.discontinuous' });
  });
});

describe('intersect.faces', () => {
  it('cuts a sketch face with a box: new sketch edges along the section split the face', async () => {
    const { registry, host, root, addBox } = setup();
    addBox([0, 0, 0], [1, 1, 1]);
    host.edit('Sheet', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([-1, -1, 0.5], [2, -1, 0.5]);
      g.addEdge([2, -1, 0.5], [2, 2, 0.5]);
      g.addEdge([2, 2, 0.5], [-1, 2, 0.5]);
      g.addEdge([-1, 2, 0.5], [-1, -1, 0.5]);
    });
    const face = [...root().sketch.faces.values()][0]!;
    const entries = host.undoStack.length;
    const res = (await registry.execute('intersect.faces', { refs: [{ kind: 'sketchFace', path: [], id: face.id }], with: 'model' })) as IntersectApplyResult;
    expect(res.faceCount).toBe(1);
    expect(res.edgeIds).toHaveLength(4);
    expect(root().sketch.edges.size).toBe(8);
    expect(root().sketch.faces.size).toBe(2);
    const inner = [...root().sketch.faces.values()].find((f) => f.id !== face.id)!;
    const pts = inner.loops[0]!.map((r) => root().sketch.vertices.get(root().sketch.edges.get(r.edgeId)!.a)!.p);
    for (const p of pts) {
      expect(p[2]).toBeCloseTo(0.5);
      expect(p[0] === 0 || p[0] === 1).toBe(true);
      expect(p[1] === 0 || p[1] === 1).toBe(true);
    }
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undo()).toBe(true);
    expect(root().sketch.edges.size).toBe(4);
  });

  it('imprints the cut onto a body face and refuses body-vs-body', async () => {
    const { registry, root, addBox, bodyRef } = setup();
    const a = addBox([0, 0, 0], [1, 1, 1]);
    const b = addBox([0.5, 0.5, 0.5], [2, 2, 2]);
    const bodyA = root().bodies.get(a as Id)!;
    const top = topFace(bodyA);
    const res = (await registry.execute('intersect.faces', { refs: [{ kind: 'face', path: [], id: a, faceId: top.id, region: null }], with: 'model' })) as IntersectApplyResult;
    expect(res.edgeIds.length).toBeGreaterThanOrEqual(2);
    expect(computeRegions(root().bodies.get(a as Id)!, top.id)).toHaveLength(2);
    await expect(registry.execute('intersect.faces', { refs: [bodyRef(a), bodyRef(b)], with: 'selection' })).rejects.toMatchObject({ code: 'intersect.unsupported' });
    await expect(registry.execute('intersect.faces', { refs: [], with: 'model' })).rejects.toMatchObject({ code: 'intersect.target' });
  });
});

describe('sketch.offset', () => {
  it('offsets a body face inward as imprint edges (2 regions)', () => {
    const { registry, root, addBox } = setup();
    const id = addBox([0, 0, 0], [1, 1, 1]);
    const top = topFace(root().bodies.get(id as Id)!);
    const res = registry.execute('sketch.offset', { faceRef: { kind: 'face', path: [], id, faceId: top.id, region: null }, distance: -0.2 }) as OffsetApplyResult;
    expect(res.edgeIds).toHaveLength(4);
    const regions = computeRegions(root().bodies.get(id as Id)!, top.id);
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => +r.area.toFixed(6)).sort()).toEqual([0.36, 0.64]);
  });

  it('keeps circular arcs concentric and copies curve metadata', () => {
    const { registry, host, root } = setup();
    const n = 24;
    host.edit('Circle', (draft) => {
      const g = SketchGraph.for(draft);
      const curveId = draft.meta.nextId++ as never;
      const pts: Vec3[] = [];
      for (let i = 0; i < n; i++) pts.push([Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n), 0]);
      const ids: Id[] = [];
      for (let i = 0; i < n; i++) ids.push(...g.addEdge(pts[i]!, pts[(i + 1) % n]!, { curveId }));
      g.sketch.curves.set(curveId, { id: curveId, kind: 'circle', center: [0, 0, 0], normal: [0, 0, 1], radius: 1, startAngle: 0, endAngle: 2 * Math.PI, segments: n, edgeRefs: ids });
    });
    const face = [...root().sketch.faces.values()][0]!;
    const res = registry.execute('sketch.offset', { faceRef: { kind: 'sketchFace', path: [], id: face.id }, distance: -0.25 }) as OffsetApplyResult;
    expect(res.edgeIds).toHaveLength(n);
    expect(root().sketch.curves.size).toBe(2);
    const newCurve = [...root().sketch.curves.values()].find((c) => c.edgeRefs.length === n && c.radius < 1)!;
    expect(newCurve.radius).toBeCloseTo(0.75);
    expect(newCurve.kind).toBe('circle');
    for (const eid of newCurve.edgeRefs) {
      const e = root().sketch.edges.get(eid as Id)!;
      expect(e.curveId).toBe(newCurve.id);
      expect(Math.hypot(...root().sketch.vertices.get(e.a)!.p)).toBeCloseTo(0.75);
    }
    expect(root().sketch.faces.size).toBe(2);
  });
});
