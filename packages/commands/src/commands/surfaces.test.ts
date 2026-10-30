// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, Vec3 } from '@pushform/core';
import { tessellateCircle } from '@pushform/geom';
import { freeInference, GROUND_PLANE } from '@pushform/inference';
import type { PickHit } from '@pushform/inference';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { surfaceFaceIds } from '@pushform/model';
import type { Body, EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { ToolManager } from '../tools/ToolManager';
import { NO_MODIFIERS } from '../tools/Tool';
import type { ToolPointerEvent } from '../tools/Tool';
import { SelectTool } from '../tools/impl/Select';
import { entityOverlay } from '../tools/toolUtil';
import { curveCommands, type AddCurveInput } from './curves';
import { materialCommands } from './materials';
import { modelCommands } from './model';
import { pushPullCommands } from './pushpull';
import { sketchCommands } from './sketch';
import { sketchSurfaceFaceIds, surfaceRefs } from './sketchQueries';

const CAMERA: CameraState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'parallel', orthoHeight: 6 };

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

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const k of kernels.splice(0)) k.dispose();
});

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const camera = new StubCamera();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, sketchCommands, curveCommands, pushPullCommands, materialCommands]) registry.registerAll(group);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  tools.register(new SelectTool());
  tools.activate('select');
  return { host, registry, tools };
}

/** A 24-sided cylinder pulled from a circle: one smooth side surface and two caps. */
async function cylinder(registry: CommandRegistry, host: DocumentHost): Promise<{ body: Body; sides: number[]; cap: number }> {
  const t = tessellateCircle([0, 0, 0], [0, 0, 1], 1, 24);
  registry.execute('sketch.addCurve', { points: t.points, closed: true, curve: t.curve } satisfies AddCurveInput);
  const face = [...host.doc.rootDefinition.entities.sketch.faces.values()][0]!;
  await registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 2, mode: 'merge' });
  const body = [...host.doc.rootDefinition.entities.bodies.values()][0]!;
  const surface = [...body.surfaces.values()][0]!;
  const cap = [...body.faces.keys()].find((id) => !surface.faceIds.includes(id))!;
  return { body, sides: [...surface.faceIds].sort((a, b) => a - b), cap };
}

const faceRef = (body: Body, faceId: number): EntityRef => ({ kind: 'face', path: [], id: body.id, faceId: faceId as never, region: null });

function click(ref: EntityRef): ToolPointerEvent {
  const hit: PickHit = { ref, point: [1, 0, 1], t: 10, screenDist: 0, inContext: true };
  return { screen: [400, 300], ray: { origin: [1, 0, 10], dir: [0, 0, -1] }, button: 0, buttons: 1, modifiers: NO_MODIFIERS, inference: freeInference([1, 0, 1], GROUND_PLANE, hit), camera: CAMERA };
}

describe('smooth surfaces act as one', () => {
  it('a face of the sides stands for all 24 of them; a cap stands for itself', async () => {
    const { registry, host } = setup();
    const { body, sides, cap } = await cylinder(registry, host);
    expect(surfaceFaceIds(body, sides[5]! as never)).toEqual(sides);
    expect(surfaceFaceIds(body, cap as never)).toEqual([cap]);
    expect(surfaceRefs(host.doc.state, faceRef(body, sides[0]!))).toHaveLength(24);
    expect(surfaceRefs(host.doc.state, faceRef(body, cap))).toEqual([faceRef(body, cap)]);
  });

  it('hardening the seams splits the surface back into single faces', async () => {
    const { registry, host } = setup();
    const { body, sides } = await cylinder(registry, host);
    host.doc.transact('harden all', (draft) => {
      const b = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(body.id)!;
      for (const e of b.edges.values()) e.soft = false;
    });
    const hard = host.doc.rootDefinition.entities.bodies.get(body.id)!;
    expect(surfaceFaceIds(hard, sides[0]! as never)).toEqual([sides[0]]);
  });

  it('clicking one side with Select selects the whole surface', async () => {
    const { registry, host, tools } = setup();
    const { body, sides, cap } = await cylinder(registry, host);
    tools.click(click(faceRef(body, sides[3]!)));
    expect(host.selection.refs.map((r) => (r as { faceId: number }).faceId).sort((a, b) => a - b)).toEqual(sides);
    tools.click(click(faceRef(body, cap)));
    expect(host.selection.refs).toEqual([faceRef(body, cap)]);
  });

  it('the hover highlight fills every side and outlines only the rims', async () => {
    const { registry, host } = setup();
    const { body, sides } = await cylinder(registry, host);
    const out = entityOverlay(host.doc.state, faceRef(body, sides[0]!), '#00f');
    expect(out.filter((p) => p.kind === 'polygon')).toHaveLength(24);
    // 24 segments on each rim, no seam between two sides
    expect(out.filter((p) => p.kind === 'polyline')).toHaveLength(48);
  });

  it('Paint Bucket on one side paints the whole surface and leaves the caps', async () => {
    const { registry, host } = setup();
    const { body, sides, cap } = await cylinder(registry, host);
    const material = registry.execute('material.create', { name: 'Red', color: [1, 0, 0], activate: false }) as number;
    registry.execute('paint.apply', { refs: [faceRef(body, sides[7]!)], materialId: material, mode: 'single', side: 'front' });
    const painted = host.doc.rootDefinition.entities.bodies.get(body.id)!;
    for (const id of sides) expect(painted.faces.get(id as never)?.frontMaterialId).toBe(material);
    expect(painted.faces.get(cap as never)?.frontMaterialId ?? null).toBeNull();
  });
});

describe('sketch surfaces', () => {
  it('sketch faces joined by soft edges act as one; hard edges separate them', () => {
    const { registry, host } = setup();
    // two squares sharing the edge x = 1
    registry.execute('sketch.addPolyline', { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], closed: true });
    registry.execute('sketch.addPolyline', { points: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]], closed: true });
    const sketch = () => host.doc.rootDefinition.entities.sketch;
    const faces = [...sketch().faces.keys()].sort((a, b) => a - b);
    expect(faces).toHaveLength(2);
    expect(sketchSurfaceFaceIds(sketch(), faces[0]!)).toEqual([faces[0]]);
    const shared = [...sketch().edges.values()].find((e) => {
      const a = sketch().vertices.get(e.a)!.p, b = sketch().vertices.get(e.b)!.p;
      return a[0] === 1 && b[0] === 1;
    })!;
    registry.execute('sketch.setEdgeFlags', { ids: [shared.id], soft: true });
    expect(sketchSurfaceFaceIds(sketch(), faces[0]!)).toEqual(faces);
    expect(surfaceRefs(host.doc.state, { kind: 'sketchFace', path: [], id: faces[1]! as Id })).toHaveLength(2);
  });
});
