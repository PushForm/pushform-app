// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Id, Vec3 } from '@pushform/core';
import { m4transformDir, m4transformPoint } from '@pushform/core';
import { freeInference, GROUND_PLANE, type PickHit } from '@pushform/inference';
import { instanceAt, type EntityRef } from '@pushform/model';
import { ToolManager } from '../ToolManager';
import { NO_MODIFIERS, type ToolPointerEvent } from '../Tool';
import { transformTools } from '../transformTools';
import { disposeKernels, installPolyMeshStub, setupCommands, TOP_CAMERA } from '../../commands/transform.fixtures';
import { groupCommands, type MakeResult } from '../../commands/groups';
import { componentBehaviorCommands } from '../../commands/componentBehaviors';
import type { MoveTool } from './Move';

beforeAll(installPolyMeshStub);
afterEach(disposeKernels);

function setup() {
  const s = setupCommands(TOP_CAMERA);
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(componentBehaviorCommands);
  const tools = new ToolManager(s.registry, s.camera);
  s.registry.ctx.tools = tools;
  for (const t of transformTools()) tools.register(t);
  const component = (glueTo: string, min: Vec3, max: Vec3): EntityRef => {
    const box = s.registry.execute('model.addBox', { min, max }) as number;
    s.registry.execute('selection.set', { refs: [{ kind: 'body', path: [], id: box }] });
    const made = s.registry.execute('component.make', { glueTo }) as MakeResult;
    return { kind: 'instance', path: [], id: made.instanceId as Id };
  };
  return { ...s, tools, component };
}

/** Pointer event at world point `p`, looking straight down, with an optional face hit. */
const at = (p: Vec3, hit: PickHit | null = null, button = 0): ToolPointerEvent => ({
  // screen positions follow the point so a drag reads as one
  screen: [400 + p[0] * 50, 300 - p[1] * 50 - p[2] * 20],
  ray: { origin: [p[0], p[1], 10], dir: [0, 0, -1] },
  button,
  buttons: button === 0 ? 1 : 0,
  modifiers: NO_MODIFIERS,
  inference: freeInference(p, GROUND_PLANE, hit),
  camera: TOP_CAMERA,
});

describe('MoveTool with glue', () => {
  it('keeps a glued placement in its glue plane', async () => {
    const { host, tools, registry, component } = setup();
    const ref = component('horizontal', [0, 0, 0], [1, 1, 1]);
    registry.execute('component.placeOnFace', { ref, point: [0, 0, 0], normal: [0, 0, 1] });
    host.selection.set([ref]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    tools.pointerDown(at([0, 0, 0]));
    tools.pointerMove(at([2, 1, 3]));
    expect(tool.dragDelta).toEqual([2, 1, 0]);
    tools.pointerUp(at([2, 1, 3]));
    await tool.settled;
    const inst = instanceAt(host.doc.state, [ref.id])!;
    expect(m4transformPoint(inst.transform, [0, 0, 0])).toEqual([2, 1, 0]);
    expect(inst.gluedPlane!.n).toEqual([0, 0, 1]);
  });

  it('places a glue component on a wall face of the allowed orientation as the move commits', async () => {
    const { host, tools, registry, component } = setup();
    const ref = component('vertical', [0, 0, 0], [1, 0.1, 1]);
    const wallId = registry.execute('model.addBox', { min: [5, -5, 0], max: [5.2, 5, 3] }) as number;
    host.selection.set([ref]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    const body = host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!.entities.bodies.get(wallId as Id)!;
    const face = [...body.faces.values()].find((f) => f.plane.n[0] < -0.5)!;
    const hit: PickHit = { ref: { kind: 'face', path: [], id: wallId as Id, faceId: face.id, region: null }, point: [5, 1, 1.5], t: 1, normal: face.plane.n, screenDist: 0 };
    tools.pointerDown(at([0, 0, 0]));
    tools.pointerMove(at([5, 1, 1.5], hit));
    expect(tools.status().instructor).toContain('glue');
    tools.pointerUp(at([5, 1, 1.5], hit));
    await tool.settled;
    const inst = instanceAt(host.doc.state, [ref.id])!;
    expect(m4transformPoint(inst.transform, [0, 0, 0])).toEqual([5, 1, 1.5]);
    const blue = m4transformDir(inst.transform, [0, 0, 1]);
    expect(blue[0]).toBeCloseTo(-1, 9);
    expect(inst.gluedPlane!.n[0]).toBeCloseTo(-1, 9);
  });

  it('moves freely over a face whose orientation the component does not glue to', async () => {
    const { host, tools, component } = setup();
    const ref = component('vertical', [0, 0, 0], [1, 1, 1]);
    host.selection.set([ref]);
    tools.activate('move');
    const tool = tools.activeTool as MoveTool;
    const floor: PickHit = { ref: { kind: 'sketchFace', path: [], id: 1 as Id }, point: [3, 0, 0], t: 1, normal: [0, 0, 1], screenDist: 0 };
    tools.pointerDown(at([0, 0, 0]));
    tools.pointerMove(at([3, 0, 0], floor));
    expect(tools.status().instructor).not.toContain('glue');
    tools.pointerUp(at([3, 0, 0], floor));
    await tool.settled;
    const inst = instanceAt(host.doc.state, [ref.id])!;
    expect(m4transformPoint(inst.transform, [0, 0, 0])).toEqual([3, 0, 0]);
    expect(inst.gluedPlane).toBeUndefined();
  });
});
