// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import type { Body, FaceRecord } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { modelCommands } from './model';
import { pushPullCommands } from './pushpull';

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const k of kernels.splice(0)) k.dispose();
});

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const registry = new CommandRegistry({
    tx: host,
    camera: {} as never,
    services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]),
  });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(pushPullCommands);
  const id = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  const body = (): Body => host.doc.rootDefinition.entities.bodies.get(id as never)!;
  return { host, registry, id, body };
}

const top = (b: Body): FaceRecord => [...b.faces.values()].find((f) => f.plane.n[2] > 0.5)!;

describe('push/pull reuses the records of unchanged faces', () => {
  it('shares the geometry of a face the operation left alone, and undo restores the body', async () => {
    const { host, registry, id, body } = setup();
    const pull = (distance: number) => registry.execute('pushpull.apply', { target: { kind: 'face', path: [], id, faceId: top(body()).id, region: null }, distance, mode: 'merge' });
    await pull(0.5);
    const first = body();
    const bottom = [...first.faces.values()].find((f) => f.plane.n[2] < -0.5)!;

    await pull(0.5);
    const second = body();
    expect(second.faces.get(bottom.id)!.loops).toBe(bottom.loops);
    expect(second.faces.get(bottom.id)!.plane).toBe(bottom.plane);
    expect(meshTopologyProblems(second.mesh)).toEqual([]);

    expect(host.undo()).toBe(true);
    expect(body().faces).toBe(first.faces);
    expect(body().edges).toBe(first.edges);
    expect(body().version).toBe(first.version);
    expect(meshTopologyProblems(body().mesh)).toEqual([]);
    expect(host.redo()).toBe(true);
    expect(body().faces.get(bottom.id)!.loops).toBe(bottom.loops);
  });
});
