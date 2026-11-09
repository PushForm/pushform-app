// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, expect, it } from 'vitest';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { hardwareCommands } from './hardware';
const kernel = new KernelClient(new InlineBackend());
afterAll(() => kernel.dispose());
it('creates a reusable parameterized component in one undo step and restores it with redo', async () => {
  const host = new DocumentHost();
  const reg = new CommandRegistry({
    tx: host,
    services: new Map([
      [SERVICE_DOCUMENT, host],
      [SERVICE_KERNEL, kernel],
    ] as [string, unknown][]),
  });
  reg.registerAll(hardwareCommands);
  const before = host.doc.state.definitions.size;
  const r = (await reg.execute('hardware.create', {
    shape: 'bar-round',
    point: [0, 0, 0],
    spacing: 0.128,
    length: 0.15,
  })) as { definitionId: number };
  expect(host.doc.state.definitions.size).toBe(before + 1);
  const def = host.doc.state.definitions.get(r.definitionId as never)!;
  expect(def.entities.bodies.size).toBe(1);
  expect(JSON.parse(def.description).spacing).toBe(0.128);
  expect(host.undo()).toBe(true);
  expect(host.doc.state.definitions.size).toBe(before);
  expect(host.redo()).toBe(true);
  expect(host.doc.state.definitions.size).toBe(before + 1);
});
it('leaves the model unchanged after incompatible input', async () => {
  const host = new DocumentHost();
  const reg = new CommandRegistry({
    tx: host,
    services: new Map([
      [SERVICE_DOCUMENT, host],
      [SERVICE_KERNEL, kernel],
    ] as [string, unknown][]),
  });
  reg.registerAll(hardwareCommands);
  const before = host.doc.state;
  await expect(
    reg.execute('hardware.create', { shape: 'wire', length: 0.01, spacing: 0.2 }),
  ).rejects.toThrow();
  expect(host.doc.state).toBe(before);
  expect(host.canUndo()).toBe(false);
});
it('regenerates a definition in place, preserving placements and undo', async () => {
  const host = new DocumentHost();
  const reg = new CommandRegistry({
    tx: host,
    services: new Map([
      [SERVICE_DOCUMENT, host],
      [SERVICE_KERNEL, kernel],
    ] as [string, unknown][]),
  });
  reg.registerAll(hardwareCommands);
  const made = (await reg.execute('hardware.create', {
    shape: 'knob-disk',
    point: [1, 2, 3],
    finish: 'walnut',
  })) as { definitionId: number; instanceId: number };
  const root = host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!;
  const transform = root.entities.instances.get(made.instanceId as never)!.transform;
  await reg.execute('hardware.create', {
    shape: 'knob-disk',
    width: 0.04,
    finish: 'walnut',
    replaceDefinitionId: made.definitionId,
  });
  expect(
    host.doc.state.definitions.get(host.doc.state.rootDefinitionId)!.entities.instances.size,
  ).toBe(1);
  expect(
    host.doc.state.definitions
      .get(host.doc.state.rootDefinitionId)!
      .entities.instances.get(made.instanceId as never)!.transform,
  ).toEqual(transform);
  expect(
    JSON.parse(host.doc.state.definitions.get(made.definitionId as never)!.description).width,
  ).toBe(0.04);
  expect(host.undo()).toBe(true);
  expect(
    JSON.parse(host.doc.state.definitions.get(made.definitionId as never)!.description).width,
  ).toBe(0.032);
  expect(host.doc.state.images.size).toBeGreaterThan(0);
});
