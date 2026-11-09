// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Ray, Vec3 } from '@pushform/core';
import { planeDistance, v3dist, v3dot } from '@pushform/core';
import { tessellateCircle, tessellateArc } from '@pushform/geom';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import type { Body, EntityContainer } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { modelCommands } from './model';
import { pushPullCommands, type PushPullApplyResult } from './pushpull';
import { sketchCommands } from './sketch';
import { curveCommands, type AddCurveInput, type AddCurveResult } from './curves';

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
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const bodies = (): Body[] => [...root().bodies.values()];
  return { host, registry, root, bodies };
}

async function apply(registry: CommandRegistry, params: unknown): Promise<PushPullApplyResult> {
  return (await registry.execute('pushpull.apply', params)) as PushPullApplyResult;
}

function addCircle(registry: CommandRegistry, center: Vec3, radius: number, segments = 24): AddCurveResult {
  const t = tessellateCircle(center, [0, 0, 1], radius, segments);
  const input: AddCurveInput = { points: t.points, closed: true, curve: t.curve };
  return registry.execute('sketch.addCurve', input) as AddCurveResult;
}

/** Edges of a body between faces a and b. */
function edgesBetween(body: Body, a: number, b: number) {
  return [...body.edges.values()].filter((e) => (e.faceA === a && e.faceB === b) || (e.faceA === b && e.faceB === a));
}

describe('sketch.addCurve', () => {
  it('creates sketch edges with a curve id and a face; undo removes everything', () => {
    const { registry, root, host } = setup();
    const res = addCircle(registry, [0, 0, 0], 1);
    expect(res.routed).toBe('sketch');
    expect(res.edgeIds).toHaveLength(24);
    expect(root().sketch.faces.size).toBe(1);
    expect(root().sketch.curves.get(res.curveId as never)?.edgeRefs).toEqual(res.edgeIds);
    host.undo();
    expect(root().sketch.edges.size).toBe(0);
    expect(root().sketch.curves.size).toBe(0);
  });
});

describe('extruding curves', () => {
  it('a pulled circle becomes one Surface of 24 smooth sides and both caps carry the curve', async () => {
    const { registry, root, bodies } = setup();
    const res = addCircle(registry, [0, 0, 0], 1);
    const face = [...root().sketch.faces.values()][0]!;
    const out = await apply(registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 2, mode: 'merge' });
    expect(out.bodyIds).toHaveLength(1);
    const body = bodies()[0]!;
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(body.faces.size).toBe(26);
    expect(body.surfaces.size).toBe(1);
    const surface = [...body.surfaces.values()][0]!;
    expect(surface.faceIds).toHaveLength(24);
    for (const fid of surface.faceIds) expect(body.faces.get(fid)?.surfaceId).toBe(surface.id);
    // every pair of consecutive sides shares a soft+smooth edge (24 of them, the loop closes)
    let smoothSeams = 0;
    for (let i = 0; i < 24; i++) {
      const a = surface.faceIds[i]!, b = surface.faceIds[(i + 1) % 24]!;
      const seam = edgesBetween(body, a, b);
      expect(seam.length).toBeGreaterThan(0);
      for (const e of seam) {
        expect(e.soft).toBe(true);
        expect(e.smooth).toBe(true);
        smoothSeams++;
      }
    }
    expect(smoothSeams).toBe(24);
    // caps: one at the sketch face, one 2 m along the face normal, each with a copy of the curve
    expect(body.curves.size).toBe(2);
    const curves = [...body.curves.values()];
    const zTop = 2 * face.basis.n[2];
    const top = curves.find((c) => Math.abs(c.center[2] - zTop) < 1e-9)!;
    const bottom = curves.find((c) => Math.abs(c.center[2]) < 1e-9)!;
    expect(top).toMatchObject({ kind: 'circle', radius: 1, segments: 24 });
    expect(bottom).toMatchObject({ kind: 'circle', radius: 1, segments: 24 });
    expect(top.edgeRefs).toHaveLength(24);
    expect(bottom.edgeRefs).toHaveLength(24);
    for (const key of top.edgeRefs) {
      const e = body.edges.get(key as never)!;
      expect(e.curveId).toBe(top.id);
      for (const p of e.polyline) expect(p[2]).toBeCloseTo(zTop, 9);
    }
    expect(surface.curveId).toBe(top.id);
    expect(res.curveId).not.toBe(top.id);
    expect(root().sketch.curves.size).toBe(0);
  });

  it('an arc side of a face becomes a surface over the arc only; the straight sides stay hard', async () => {
    const { registry, root, bodies } = setup();
    // half-disc: arc from (1,0) over (0,1) to (-1,0) closed by a diameter
    const t = tessellateArc([0, 0, 0], [0, 0, 1], 1, 0, Math.PI, 12);
    const input: AddCurveInput = { points: t.points, closed: false, curve: t.curve };
    registry.execute('sketch.addCurve', input);
    registry.execute('sketch.addEdge', { a: [-1, 0, 0], b: [1, 0, 0] });
    expect(root().sketch.faces.size).toBe(1);
    const face = [...root().sketch.faces.values()][0]!;
    await apply(registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 1, mode: 'merge' });
    const body = bodies()[0]!;
    expect(meshTopologyProblems(body.mesh)).toEqual([]);
    expect(body.faces.size).toBe(12 + 1 + 2);
    expect(body.surfaces.size).toBe(1);
    const surface = [...body.surfaces.values()][0]!;
    expect(surface.faceIds).toHaveLength(12);
    const flat = [...body.faces.values()].find((f) => Math.abs(f.plane.n[1] + 1) < 1e-9)!;
    expect(flat.surfaceId).toBeNull();
    let smooth = 0, hard = 0;
    for (const e of body.edges.values()) {
      if (e.soft && e.smooth) smooth++;
      else hard++;
    }
    expect(smooth).toBe(11); // 12 arc sides share 11 seams; the seams to the flat side stay hard
    expect(hard).toBeGreaterThan(0);
    const arcCurves = [...body.curves.values()].filter((c) => c.kind === 'arc');
    expect(arcCurves).toHaveLength(2);
    for (const c of arcCurves) expect(c.edgeRefs).toHaveLength(12);
  });

  it('a circle imprinted on a box face and pushed through keeps the surface on the hole', async () => {
    const { registry, root, bodies } = setup();
    const bodyId = registry.execute('model.addBox', { min: [-2, -2, 0], max: [2, 2, 1] }) as number;
    const before = root().bodies.get(bodyId as never)!;
    const top = [...before.faces.values()].find((f) => f.plane.n[2] > 0.5)!;
    const res = addCircle(registry, [0, 0, 1], 0.5, 12);
    expect(res.routed).toBe('imprint');
    expect(res.faceId).toBe(top.id);
    const imprinted = root().bodies.get(bodyId as never)!;
    expect(imprinted.imprints.get(top.id)?.edges.size).toBe(12);
    expect(imprinted.curves.size).toBe(1);
    // the inner region is the circle; push it through the box
    const { computeRegions } = await import('@pushform/model');
    const regions = computeRegions(imprinted, top.id);
    const inner = regions.reduce((a, b) => (b.area < a.area ? b : a));
    await apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: top.id, region: inner.index }, distance: -1, mode: 'merge' });
    const after = bodies()[0]!;
    expect(meshTopologyProblems(after.mesh)).toEqual([]);
    expect(after.faces.size).toBe(6 + 12);
    expect(after.surfaces.size).toBe(1);
    const surface = [...after.surfaces.values()][0]!;
    expect(surface.faceIds).toHaveLength(12);
    let smooth = 0;
    for (const e of after.edges.values()) if (e.soft && e.smooth) smooth++;
    expect(smooth).toBe(12);
    // the hole's rims on the top and bottom faces carry the curve
    const rims = [...after.curves.values()];
    expect(rims.length).toBe(2);
    for (const c of rims) {
      expect(c.kind).toBe('circle');
      expect(c.edgeRefs).toHaveLength(12);
      expect(v3dist(c.center, [0, 0, c.center[2]])).toBeLessThan(1e-9);
    }
    expect(rims.map((c) => Math.round(c.center[2] * 1e6) / 1e6).sort()).toEqual([0, 1]);
  });
});

/** A circle of `segments` sides about `normal`. */
function addCircleAbout(registry: CommandRegistry, center: Vec3, normal: Vec3, radius: number, segments = 24): AddCurveResult {
  const t = tessellateCircle(center, normal, radius, segments);
  const input: AddCurveInput = { points: t.points, closed: true, curve: t.curve };
  return registry.execute('sketch.addCurve', input) as AddCurveResult;
}

/** The area of a regular polygon of `segments` sides inscribed in a circle of `radius`. */
const polygonArea = (radius: number, segments: number): number => 0.5 * segments * radius * radius * Math.sin((2 * Math.PI) / segments);

/**
 * A pulled circle as it should stay: its caps and sides, the sides one smooth surface joined by
 * soft, smooth seams, each side a plain quadrilateral, and on each rim a curve centred on its cap.
 */
function expectSmoothCylinder(body: Body, axis: Vec3, segments = 24): void {
  expect(meshTopologyProblems(body.mesh)).toEqual([]);
  expect(body.faces.size).toBe(segments + 2);
  expect(body.edges.size).toBe(segments * 3);
  expect(body.surfaces.size).toBe(1);
  const surface = [...body.surfaces.values()][0]!;
  expect(surface.faceIds).toHaveLength(segments);
  for (const fid of surface.faceIds) expect(body.faces.get(fid)!.loops.map((l) => l.length)).toEqual([4]);
  const sides = new Set(surface.faceIds);
  const seams = [...body.edges.values()].filter((e) => sides.has(e.faceA) && sides.has(e.faceB));
  expect(seams).toHaveLength(segments);
  for (const e of seams) expect([e.soft, e.smooth]).toEqual([true, true]);
  expect(body.curves.size).toBe(2);
  for (const c of body.curves.values()) {
    expect(c.edgeRefs).toHaveLength(segments);
    for (const key of c.edgeRefs) expect(body.edges.get(key as never)?.curveId).toBe(c.id);
    const cap = [...body.faces.values()].find((f) => Math.abs(v3dot(f.plane.n, axis)) > 0.99 && Math.abs(planeDistance(f.plane, c.center)) < 1e-6);
    expect(cap).toBeDefined();
  }
}

describe('pushing and pulling a pulled circle', () => {
  /** A cylinder of height 2 pulled from a circle of radius 1 about `axis`; returns it with its axis made unit. */
  async function cylinder(axis: Vec3 = [0, 0, 1]) {
    const s = setup();
    const len = Math.hypot(...axis);
    const n: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];
    addCircleAbout(s.registry, [0.3, -0.2, 0.1], n, 1);
    const face = [...s.root().sketch.faces.values()][0]!;
    await apply(s.registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 2 * Math.sign(v3dot(face.basis.n, n)), mode: 'merge' });
    const id = s.bodies()[0]!.id;
    const body = (): Body => s.root().bodies.get(id)!;
    const top = () => [...body().faces.values()].find((f) => v3dot(f.plane.n, n) > 0.99)!;
    return { ...s, n, id, body, top };
  }

  it('a New body pulled from the top of a cylinder has smooth sides and its rims carry the curve', async () => {
    const { registry, root, id, body, top } = await cylinder();
    const out = await apply(registry, { target: { kind: 'face', path: [], id, faceId: top().id }, distance: 1, mode: 'newBody' });
    expect(out.bodyIds).toHaveLength(1);
    const made = root().bodies.get(out.bodyIds[0]! as never)!;
    expectSmoothCylinder(made, [0, 0, 1]);
    expect(made.props.volume).toBeCloseTo(polygonArea(1, 24), 6);
    expectSmoothCylinder(body(), [0, 0, 1]);
  });

  for (const [name, axis] of [['upright', [0, 0, 1]], ['tilted', [1, 1, 1]]] as const) {
    it(`pulling the top of the ${name} cylinder up, pushing it down and pulling it again keeps the cylinder as it was drawn`, async () => {
      const { registry, id, n, body, top } = await cylinder([...axis]);
      let height = 2;
      for (const d of [1, -1, 1, -0.5, 1.5, -0.25, 0.75, -2.1, 0.37]) {
        await apply(registry, { target: { kind: 'face', path: [], id, faceId: top().id }, distance: d, mode: 'merge' });
        height += d;
        expectSmoothCylinder(body(), n);
        // the kernel keeps vertices in float32, so a tilted solid's volume is good to about 1e-7 of it
        expect(body().props.volume).toBeCloseTo(polygonArea(1, 24) * height, 5);
      }
    });
  }

  it('after the top is pushed down, a New body pulled from it is smooth too', async () => {
    const { registry, root, id, top } = await cylinder();
    await apply(registry, { target: { kind: 'face', path: [], id, faceId: top().id }, distance: -0.5, mode: 'merge' });
    const out = await apply(registry, { target: { kind: 'face', path: [], id, faceId: top().id }, distance: 1, mode: 'newBody' });
    expectSmoothCylinder(root().bodies.get(out.bodyIds[0]! as never)!, [0, 0, 1]);
  });

  it('the floor of a round pocket pushed to more than twice its depth keeps the pocket walls smooth', async () => {
    const { registry, root, bodies } = setup();
    const bodyId = registry.execute('model.addBox', { min: [-2, -2, 0], max: [2, 2, 1] }) as number;
    const top = [...root().bodies.get(bodyId as never)!.faces.values()].find((f) => f.plane.n[2] > 0.5)!;
    addCircle(registry, [0, 0, 1], 0.5, 12);
    const { computeRegions } = await import('@pushform/model');
    const inner = computeRegions(root().bodies.get(bodyId as never)!, top.id).reduce((a, b) => (b.area < a.area ? b : a));
    await apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: top.id, region: inner.index }, distance: -0.2, mode: 'merge' });
    const floor = [...bodies()[0]!.faces.values()].find((f) => f.plane.n[2] > 0.5 && Math.abs(planeDistance(f.plane, [0, 0, 0.8])) < 1e-6)!;
    await apply(registry, { target: { kind: 'face', path: [], id: bodyId, faceId: floor.id }, distance: -0.5, mode: 'merge' });
    const after = bodies()[0]!;
    expect(meshTopologyProblems(after.mesh)).toEqual([]);
    expect(after.props.volume).toBeCloseTo(16 - polygonArea(0.5, 12) * 0.7, 6);
    const surface = [...after.surfaces.values()][0]!;
    expect(surface.faceIds).toHaveLength(12);
    const walls = new Set(surface.faceIds);
    const seams = [...after.edges.values()].filter((e) => walls.has(e.faceA) && walls.has(e.faceB));
    expect(seams).toHaveLength(12);
    for (const e of seams) expect([e.soft, e.smooth]).toEqual([true, true]);
  });

  it('pulling a face into another part of the solid joins it there', async () => {
    const { registry, root, bodies } = setup();
    // A C profile: a lower arm (z 0–1) and an upper arm (z 3–4) reaching out to x = 3 from a back at x 0–1.
    const pts: Vec3[] = [[0, 0, 0], [3, 0, 0], [3, 0, 1], [1, 0, 1], [1, 0, 3], [3, 0, 3], [3, 0, 4], [0, 0, 4]];
    for (let i = 0; i < pts.length; i++) registry.execute('sketch.addEdge', { a: pts[i], b: pts[(i + 1) % pts.length] });
    const face = [...root().sketch.faces.values()][0]!;
    await apply(registry, { target: { kind: 'sketchFace', path: [], id: face.id }, distance: -Math.sign(face.basis.n[1]), mode: 'merge' });
    const id = bodies()[0]!.id;
    const armTop = (z: number) => [...root().bodies.get(id)!.faces.values()].find((f) => f.plane.n[2] > 0.99 && Math.abs(planeDistance(f.plane, [0, 0, z])) < 1e-6)!;
    // moved while it stays clear of the upper arm
    await apply(registry, { target: { kind: 'face', path: [], id, faceId: armTop(1).id }, distance: 1, mode: 'merge' });
    expect(bodies()[0]!.faces.size).toBe(10);
    expect(bodies()[0]!.props.volume).toBeCloseTo(10, 6);
    // pulled on through the gap and into the upper arm, it fills the gap: one block
    await apply(registry, { target: { kind: 'face', path: [], id, faceId: armTop(2).id }, distance: 1.5, mode: 'merge' });
    expect(bodies()).toHaveLength(1);
    expect(meshTopologyProblems(bodies()[0]!.mesh)).toEqual([]);
    expect(bodies()[0]!.faces.size).toBe(6);
    expect(bodies()[0]!.props.volume).toBeCloseTo(12, 6);
  });
});
