// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Ray, Vec3 } from '@pushform/core';
import { v3dist } from '@pushform/core';
import { tessellateCircle } from '@pushform/geom';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import type { Body, EdgeKey, EdgeRecord, EntityContainer } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { modelCommands } from './model';
import { pushPullCommands } from './pushpull';
import { sketchCommands } from './sketch';
import { curveCommands, type AddCurveInput } from './curves';
import { solidCommands } from './solids';
import { blendEdgeGroup, edgeBlendCommands, type EdgeBlendApplyResult } from './edgeBlend';

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

export function setupEdgeBlend() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const services = new Map<string, unknown>([
    [SERVICE_DOCUMENT, host],
    [SERVICE_KERNEL, kernel],
  ]);
  const registry = new CommandRegistry({ tx: host, camera: new FakeCamera(), services });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(curveCommands);
  registry.registerAll(pushPullCommands);
  registry.registerAll(solidCommands);
  registry.registerAll(edgeBlendCommands);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const body = (id: number): Body => root().bodies.get(id as never)!;
  return { host, kernel, registry, root, body };
}

const addBox = (registry: CommandRegistry, min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]): number => registry.execute('model.addBox', { min, max }) as number;

/** The edge of `body` running between points a and b. */
function edgeAt(body: Body, a: Vec3, b: Vec3): EdgeRecord {
  const e = [...body.edges.values()].find((r) => {
    const p = r.polyline[0]!, q = r.polyline[r.polyline.length - 1]!;
    return (v3dist(p, a) < 1e-6 && v3dist(q, b) < 1e-6) || (v3dist(p, b) < 1e-6 && v3dist(q, a) < 1e-6);
  });
  if (!e) throw new Error(`no edge ${a} → ${b}`);
  return e;
}

const run = async (registry: CommandRegistry, kind: 'fillet' | 'chamfer', bodyId: number, edges: EdgeKey[], size: number, segments?: number): Promise<EdgeBlendApplyResult> =>
  (await registry.execute(`${kind}.apply`, { path: [], bodyId, edges, size, ...(segments ? { segments } : {}) })) as EdgeBlendApplyResult;

describe('fillet.apply / chamfer.apply', () => {
  it('chamfers one edge of a unit box: removes a 0.2 triangle prism in one undo step', async () => {
    const { host, registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const edge = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    const entries = host.undoStack.length;
    const res = await run(registry, 'chamfer', id, [edge.key], 0.2);
    const b = body(id);
    expect(b.props.volume).toBeCloseTo(1 - 0.02, 6);
    expect(b.faces.size).toBe(7);
    expect(res.faceIds).toHaveLength(1);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Chamfer');
    expect(host.undo()).toBe(true);
    expect(body(id).props.volume).toBeCloseTo(1, 9);
    expect(body(id).faces.size).toBe(6);
  });

  it('fillets one convex edge with a smooth surface of soft edges', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const edge = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    const r = 0.3;
    const res = await run(registry, 'fillet', id, [edge.key], r, 24);
    const b = body(id);
    // a quarter round of 6 facets: area removed = r² − (polygon of the arc)
    const facets = 6;
    const polygonArea = 0.5 * r * r * facets * Math.sin(Math.PI / 2 / facets);
    expect(b.props.volume).toBeCloseTo(1 - (r * r - polygonArea), 6);
    expect(res.faceIds).toHaveLength(facets);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    const fillet = new Set(res.faceIds);
    const inner = [...b.edges.values()].filter((e) => fillet.has(e.faceA) && fillet.has(e.faceB));
    expect(inner).toHaveLength(facets - 1);
    for (const e of inner) expect(e.soft && e.smooth).toBe(true);
    const sid = b.faces.get(res.faceIds[0]! as never)!.surfaceId;
    expect(sid).not.toBeNull();
    for (const f of res.faceIds) expect(b.faces.get(f as never)!.surfaceId).toBe(sid);
    // the tangent edges to the box faces stay hard
    expect([...b.edges.values()].filter((e) => fillet.has(e.faceA) !== fillet.has(e.faceB)).every((e) => !e.soft)).toBe(true);
  });

  it('fillets the four top edges of a box as one mitred chain', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const b0 = body(id);
    const keys = [
      edgeAt(b0, [0, 0, 1], [1, 0, 1]).key,
      edgeAt(b0, [1, 0, 1], [1, 1, 1]).key,
      edgeAt(b0, [1, 1, 1], [0, 1, 1]).key,
      edgeAt(b0, [0, 1, 1], [0, 0, 1]).key,
    ];
    const res = await run(registry, 'fillet', id, keys, 0.2);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeLessThan(1);
    expect(b.props.volume).toBeGreaterThan(1 - 4 * 0.2 * 0.2);
    expect(res.faceIds.length).toBe(24);
    // one surface for the whole chain
    expect(new Set(res.faceIds.map((f) => b.faces.get(f as never)!.surfaceId)).size).toBe(1);
  });

  it('fillets a cylinder cap circle picked as one curve', async () => {
    const { registry, root, body } = setupEdgeBlend();
    const t = tessellateCircle([0, 0, 0], [0, 0, 1], 1, 24);
    registry.execute('sketch.addCurve', { points: t.points, closed: true, curve: t.curve } satisfies AddCurveInput);
    const face = [...root().sketch.faces.values()][0]!;
    const sign = face.plane.n[2] > 0 ? 1 : -1;
    await registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: face.id }, distance: sign * 1, mode: 'merge' });
    const id = [...root().bodies.keys()][0]! as number;
    const cyl = body(id);
    const top = [...cyl.faces.values()].find((f) => f.plane.n[2] > 0.99)!;
    const capEdge = [...cyl.edges.values()].find((e) => (e.faceA === top.id || e.faceB === top.id) && e.curveId !== null)!;
    const group = blendEdgeGroup(cyl, capEdge.key);
    expect(group).toHaveLength(24);
    const before = cyl.props.volume;
    await run(registry, 'fillet', id, group, 0.1);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeLessThan(before);
    expect(b.props.volume).toBeGreaterThan(before - 2 * Math.PI * 0.1 * 0.1);
  });

  it('fills a concave edge (inside corner of an L) by adding material', async () => {
    const { registry, root, body } = setupEdgeBlend();
    const a = addBox(registry, [0, 0, 0], [2, 1, 1]);
    const w = addBox(registry, [0, 0, 1], [1, 1, 2]);
    await registry.execute('solids.union', { a: { kind: 'body', path: [], id: a }, b: { kind: 'body', path: [], id: w } });
    const id = [...root().bodies.keys()][0]! as number;
    const l = body(id);
    expect(l.props.volume).toBeCloseTo(3, 6);
    const inner = edgeAt(l, [1, 0, 1], [1, 1, 1]);
    await run(registry, 'chamfer', id, [inner.key], 0.25);
    expect(body(id).props.volume).toBeCloseTo(3 + 0.25 * 0.25 / 2, 6);
    expect(meshTopologyProblems(body(id).mesh)).toEqual([]);
    const edge2 = edgeAt(body(id), [0, 0, 2], [0, 1, 2]);
    await run(registry, 'fillet', id, [edge2.key], 0.2);
    expect(meshTopologyProblems(body(id).mesh)).toEqual([]);
  });

  it('refuses a radius that does not fit and leaves the model unchanged', async () => {
    const { host, registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const edge = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    const entries = host.undoStack.length;
    const version = body(id).version;
    await expect(run(registry, 'fillet', id, [edge.key], 1.5)).rejects.toThrow(/too large/);
    expect(body(id).version).toBe(version);
    expect(host.undoStack.length).toBe(entries);
  });

  it('refuses blends of opposite edges that would run into each other', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const b = body(id);
    const keys = [edgeAt(b, [0, 0, 1], [1, 0, 1]).key, edgeAt(b, [0, 1, 1], [1, 1, 1]).key];
    await expect(run(registry, 'chamfer', id, keys, 0.6)).rejects.toThrow(/run into each other/);
    await run(registry, 'chamfer', id, keys, 0.4);
    expect(body(id).props.volume).toBeCloseTo(1 - 2 * 0.08, 6);
  });

  it('refuses to fillet three picked edges meeting at a corner', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const b = body(id);
    const keys = [edgeAt(b, [1, 1, 1], [0, 1, 1]).key, edgeAt(b, [1, 1, 1], [1, 0, 1]).key, edgeAt(b, [1, 1, 1], [1, 1, 0]).key];
    await expect(run(registry, 'fillet', id, keys, 0.1)).rejects.toThrow(/three or more picked edges/);
  });

  // Three chamfers of distance d meeting at a right-angled corner overlap there by 3·d³/3 pairwise
  // and d³/4 all together, so the corner gives back 3·d³/3 − d³/4 = 0.75·d³ of the removed volume.
  it('chamfers three picked edges meeting at a corner, the bevels cutting into each other', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const b0 = body(id);
    const keys = [edgeAt(b0, [1, 1, 1], [0, 1, 1]).key, edgeAt(b0, [1, 1, 1], [1, 0, 1]).key, edgeAt(b0, [1, 1, 1], [1, 1, 0]).key];
    const d = 0.2;
    const res = await run(registry, 'chamfer', id, keys, d);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeCloseTo(1 - (3 * (d * d) / 2 - 0.75 * d ** 3), 6);
    expect(res.faceIds).toHaveLength(3);
    expect(b.faces.size).toBe(9);
  });

  it('chamfers all twelve edges of a box', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const keys = [...body(id).edges.keys()];
    expect(keys).toHaveLength(12);
    const d = 0.2;
    const res = await run(registry, 'chamfer', id, keys, d);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeCloseTo(1 - (12 * (d * d) / 2 - 8 * 0.75 * d ** 3), 6);
    expect(res.faceIds).toHaveLength(12);
    expect(b.faces.size).toBe(18);
  });

  it('chamfers a mitred chain that ends at a corner of three picked edges', async () => {
    const { registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const b0 = body(id);
    const keys = [
      edgeAt(b0, [0, 0, 1], [1, 0, 1]).key,
      edgeAt(b0, [1, 0, 1], [1, 1, 1]).key,
      edgeAt(b0, [1, 1, 1], [0, 1, 1]).key,
      edgeAt(b0, [0, 1, 1], [0, 0, 1]).key,
      edgeAt(b0, [0, 0, 1], [0, 0, 0]).key,
    ];
    const d = 0.2;
    await run(registry, 'chamfer', id, keys, d);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    // five edge strips, three mitred corners that overlap by d³/3 each and one three-edge corner
    expect(b.props.volume).toBeCloseTo(1 - (5 * (d * d) / 2 - 3 * (d ** 3 / 3) - 0.75 * d ** 3), 6);
  });

  it('chamfers the three inside edges of a notched corner by adding material', async () => {
    const { registry, root, body } = setupEdgeBlend();
    const a = addBox(registry, [0, 0, 0], [2, 2, 2]);
    const notch = addBox(registry, [1, 1, 1], [3, 3, 3]);
    await registry.execute('solids.subtract', { a: { kind: 'body', path: [], id: notch }, b: { kind: 'body', path: [], id: a } });
    const id = [...root().bodies.keys()][0]! as number;
    const b0 = body(id);
    expect(b0.props.volume).toBeCloseTo(7, 6);
    const keys = [edgeAt(b0, [1, 1, 1], [2, 1, 1]).key, edgeAt(b0, [1, 1, 1], [1, 2, 1]).key, edgeAt(b0, [1, 1, 1], [1, 1, 2]).key];
    const d = 0.2;
    await run(registry, 'chamfer', id, keys, d);
    const b = body(id);
    expect(meshTopologyProblems(b.mesh)).toEqual([]);
    expect(b.props.volume).toBeCloseTo(7 + 3 * (d * d) / 2 - 0.75 * d ** 3, 6);
  });

  it('refuses soft edges', async () => {
    const { host, registry, body } = setupEdgeBlend();
    const id = addBox(registry);
    const edge = edgeAt(body(id), [0, 0, 1], [1, 0, 1]);
    host.edit('Soften', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id as never)!.edges.get(edge.key)!.soft = true;
    });
    expect(blendEdgeGroup(body(id), edge.key)).toEqual([]);
    await expect(run(registry, 'fillet', id, [edge.key], 0.1)).rejects.toThrow(/hard edges/);
  });
});
